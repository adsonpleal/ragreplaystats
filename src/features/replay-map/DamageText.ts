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

/** Single-hit (auto-attack / one-shot skill) number lifetime in ms. Kept close
 *  to the multi-hit whites' quick pop-and-fade (HIT_LIFETIME_MS) so a lone hit
 *  moves and clears at the same brisk pace as a combo — the old roBrowser 1500ms
 *  loft felt sluggish here. */
const LIFETIME_MS = 700;
/** Miss/dodge lifetime — matches roBrowser's `perc = age/800` for MISS. */
const MISS_LIFETIME_MS = 800;
/** Miss numbers rise straight up from this base lift (world units). */
const BASE_LIFT = 2;

// Multi-hit skills, matching the RO client: each hit spawns its own white
// number that flies up the target in a gentle OPEN ARCH (rising while curving
// out to one side), staggered a beat apart so successive hits fan open — older
// ones higher, smaller and fading. Above them a small yellow RUNNING TOTAL pins
// over the monster: it starts at the first hit's value and grows — in value and
// size — as each subsequent hit lands. Timing is quick, matching the client:
// the hits pop ≈180ms apart and each clears in ≈600ms (not the lazy 1.5s of a
// single auto-attack number).
const HIT_STAGGER_MS = 180; // gap between hits — tight, like the client's rapid combo
const HIT_LIFETIME_MS = 600; // a single hit number's life — quick pop-and-fade
const COLUMN_BASE_WORLD = 0.8; // where a hit number starts (low, on the monster body)
const HIT_RISE_WORLD = 2.2; // how far a hit number climbs over its life — tops out
//                            just below the yellow total, never colliding with it
const HIT_SPREAD_WORLD = 2.6; // how far a hit number curves out sideways (the arch's
//                              width); consecutive hits alternate side to open a fan
const COMBO_ABOVE_WORLD = 3.6; // yellow total's height above the target anchor —
//                               just over the monster's head, clear of the hits
const COMBO_FONT_PX = 24; // yellow total glyphs — smaller than the white hits (26)
const COMBO_GROW_FROM = 0.55; // running-total scale at the first hit…
const COMBO_GROW_TO = 1; //      …grown to this by the last hit
const COMBO_LINGER_MS = 1200; // how long the total holds after the last hit
const COMBO_COLOR = "#e6e626"; // RO combo yellow rgb(0.9,0.9,0.15)

// Critical hits get the client's spiky red starburst drawn behind the digits.
// The RO client renders this in code (there's no sprite for it in the GRF — the
// only damage-number asset is the white digit font data\sprite\이팩트\숫자.spr),
// so we draw it ourselves into the number canvas, behind the yellow glyphs.
const CRIT_STAR_POINTS = 8; // spikes — matches the client's 8-point burst
const CRIT_STAR_FILL = "#bb3a1c"; // brick-red body
const CRIT_STAR_EDGE = "#5c1808"; // darker rim so it reads over any ground
const CRIT_STAR_INNER = 0.5; // inner/outer radius ratio (how deep the spikes cut)

const TEXT_CANVAS_W = 128;
// Tall enough to fit the critical starburst's top/bottom points around the
// digits. Glyph world-size is (fontPx / canvasH) * worldH = fontPx * const, so
// it's independent of this height — a taller canvas only gives the star room,
// it does NOT change how big any number renders.
const TEXT_CANVAS_H = 72;

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
  /** Draw the red critical starburst behind the digits (crit hits only). */
  star?: boolean;
};

function specFor(hit: HitType, damage: number, fromPlayer: boolean): TextSpec {
  if (hit === "miss") {
    return { text: "miss", color: "#ffffff", outline: "#000", fontPx: 22, lifeMs: MISS_LIFETIME_MS };
  }
  const label = formatDamage(damage);
  if (hit === "critical") {
    return { text: label, color: COMBO_COLOR, outline: "#000", fontPx: 28, lifeMs: LIFETIME_MS, star: true };
  }
  // roBrowser: outgoing damage is white, damage TO a PC is red. In replays we
  // don't always know the target kind cheaply, so approximate with "did the
  // player deal it?" — white when yes, red otherwise.
  const color = fromPlayer ? "#ffffff" : "#ff4040";
  return { text: label, color, outline: "#000", fontPx: 26, lifeMs: LIFETIME_MS };
}

/** The yellow running-total spec — starts showing the first hit's value; the
 *  Float updates the text as more hits land. Lives long enough to cover all the
 *  staggered hits plus a linger. */
