// Floating damage numbers modelled on roBrowser's Damage renderer
// (src/Renderer/Effects/Damage.js). Each hit spawns a short-lived camera-facing
// billboard at the target's ground point that arcs up-and-right, shrinks, and
// fades out over 1500ms (800ms for "miss"). Numbers are drawn into a per-Float
// canvas at spawn so colour, content and thickness are baked once.
//
// A pool reuses meshes + textures so the GC isn't churning a quad per hit; the
// pool is queried by "first free" each spawn so the render loop drops on the
// floor rather than blocking when a busy frame overshoots the pool size.
//
// Damage abbreviation: only collapse into "K" once the number reaches 1000K
// (i.e. ≥ 1_000_000); below that the full number is shown. Per user request —
// keeps mid-range hits readable as exact values and only shortens the huge ones.
//    < 1_000_000     →  full number  (5_254_→ shown; 999_999 → "999999")
//    ≥ 1_000_000     →  "NK"         (1_500_000 → "1500K", floor N/1000)

import {
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  type PerspectiveCamera,
  PlaneGeometry,
  type Scene,
  SRGBColorSpace,
  Vector3,
} from "three";
import { UNITS_PER_PX } from "../../sim/sprite";
import type { HitType } from "../../rrf/types";

/** Damage lifetime in ms — matches roBrowser's `obj.delay = 1500`. */
const LIFETIME_MS = 1500;
/** Miss/dodge lifetime — matches roBrowser's `perc = age/800` for MISS. */
const MISS_LIFETIME_MS = 800;
/** How many world units the whole animation covers along the sprite's local
 *  axes. Chosen to roughly match the perceived motion of the roBrowser damage
 *  arc after our scene's units. */
const HORIZONTAL_SPREAD = 4;
const ARC_HEIGHT = 5;
const BASE_LIFT = 2;

// Multi-hit skills, matching the RO client: each hit spawns its own white
// number that rises STRAIGHT UP the target's vertical line (staggered in time,
// so successive hits stack — older ones higher + smaller + fading), and a
// single yellow "combo" total that pins right above the monster and sums the
// hits. No horizontal fan — every number shares the same vertical path.
const HIT_STAGGER_MS = 110; // gap between successive hits of the same skill
const HIT_RISE_WORLD = 4; // how far a hit number climbs over its life
const COMBO_ABOVE_WORLD = 6.5; // yellow total's height above the target anchor…
const COMBO_LIFE_MS = 2300; // the yellow total lingers longer than a single hit
const COMBO_COLOR = "#e6e626"; // RO combo yellow rgb(0.9,0.9,0.15)

const TEXT_CANVAS_W = 128;
const TEXT_CANVAS_H = 48;

/** Damage → display string with the K/M collapse. Multi-hit count is appended
 *  as "×N" to preserve the info without breaking the abbreviation. */
const K_THRESHOLD = 1_000_000; // 1000K — only abbreviate at/above this

function formatDamage(n: number): string {
  if (n < K_THRESHOLD) return String(n);
  return `${Math.floor(n / 1_000)}K`;
}

type TextSpec = {
  text: string;
  color: string;
  outline: string;
  fontPx: number;
  lifeMs: number;
};

function specFor(hit: HitType, damage: number, fromPlayer: boolean): TextSpec {
  if (hit === "miss") {
    return { text: "miss", color: "#ffffff", outline: "#000", fontPx: 22, lifeMs: MISS_LIFETIME_MS };
  }
  const label = formatDamage(damage);
  if (hit === "critical") {
    return { text: label, color: COMBO_COLOR, outline: "#000", fontPx: 28, lifeMs: LIFETIME_MS };
  }
  // roBrowser: outgoing damage is white, damage TO a PC is red. In replays we
  // don't always know the target kind cheaply, so approximate with "did the
  // player deal it?" — white when yes, red otherwise.
  const color = fromPlayer ? "#ffffff" : "#ff4040";
  return { text: label, color, outline: "#000", fontPx: 26, lifeMs: LIFETIME_MS };
}

/** The yellow "combo" total shown after a multi-hit skill — the sum of all hits. */
function comboSpec(total: number): TextSpec {
  return { text: formatDamage(total), color: COMBO_COLOR, outline: "#000", fontPx: 30, lifeMs: COMBO_LIFE_MS };
}

/** Per-spawn placement options for a Float. */
type SpawnOpts = {
  /** Vertical tier for close-together separate hits (single-hit stacking). */
  stackLevel?: number;
  /** This float is one hit of a multi-hit skill — rises straight up the
   *  target's vertical line (no horizontal drift) so successive hits stack. */
  column?: boolean;
  /** This float is the yellow combo total — pins right above the monster. */
  combo?: boolean;
};

