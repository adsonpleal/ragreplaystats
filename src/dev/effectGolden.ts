// GOLDEN-TEST HARNESS for skill/world effects (STR + CYLINDER). Renders effects
// in isolation on a neutral, deterministic stage — a checkerboard ground (so
// scale/placement read clearly) under a fixed RO-style 3/4 camera on a dark
// background (so faint additive effects like Basílica's alpha_down dome are
// visible). Each (effectIds, time) yields a stable image that can be eyeballed
// against the game client or diffed against a stored golden.
//
// Not shipped — dev/test only. Drive it from the preview console / tooling:
//
//   const g = await import('/src/dev/effectGolden.ts');
//   await g.mount(374);                  // one effect (or [id,id,…] composited)
//   __golden.frame(800);                 // dataURL of one frame at t=800ms
//   __golden.montage([0,400,800,1600]);  // labeled time-grid dataURL
//   __golden.info;                       // resolved part kinds/params
//
//   await g.board();                     // grid of ALL renderable table skills →
//                                        // one labeled golden image (dataURL)
//   g.GOLDEN_CASES;                      // the skill→effect manifest under test
//
// Determinism: Math.random is replaced with a fixed-seed PRNG for the whole
// session so effects with angle-randoms / "%d" file variants resolve identically
// every run. cellSize is pinned to 1 (the map scene's value) so tile-unit
// cylinder sizes map to the same world units as production.

import {
  Color,
  DataTexture,
  DoubleSide,
  GridHelper,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  type Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  RepeatWrapping,
  RGBAFormat,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import { type LoadedPart, loadEffect } from "../sim/render/effectAssets";
import { StrEffect } from "../sim/render/strEffect";
import { CylinderEffect } from "../sim/render/cylinderEffect";
import { ThreeDEffect } from "../sim/render/threeDEffect";
import { SprAnimEffect } from "../sim/render/sprAnimEffect";
import { QuadHornEffect } from "../sim/render/quadHornEffect";

const SIZE = 512;
const CELL_SIZE = 1; // world units per tile — must match the map scene (cellSize=1)
const GROUND_TILES = 16;

/** One renderer over a loaded part; both share update(...)/dispose(). */
interface StageEffect {
  kind: "str" | "cylinder" | "threeD" | "sprAnim" | "quadHorn";
  update(elapsedMs: number, camera: PerspectiveCamera, anchor: Vector3, loop: boolean): boolean;
  dispose(): void;
}

// --- The manifest under test: every skill from the "AB - Celine" table --------
// (?r=wGzeHZtz5w), with the effect ids it resolves to and which ones actually
// render. `effects: []` documents a skill that draws nothing, with why.

/** A golden case: a skill and the effect ids it shows (main + hit + ground). */
export interface GoldenCase {
  skillId: number;
  name: string;
  /** Effect ids composited together on the stage; empty = renders nothing. */
  effects: number[];
  /** Frame times (ms) worth capturing — first is the board thumbnail time. */
  times: number[];
  /** Why it renders nothing / any caveat. */
  note?: string;
}

export const GOLDEN_CASES: GoldenCase[] = [
  { skillId: 66, name: "Impositio Manus", effects: [84], times: [300, 150, 500] },
  { skillId: 67, name: "Suffragium", effects: [88], times: [300, 150, 500] },
  { skillId: 74, name: "Magnificat", effects: [76], times: [400, 200, 700] },
  {
    skillId: 79,
    name: "Magnus Exorcismus",
    effects: [113, 152, 318], // main STR + hit STR (holyhit) + ground CYLINDER
    times: [500, 200, 900],
  },
  { skillId: 362, name: "Basílica", effects: [374], times: [800], note: "ground CYLINDER dome" },
  { skillId: 2040, name: "Adoramus", effects: [721], times: [400, 200, 700] },
  // --- Renders nothing (documented expectations) ------------------------------
  { skillId: 661, name: "Golpe Avassalador", effects: [], times: [], note: "409 = 3D + sound (no STR/CYLINDER)" },
  { skillId: 2046, name: "Oratio", effects: [], times: [], note: "755 has no effect-table row" },
  { skillId: 680, name: "Drenar SP", effects: [], times: [], note: "not in gateway skill-map" },
  { skillId: 759, name: "Olhar da Medusa", effects: [], times: [], note: "not in gateway skill-map" },
  { skillId: 760, name: "Sussurro de Morfeu", effects: [], times: [], note: "not in gateway skill-map" },
  { skillId: 2041, name: "Clementia", effects: [], times: [], note: "not in gateway skill-map" },
  { skillId: 2042, name: "Canto Candidus", effects: [], times: [], note: "not in gateway skill-map" },
  { skillId: 2045, name: "Praefatio", effects: [], times: [], note: "not in gateway skill-map" },
  { skillId: 2047, name: "Lauda Agnus", effects: [], times: [], note: "not in gateway skill-map" },
  { skillId: 2048, name: "Lauda Ramus", effects: [], times: [], note: "not in gateway skill-map" },
  { skillId: 2050, name: "Renovatio", effects: [], times: [], note: "not in gateway skill-map" },
];

/** Deterministic PRNG (mulberry32) installed over Math.random so golden frames
 *  are byte-stable across runs. Returns a restore fn. */
function seedRandom(seed: number): () => void {
  const original = Math.random;
  let a = seed >>> 0;
  Math.random = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => {
    Math.random = original;
  };
}

/** A 2-tone checkerboard ground texture (each square = one tile) for scale. */
function checkerTexture(): DataTexture {
  const n = GROUND_TILES;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4;
      const v = (x + y) % 2 === 0 ? 34 : 52; // subtle checker on a dark stage
      data[i] = v;
      data[i + 1] = v + 2;
      data[i + 2] = v + 6;
      data[i + 3] = 255;
    }
  }
  const tex = new DataTexture(data, n, n, RGBAFormat);
  tex.magFilter = tex.minFilter = NearestFilter;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** The reusable neutral stage: renderer + ground + fixed camera, plus a slot for
 *  the current effect set. Loading is async (loadEffect + texture decode) so
 *  `setEffects` awaits a decode beat before frames are stable. */
