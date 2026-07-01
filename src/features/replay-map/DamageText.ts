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
// K/M abbreviation: kRO 2020+ / high-rate servers collapse big damage into K or
// M (e.g. 1_500_000 → "1500K"). The exact thresholds aren't public — private
// servers pick their own — so we go with what the LATAM 4th-job scale
// actually produces:
//    < 1_000                    →  as-is  (42)
//    1_000 .. 999_999_999       →  "Nk"   (1500K)  (floor N/1000, no decimals)
//    ≥ 1_000_000_000            →  "Nm"   (2M)     (floor N/1_000_000)
// (Adjustable via the DAMAGE_* constants below.)

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

const TEXT_CANVAS_W = 128;
const TEXT_CANVAS_H = 48;

/** Damage → display string with the K/M collapse. Multi-hit count is appended
 *  as "×N" to preserve the info without breaking the abbreviation. */
const K_THRESHOLD = 1_000;
const M_THRESHOLD = 1_000_000_000;

function formatDamage(n: number): string {
  if (n < K_THRESHOLD) return String(n);
  if (n < M_THRESHOLD) return `${Math.floor(n / 1_000)}K`;
  return `${Math.floor(n / 1_000_000)}M`;
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
    // Combo yellow from roBrowser: rgb(0.9, 0.9, 0.15). Same used for crits.
    return { text: label, color: "#e6e626", outline: "#000", fontPx: 28, lifeMs: LIFETIME_MS };
  }
  // roBrowser: outgoing damage is white, damage TO a PC is red. In replays we
  // don't always know the target kind cheaply, so approximate with "did the
  // player deal it?" — white when yes, red otherwise.
  const color = fromPlayer ? "#ffffff" : "#ff4040";
  return { text: label, color, outline: "#000", fontPx: 26, lifeMs: LIFETIME_MS };
}

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

  spawn(at: Vector3, spec: TextSpec, nowMs: number, stackLevel: number): void {
    drawText(this.canvas, spec);
    this.texture.needsUpdate = true;
    this.anchor.copy(at);
    this.bornAtMs = nowMs;
    this.lifeMs = spec.lifeMs;
    this.liftOffsetWorld = stackLevel * 2.2;
    this.active = true;
    this.mesh.visible = true;
  }

  update(nowMs: number, camera: PerspectiveCamera): void {
    if (!this.active) return;
    const age = nowMs - this.bornAtMs;
    if (age >= this.lifeMs) {
      this.active = false;
      this.mesh.visible = false;
      return;
    }
    // roBrowser's `perc`: age / delay. Normalised 0..1 over the lifetime.
    const perc = age / this.lifeMs;

    // Motion. Two paths, ported from Damage.js's per-type branches:
    //  • DAMAGE  — arcs right (+X) and back (-Y in RO space, which is our
    //              camera-right axis), and vertically follows an offset sine
    //              (peaks at ~1/3 lifetime, then dips) so the number lofts and
    //              falls like a thrown coin.
    //  • MISS    — no horizontal drift, just a linear rise.
    const isMiss = this.lifeMs === MISS_LIFETIME_MS;
    // Fade + shrink. roBrowser: color[3] = 1 - perc; size = (1 - perc) * 4.
    // Cap the shrink so the last visible tick isn't a pinprick — clamp to 0.35.
    const alpha = 1 - perc;
    const scale = isMiss ? 0.6 : Math.max(0.35, 1 - perc * 0.65);
    (this.mesh.material as MeshBasicMaterial).opacity = alpha;
    this.mesh.scale.set(scale, scale, 1);

    // Face the camera fully (billboard) and derive axis vectors so the drift
    // stays in the sprite's local frame no matter how the camera is rotated.
    this.mesh.quaternion.copy(camera.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    this.right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    this.toCam.copy(camera.position).sub(this.anchor).normalize();

    // Damage arc from Damage.js:
    //   posZ = base + 2 + sin(-π/2 + π*(0.5 + perc*1.5)) * 5
    //   posX = base + perc*4     (drift right)
    //   posY = base - perc*4     (drift back / away)
    // In our scene the "back" axis is camera-toCam, so we push along it.
    const arc = Math.sin(-Math.PI / 2 + Math.PI * (0.5 + perc * 1.5)) * ARC_HEIGHT;
    const liftUp = isMiss ? BASE_LIFT + perc * 7 : BASE_LIFT + arc;

    // Anchor tight to the target's ground point. The +2 in liftUp already puts
    // the number just above the feet; adding more (was +8) shoved it far above
    // the sprite's head. Small extra offset stacks with liftOffsetWorld so
    // multi-hit numbers still tier upward.
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
    const free = this.pool.find((f) => !f.active);
    if (!free) return;
    const spec = specFor(hit, damage, fromPlayer);
    if (count > 1) spec.text = `${spec.text}×${count}`;
    const stack = this.stacks.get(targetAid);
    let level = 0;
    const STACK_WINDOW_MS = 250;
    if (stack && nowMs - stack.lastMs < STACK_WINDOW_MS) {
      stack.count += 1;
      stack.lastMs = nowMs;
      level = stack.count;
    } else {
      this.stacks.set(targetAid, { count: 0, lastMs: nowMs });
      level = 0;
    }
    free.spawn(targetPos, spec, nowMs, level);
  }

  update(nowMs: number, camera: PerspectiveCamera): void {
    for (const f of this.pool) f.update(nowMs, camera);
  }

  dispose(): void {
    for (const f of this.pool) f.dispose();
    this.pool.length = 0;
  }
}