function runningTotalSpec(perHit: number, count: number): TextSpec {
  const lifeMs = (count - 1) * HIT_STAGGER_MS + COMBO_LINGER_MS;
  return { text: formatDamage(perHit), color: COMBO_COLOR, outline: "#000", fontPx: COMBO_FONT_PX, lifeMs };
}

/** Per-spawn placement options for a Float. */
type SpawnOpts = {
  /** Vertical tier for close-together separate hits (single-hit stacking). */
  stackLevel?: number;
  /** This float is one hit of a multi-hit skill — flies up the one open arch
   *  (curving out to the same side) so staggered hits trail the same path. */
  column?: boolean;
  /** This float is the yellow running total pinned above the monster: it counts
   *  up `perHit` for each hit that has landed (by the stagger clock) and grows
   *  in size as it goes. */
  runningTotal?: { perHit: number; count: number };
};

/** Trace a `points`-pointed star centred at (cx,cy). Separate x/y radii so the
 *  burst can be wider than tall to hug a multi-digit number, like the client. */
function starPath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  points: number,
  innerRatio: number,
): void {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    // Start at the top point (-π/2) and alternate outer/inner vertices.
    const ang = -Math.PI / 2 + (Math.PI / points) * i;
    const k = i % 2 === 0 ? 1 : innerRatio;
    const x = cx + Math.cos(ang) * rx * k;
    const y = cy + Math.sin(ang) * ry * k;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawText(canvas: HTMLCanvasElement, spec: TextSpec): void {
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  // Galmuri11 — same crisp pixel font the latamvisuais UI uses. Bitmap
  // glyphs match the client's damage.spr blocky look far better than any
  // TTF sans. Falls back to Impact/Arial Black if the woff2 hasn't loaded
  // yet (the very first hit on a fresh page can beat the font).
  ctx.font = `${spec.fontPx}px Galmuri11, Impact, "Arial Black", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // Critical: spiky red starburst behind the glyphs. Size it off the measured
  // text so it hugs the number — a bit past the digits horizontally, a touch
  // taller than the font — and clamp to the canvas so the points never clip.
  if (spec.star) {
    const textW = ctx.measureText(spec.text).width;
    // Taller than the glyphs, a little wider than the number. rx is floored at
    // ry so a short value never gets a skinny portrait star.
    const ry = Math.min(cy - 1, spec.fontPx * 1.25);
    const rx = Math.min(cx - 1, Math.max(textW / 2 + spec.fontPx * 0.5, ry));
    starPath(ctx, cx, cy, rx, ry, CRIT_STAR_POINTS, CRIT_STAR_INNER);
    ctx.fillStyle = CRIT_STAR_FILL;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.strokeStyle = CRIT_STAR_EDGE;
    ctx.stroke();
  }
  // Thick outline first, fill on top — the client uses a heavy black outline so
  // the number stays readable over any ground colour.
  ctx.lineWidth = 6;
  ctx.lineJoin = "round";
  ctx.strokeStyle = spec.outline;
  ctx.strokeText(spec.text, cx, cy);
  ctx.fillStyle = spec.color;
  ctx.fillText(spec.text, cx, cy);
}

class Float {
  readonly mesh: Mesh;
  readonly canvas: HTMLCanvasElement;
  readonly texture: CanvasTexture;
  readonly anchor = new Vector3();
  bornAtMs = 0;
  lifeMs = LIFETIME_MS;
  liftOffsetWorld = 0; // extra rise when hits stack on the same target
  column = false; // multi-hit hit — flies up the target in an open arch
  private runningTotal: { perHit: number; count: number } | null = null; // yellow total
  private baseSpec: TextSpec | null = null; // kept so the running total can redraw
  private lastLanded = -1; // hits counted into the running total so far
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
    this.runningTotal = opts.runningTotal ?? null;
    this.baseSpec = this.runningTotal ? spec : null;
    this.lastLanded = -1;
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

    // Running total: pinned just above the monster. It counts up one `perHit`
    // per hit that has landed by the stagger clock (so it starts at the first
    // hit's value and grows to the full sum) and scales up as it counts,
    // starting small. Fades out in the last 25%.
    if (this.runningTotal && this.baseSpec) {
      const { perHit, count } = this.runningTotal;
      const landed = Math.min(count, Math.floor(age / HIT_STAGGER_MS) + 1);
      if (landed !== this.lastLanded) {
        this.lastLanded = landed;
        drawText(this.canvas, { ...this.baseSpec, text: formatDamage(perHit * landed) });
        this.texture.needsUpdate = true;
      }
      const grow =
        count > 1 ? COMBO_GROW_FROM + (COMBO_GROW_TO - COMBO_GROW_FROM) * ((landed - 1) / (count - 1)) : COMBO_GROW_TO;
      const alpha = perc < 0.75 ? 1 : Math.max(0, (1 - perc) / 0.25);
      (this.mesh.material as MeshBasicMaterial).opacity = alpha;
      this.mesh.scale.set(grow, grow, 1);
      this.mesh.position
        .copy(this.anchor)
        .addScaledVector(this.up, COMBO_ABOVE_WORLD)
        .addScaledVector(this.toCam, 1);
      return;
    }

    // Multi-hit hit: fly up in an open arch. The vertical rise leads early
    // (sin ramps fast off zero) while the sideways curve comes in later
    // (1 - cos ramps up toward the end), so the path shoots up then leans out
    // to one side — a fountain arch, not a rigid vertical line. Every hit rides
    // this same path, staggered in time so they trail up it. Starts large and
    // bright, shrinks as it climbs, holds until the last 40% then fades.
    if (this.column) {
      const q = perc * Math.PI * 0.5;
      const rise = COLUMN_BASE_WORLD + HIT_RISE_WORLD * Math.sin(q);
      const side = HIT_SPREAD_WORLD * (1 - Math.cos(q));
      const alpha = perc < 0.6 ? 1 : Math.max(0, (1 - perc) / 0.4);
      (this.mesh.material as MeshBasicMaterial).opacity = alpha;
      const scale = Math.max(0.5, 1 - perc * 0.5);
      this.mesh.scale.set(scale, scale, 1);
      this.mesh.position
        .copy(this.anchor)
        .addScaledVector(this.up, rise)
        .addScaledVector(this.right, side)
        .addScaledVector(this.toCam, 1);
      return;
    }

    const isMiss = this.lifeMs === MISS_LIFETIME_MS;
    if (!isMiss) {
      // Single hit (auto-attack / one-shot skill): ride the SAME open arch as a
      // multi-hit skill white — rising off the monster body and curving out to
      // one side — instead of lofting way up above the target on the old
      // Damage.js loft-and-dip. Stacked hits sit a tier higher (liftOffsetWorld)
      // so rapid separate hits don't overlap into a blob.
      const q = perc * Math.PI * 0.5;
      const rise = COLUMN_BASE_WORLD + HIT_RISE_WORLD * Math.sin(q);
      const side = HIT_SPREAD_WORLD * (1 - Math.cos(q));
      const alpha = perc < 0.6 ? 1 : Math.max(0, (1 - perc) / 0.4);
      (this.mesh.material as MeshBasicMaterial).opacity = alpha;
      const scale = Math.max(0.5, 1 - perc * 0.5);
      this.mesh.scale.set(scale, scale, 1);
      this.mesh.position
        .copy(this.anchor)
        .addScaledVector(this.up, rise + this.liftOffsetWorld)
        .addScaledVector(this.right, side)
        .addScaledVector(this.toCam, 1);
      return;
    }
    // MISS just rises linearly, no drift.
    (this.mesh.material as MeshBasicMaterial).opacity = 1 - perc;
    this.mesh.scale.set(0.6, 0.6, 1);
    this.mesh.position
      .copy(this.anchor)
      .addScaledVector(this.up, BASE_LIFT + perc * 7 + this.liftOffsetWorld)
      .addScaledVector(this.toCam, 1);
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
      // Quick pop-and-fade life (not the lazy single-hit 1.5s). Every hit rides
      // the SAME open arch — staggered in time so they trail up the one path,
      // not fanned out to opposite sides. No per-hit starburst — the small
      // rising numbers would turn into a cluttered mess of stars.
      const spec = { ...specFor(hitType, perHit, fromPlayer), lifeMs: HIT_LIFETIME_MS, star: false };
      free.spawn(targetPos, spec, nowMs + i * HIT_STAGGER_MS, { column: true });
    }
    // The yellow running total appears up front (with the first hit) showing
    // that first hit's value, then counts up + grows as each hit lands beneath
    // it, pinned above the monster.
    const totalFloat = this.pool.find((f) => !f.active);
    if (totalFloat) totalFloat.spawn(targetPos, runningTotalSpec(perHit, count), nowMs, { runningTotal: { perHit, count } });
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
