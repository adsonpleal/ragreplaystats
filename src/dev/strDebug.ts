// TEMP DEBUG HARNESS — DISCARDABLE. Renders one or more STR effects by file name
// on a neutral background so the output can be screenshotted and compared against
// the in-game client. Not imported by the app; loaded manually from the browser
// console / preview tooling in dev:
//
//   const m = await import('/src/dev/strDebug.ts');
//   await m.mount(['new_arrowstorm/new_arrowstorm_00/new_arrowstorm_00',
//                  'new_arrowstorm/new_arrowstorm_01/new_arrowstorm_01']);
//   __strdbg.setTime(500);          // drive the keyframe clock (ms)
//   __strdbg.snap();                // dataURL of the current frame
//   __strdbg.montage([100,300,...]) // labeled frame grid as a dataURL
//
// Delete this file once STR fidelity work is done.

import { Color, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from "three";
import { loadStrFile } from "../sim/render/effectAssets";
import { StrEffect } from "../sim/render/strEffect";

const SIZE = 512;

type Part = string | { file: string; delayMs?: number };

export async function mount(files: Part | Part[]): Promise<void> {
  const parts = (Array.isArray(files) ? files : [files]).map((p) =>
    typeof p === "string" ? { file: p, delayMs: 0 } : { delayMs: 0, ...p },
  );
  const list = parts.map((p) => p.file);

  document.getElementById("strdbg-canvas")?.remove();
  const canvas = document.createElement("canvas");
  canvas.id = "strdbg-canvas";
  canvas.width = SIZE;
  canvas.height = SIZE;
  canvas.style.cssText = "position:fixed;top:8px;left:8px;z-index:99999;border:1px solid #555;";
  document.body.appendChild(canvas);

  const renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(SIZE, SIZE, false);
  const scene = new Scene();
  scene.background = new Color(0x24262b); // neutral dark gray
  // Identity-orientation camera looking down -Z: the billboard faces it exactly.
  const camera = new PerspectiveCamera(45, 1, 0.1, 200);
  camera.position.set(0, 0, 30);
  camera.updateMatrixWorld();
  // STR content is authored above its (320,320) ground anchor — put the anchor
  // low in frame so the full composition is visible.
  const anchor = new Vector3(0, -9, 0);

  const strs = await Promise.all(list.map(loadStrFile));
  const effects = strs.map((s) => new StrEffect(scene, s));
  // Give the textures a beat to decode before first render.
  await new Promise((r) => setTimeout(r, 800));

  const setTime = (ms: number) => {
    // loop=true so we can scrub anywhere without the effect self-culling; each
    // part animates from its own staggered start (negative time = hidden).
    effects.forEach((e, i) => e.update(ms - (parts[i].delayMs ?? 0), camera, anchor, true));
    renderer.render(scene, camera);
  };
  const snap = (q = 0.8) => canvas.toDataURL("image/jpeg", q);
  const montage = (times: number[], cols = 3, cell = 256, q = 0.75) => {
    const rows = Math.ceil(times.length / cols);
    const out = document.createElement("canvas");
    out.width = cols * cell;
    out.height = rows * cell;
    const ctx = out.getContext("2d")!;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, out.width, out.height);
    times.forEach((t, i) => {
      setTime(t);
      const x = (i % cols) * cell;
      const y = Math.floor(i / cols) * cell;
      ctx.drawImage(canvas, x, y, cell, cell);
      ctx.fillStyle = "#fff";
      ctx.font = "14px monospace";
      ctx.fillText(`${t}ms`, x + 6, y + 18);
    });
    return out.toDataURL("image/jpeg", q);
  };

  (window as unknown as { __strdbg?: unknown }).__strdbg = {
    setTime,
    snap,
    montage,
    info: strs.map((s) => ({ fps: s.fps, maxKey: s.maxKey, durationMs: (s.maxKey / (s.fps || 60)) * 1000 })),
  };
}