function drawText(canvas: HTMLCanvasElement, spec: TextSpec): void {
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Galmuri11 — same crisp pixel font the latamvisuais UI uses. Bitmap
  // glyphs match the client's damage.spr blocky look far better than any
  // TTF sans. Falls back to Impact/Arial Black if the woff2 hasn't loaded
  // yet (the very first hit on a fresh page can beat the font).
  ctx.font = `${spec.fontPx}px Galmuri11, Impact, "Arial Black", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // Thick outline first, fill on top — the client uses a heavy black outline so
  // the number stays readable over any ground colour.
  ctx.lineWidth = 6;
  ctx.lineJoin = "round";
  ctx.strokeStyle = spec.outline;
  ctx.strokeText(spec.text, canvas.width / 2, canvas.height / 2);
  ctx.fillStyle = spec.color;
  ctx.fillText(spec.text, canvas.width / 2, canvas.height / 2);
}

class Float {
  readonly mesh: Mesh;
  readonly canvas: HTMLCanvasElement;
  readonly texture: CanvasTexture;
  readonly anchor = new Vector3();
  bornAtMs = 0;
  lifeMs = LIFETIME_MS;
  liftOffsetWorld = 0; // extra rise when hits stack on the same target
  column = false; // multi-hit hit — rises straight up the target's vertical line
  combo = false; // the yellow total, pinned above the target
  active = false;
  private readonly worldW: number;
  private readonly worldH: number;
  private up = new Vector3();
  private right = new Vector3();
  private toCam = new Vector3();

  constructor(private readonly scene: Scene) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = TEXT_CANVAS_W;
    this.canvas.height = TEXT_CANVAS_H;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    // Bilinear filtering — Impact digits look chunkier and cleaner than the
    // nearest-neighbour shimmer at typical zoom levels.
    // (magFilter defaults to LinearFilter, so no explicit set needed.)
    this.worldW = TEXT_CANVAS_W * UNITS_PER_PX * 1.5;
    this.worldH = TEXT_CANVAS_H * UNITS_PER_PX * 1.5;
    const mat = new MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
      depthTest: false, // always on top, like roBrowser's damage numbers
    });
    this.mesh = new Mesh(new PlaneGeometry(this.worldW, this.worldH), mat);
    this.mesh.renderOrder = 100;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  /** `bornAtMs` may be in the future (staggered multi-hit) — the float stays
   *  hidden but reserved until the render clock reaches it. */
  spawn(at: Vector3, spec: TextSpec, bornAtMs: number, opts: SpawnOpts = {}): void {
    drawText(this.canvas, spec);
    this.texture.needsUpdate = true;
    this.anchor.copy(at);
    this.bornAtMs = bornAtMs;
    this.lifeMs = spec.lifeMs;
    this.liftOffsetWorld = (opts.stackLevel ?? 0) * 2.2;
    this.column = opts.column ?? false;
    this.combo = opts.combo ?? false;
    this.active = true;
    this.mesh.visible = false; // shown on the first update once bornAtMs passes
  }

  update(nowMs: number, camera: PerspectiveCamera): void {
    if (!this.active) return;
    const age = nowMs - this.bornAtMs;
    if (age < 0) {
      // Scheduled but not started yet (a later hit in a cascade).
      this.mesh.visible = false;
      return;
    }
    if (age >= this.lifeMs) {
      this.active = false;
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    // roBrowser's `perc`: age / delay. Normalised 0..1 over the lifetime.
    const perc = age / this.lifeMs;

    // Camera-facing billboard + local axes (shared by every motion mode).
    this.mesh.quaternion.copy(camera.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    this.right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    this.toCam.copy(camera.position).sub(this.anchor).normalize();

    // Combo total: pin it right above the monster (a fixed height above the
    // anchor) and hold full-size, then fade in the last 30% — a stable "sum"
    // sitting over the sprite, above the rising hit numbers.
    if (this.combo) {
      const alpha = perc < 0.7 ? 1 : Math.max(0, (1 - perc) / 0.3);
      (this.mesh.material as MeshBasicMaterial).opacity = alpha;
      this.mesh.scale.set(1.15, 1.15, 1);
      this.mesh.position
        .copy(this.anchor)
        .addScaledVector(this.up, COMBO_ABOVE_WORLD + perc * 0.6)
        .addScaledVector(this.toCam, 1);
      return;
    }

    // Multi-hit hit: rise STRAIGHT UP the target's vertical line (no horizontal
    // drift), shrinking + fading. Because the hits are staggered in time they
    // stack — the older one is higher/smaller/fainter, matching the client.
    if (this.column) {
      (this.mesh.material as MeshBasicMaterial).opacity = 1 - perc;
      const scale = Math.max(0.45, 1 - perc * 0.5);
      this.mesh.scale.set(scale, scale, 1);
      this.mesh.position
        .copy(this.anchor)
        .addScaledVector(this.up, BASE_LIFT + perc * HIT_RISE_WORLD)
        .addScaledVector(this.toCam, 1);
      return;
    }

    // Single hit (auto-attack / one-shot skill). Damage arc from Damage.js:
    //   posZ = base + 2 + sin(-π/2 + π*(0.5 + perc*1.5)) * 5   (lofts then dips)
    //   posX = base + perc*4                                   (slight drift right)
    // MISS just rises linearly, no drift.
    const isMiss = this.lifeMs === MISS_LIFETIME_MS;
    const alpha = 1 - perc;
    const scale = isMiss ? 0.6 : Math.max(0.35, 1 - perc * 0.65);
    (this.mesh.material as MeshBasicMaterial).opacity = alpha;
    this.mesh.scale.set(scale, scale, 1);
    const arc = Math.sin(-Math.PI / 2 + Math.PI * (0.5 + perc * 1.5)) * ARC_HEIGHT;
    const liftUp = isMiss ? BASE_LIFT + perc * 7 : BASE_LIFT + arc;
    this.mesh.position
      .copy(this.anchor)
      .addScaledVector(this.up, liftUp + this.liftOffsetWorld)
      .addScaledVector(this.right, isMiss ? 0 : perc * HORIZONTAL_SPREAD)
      .addScaledVector(this.toCam, isMiss ? 1 : 1 + perc * HORIZONTAL_SPREAD * 0.5);
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshBasicMaterial).dispose();
    this.texture.dispose();
  }
}

export class DamageTextLayer {
  private readonly pool: Float[] = [];
  private readonly POOL_SIZE = 96;
  /** Per-target stack: successive hits inside STACK_WINDOW_MS pop above the
   *  previous one so a multi-hit combo doesn't overlap into a blob. */
  private readonly stacks = new Map<number, { count: number; lastMs: number }>();

  constructor(scene: Scene) {
    for (let i = 0; i < this.POOL_SIZE; i++) this.pool.push(new Float(scene));
  }

  spawn(
    targetAid: number,
    targetPos: Vector3,
    damage: number,
    hit: HitType,
    fromPlayer: boolean,
    nowMs: number,
    count = 1,
  ): void {
    // Multi-hit skills (like the client): one number per hit, cascading and
    // staggered, then a yellow combo total that sums them. A miss is never a
    // multi-hit.
    if (count > 1 && hit !== "miss") {
      this.spawnMultiHit(targetPos, damage, hit, fromPlayer, nowMs, count);
      return;
    }
    const free = this.pool.find((f) => !f.active);
    if (!free) return;
    free.spawn(targetPos, specFor(hit, damage, fromPlayer), nowMs, { stackLevel: this.nextStackLevel(targetAid, nowMs) });
  }

  /** One rising white number per hit (each ≈ total/count) on the target's
   *  vertical line, then the yellow sum pinned above the monster. */
  private spawnMultiHit(
    targetPos: Vector3,
    total: number,
    hit: HitType,
    fromPlayer: boolean,
    nowMs: number,
    count: number,
  ): void {
    const perHit = Math.max(1, Math.floor(total / count));
    // Individual hits keep the source's colour (crit stays yellow); only the
    // combo total above is forced to the combo yellow.
    const hitType: HitType = hit === "critical" ? "critical" : "normal";
    for (let i = 0; i < count; i++) {
      const free = this.pool.find((f) => !f.active);
      if (!free) break;
      free.spawn(targetPos, specFor(hitType, perHit, fromPlayer), nowMs + i * HIT_STAGGER_MS, { column: true });
    }
    const comboFloat = this.pool.find((f) => !f.active);
    if (comboFloat) comboFloat.spawn(targetPos, comboSpec(total), nowMs + count * HIT_STAGGER_MS, { combo: true });
  }

  /** Vertical tier for separate single hits landing on the same target within a
   *  short window, so they don't overlap into a blob. */
  private nextStackLevel(targetAid: number, nowMs: number): number {
    const stack = this.stacks.get(targetAid);
    const STACK_WINDOW_MS = 250;
    if (stack && nowMs - stack.lastMs < STACK_WINDOW_MS) {
      stack.count += 1;
      stack.lastMs = nowMs;
      return stack.count;
    }
    this.stacks.set(targetAid, { count: 0, lastMs: nowMs });
    return 0;
  }

  update(nowMs: number, camera: PerspectiveCamera): void {
    for (const f of this.pool) f.update(nowMs, camera);
  }

  dispose(): void {
    for (const f of this.pool) f.dispose();
    this.pool.length = 0;
  }
}