interface Stage {
  canvas: HTMLCanvasElement;
  setEffects(effectIds: number[]): Promise<LoadedPart[]>;
  frame(ms: number): void;
  dispose(): void;
}

async function createStage(seed = 1): Promise<Stage> {
  document.getElementById("golden-canvas")?.remove();
  const canvas = document.createElement("canvas");
  canvas.id = "golden-canvas";
  canvas.width = canvas.height = SIZE;
  canvas.style.cssText = "position:fixed;top:8px;left:8px;z-index:99999;border:1px solid #555;";
  document.body.appendChild(canvas);

  const renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(SIZE, SIZE, false);
  const scene = new Scene();
  scene.background = new Color(0x0f1013); // dark so additive glow is visible

  // Ground: a checkerboard plane on XZ (+Y up, matching the map's raw-scene space)
  // plus a grid overlay, centred on the anchor at the origin.
  const ground = new Mesh(
    new PlaneGeometry(GROUND_TILES * CELL_SIZE, GROUND_TILES * CELL_SIZE),
    new MeshBasicMaterial({ map: checkerTexture(), side: DoubleSide }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  const grid = new GridHelper(GROUND_TILES * CELL_SIZE, GROUND_TILES, 0x445566, 0x334455);
  grid.position.y = 0.01;
  scene.add(grid);

  // Fixed RO-style 3/4 view. Aimed above the anchor and pulled back so the frame
  // holds BOTH ground cylinders (rings/domes at y≈0) and tall billboard STR
  // effects — buffs are authored up to ~9 units above the ground anchor.
  const camera = new PerspectiveCamera(45, 1, 0.1, 500);
  const dist = 20;
  const pitch = (36 * Math.PI) / 180;
  const aimY = 4;
  camera.position.set(0, aimY + dist * Math.sin(pitch), dist * Math.cos(pitch));
  camera.up.set(0, 1, 0);
  camera.lookAt(0, aimY, 0);
  camera.updateMatrixWorld();

  const anchor = new Vector3(0, 0, 0);
  let effects: StageEffect[] = [];
  let delays: number[] = [];

  const setEffects = async (effectIds: number[]): Promise<LoadedPart[]> => {
    for (const e of effects) e.dispose();
    effects = [];
    delays = [];
    const restore = seedRandom(seed);
    const partsPerId = await Promise.all(effectIds.map((id) => loadEffect(id)));
    restore();
    const parts = partsPerId.flat();
    effects = parts.map((p) => {
      if (p.kind === "str")
        return Object.assign(new StrEffect(scene, p.str) as unknown as StageEffect, { kind: "str" as const });
      if (p.kind === "cylinder")
        return Object.assign(new CylinderEffect(scene, p.cyl, CELL_SIZE) as unknown as StageEffect, { kind: "cylinder" as const });
      if (p.kind === "threeD")
        return Object.assign(new ThreeDEffect(scene, p.three, CELL_SIZE) as unknown as StageEffect, { kind: "threeD" as const });
      if (p.kind === "sprAnim")
        return Object.assign(new SprAnimEffect(scene, p.spr, CELL_SIZE) as unknown as StageEffect, { kind: "sprAnim" as const });
      return Object.assign(new QuadHornEffect(scene, p.quad, CELL_SIZE) as unknown as StageEffect, { kind: "quadHorn" as const });
    });
    delays = parts.map((p) =>
      (p.kind === "str"
        ? p.str.startDelayMs
        : p.kind === "cylinder"
          ? p.cyl.startDelayMs
          : p.kind === "threeD"
            ? p.three.startDelayMs
            : p.kind === "sprAnim"
              ? p.spr.startDelayMs
              : p.quad.startDelayMs) ?? 0,
    );
    await new Promise((r) => setTimeout(r, 700)); // let textures decode
    return parts;
  };

  const frame = (ms: number): void => {
    // loop=true so scrubbing never self-culls; each part starts at its stagger.
    effects.forEach((e, i) => e.update(ms - delays[i], camera, anchor, true));
    renderer.render(scene, camera);
  };

  const dispose = (): void => {
    for (const e of effects) e.dispose();
    (scene.children.slice() as Object3D[]).forEach((c) => scene.remove(c));
    renderer.dispose();
    canvas.remove();
  };

  return { canvas, setEffects, frame, dispose };
}

/** Mount a single effect (or several composited) for interactive scrubbing via
 *  `window.__golden`. Returns the resolved parts. */
export async function mount(effectIds: number | number[], seed = 1): Promise<LoadedPart[]> {
  const ids = Array.isArray(effectIds) ? effectIds : [effectIds];
  const stage = await createStage(seed);
  const parts = await stage.setEffects(ids);

  const frame = (ms: number, q = 0.85): string => {
    stage.frame(ms);
    return stage.canvas.toDataURL("image/jpeg", q);
  };
  const montage = (times: number[], cols = 2, cell = 320, q = 0.82): string =>
    grid(
      times.map((t) => ({ label: `${ids.join("+")} · ${t}ms`, draw: () => stage.frame(t) })),
      stage.canvas,
      cols,
      cell,
      q,
    );

  (window as unknown as { __golden?: unknown }).__golden = {
    frame,
    montage,
    info: parts.map((p) => {
      if (p.kind === "str")
        return { kind: "str", fps: p.str.fps, maxKey: p.str.maxKey, layers: p.str.layers.length };
      if (p.kind === "cylinder")
        return {
          kind: "cylinder",
          texture: p.cyl.texture ? "loaded" : null,
          topSize: p.cyl.topSize,
          bottomSize: p.cyl.bottomSize,
          height: p.cyl.height,
          alphaMax: p.cyl.alphaMax,
          duration: p.cyl.duration,
        };
      if (p.kind === "threeD")
        return {
          kind: "threeD",
          texture: p.three.texture ? "loaded" : null,
          duration: p.three.duration,
          alphaMax: p.three.alphaMax,
          blendMode: p.three.blendMode,
        };
      if (p.kind === "sprAnim")
        return {
          kind: "sprAnim",
          frames: p.spr.frames.length,
          loop: p.spr.loop,
          head: p.spr.head,
        };
      return {
        kind: "quadHorn",
        texture: p.quad.texture ? "loaded" : null,
        height: p.quad.height,
        bottomSize: p.quad.bottomSize,
        animation: p.quad.animation,
      };
    }),
  };
  return parts;
}

/** Render every renderable case in GOLDEN_CASES to one labeled grid image — the
 *  golden board. Non-renderable cases are drawn as labeled "no effect" cells so
 *  the board documents the full table. Returns a PNG dataURL. */
export async function board(cols = 3, cell = 300): Promise<string> {
  const stage = await createStage();
  const rows = Math.ceil(GOLDEN_CASES.length / cols);
  const out = document.createElement("canvas");
  out.width = cols * cell;
  out.height = rows * cell;
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, out.width, out.height);

  for (let i = 0; i < GOLDEN_CASES.length; i++) {
    const c = GOLDEN_CASES[i];
    const x = (i % cols) * cell;
    const y = Math.floor(i / cols) * cell;
    if (c.effects.length) {
      await stage.setEffects(c.effects);
      stage.frame(c.times[0] ?? 300);
      ctx.drawImage(stage.canvas, x, y, cell, cell);
    } else {
      ctx.fillStyle = "#161a1f";
      ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2);
      ctx.fillStyle = "#8a94a0";
      ctx.font = "13px monospace";
      ctx.fillText("(renders nothing)", x + 10, y + cell / 2);
      ctx.fillText(c.note ?? "", x + 10, y + cell / 2 + 18);
    }
    // Label bar.
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(x, y, cell, 40);
    ctx.fillStyle = "#fff";
    ctx.font = "15px monospace";
    ctx.fillText(`${c.skillId} ${c.name}`, x + 8, y + 18);
    ctx.fillStyle = "#9fd0ff";
    ctx.font = "12px monospace";
    ctx.fillText(c.effects.length ? `effect ${c.effects.join(", ")}` : "—", x + 8, y + 34);
  }
  stage.dispose();
  return out.toDataURL("image/png");
}

/** Shared grid compositor for montage(). */
function grid(
  cells: { label: string; draw: () => void }[],
  src: HTMLCanvasElement,
  cols: number,
  cell: number,
  q: number,
): string {
  const rows = Math.ceil(cells.length / cols);
  const out = document.createElement("canvas");
  out.width = cols * cell;
  out.height = rows * cell;
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, out.width, out.height);
  cells.forEach((c, i) => {
    c.draw();
    const x = (i % cols) * cell;
    const y = Math.floor(i / cols) * cell;
    ctx.drawImage(src, x, y, cell, cell);
    ctx.fillStyle = "#fff";
    ctx.font = "16px monospace";
    ctx.fillText(c.label, x + 8, y + 22);
  });
  return out.toDataURL("image/jpeg", q);
}
