// A single camera-facing billboard particle — RO's "3D" effect type (the sparkle
// clouds, rising motes, expanding rings and flying motes that make up most hit and
// aura visuals). Faithful port of roBrowser's ThreeDEffect.js (MrAntares fork,
// src/Renderer/Effects/ThreeDEffect.js), which draws one textured quad through the
// SpriteRenderer with a rich set of start→end interpolations.
//
// Multiplicity is NOT in this class: roBrowser's EffectManager spawns `duplicate`
// separate ThreeDEffect instances, each with a distinct `duplicateID` and a
// `timeBetweenDupli*id` start stagger, and each `*Delta` param scales by that id.
// We reproduce that in effectAssets.loadThreeDEntry (one LoadedThreeD per duplicate,
// its randoms sampled and deltas applied once), so this renderer just plays a single
// pre-resolved billboard — matching how StrEffect/CylinderEffect consume LoadedStr/
// LoadedCylinder. That also makes a spawn deterministic (randoms fixed at load, then
// memoised per effectId), which the golden harness needs.
//
// Coordinates (reconciled with StrEffect/CylinderEffect):
//  - billboard size is `size * UNITS_PER_PX` world units (roBrowser SpriteRenderer:
//    `_size = size/175 * xSize`, xSize=5 in 3D context ⇒ size*(5/175) = the same
//    sprite-px→world factor StrEffect uses). The quad is centered (roBrowser's base
//    verts are ±0.5), unlike STR's corner offsets.
//  - pos offsets are in TILES: posX→world x (× MIRROR_X for our non-mirrored scene),
//    posY→world z (ground plane), posZ→world y (height). cellSize (≈1) converts.
//  - the quad faces the camera (spherical billboard), then spins by `angle` in the
//    screen plane; FRONT_BIAS pulls it toward the camera to clear the ground, same
//    as StrEffect.
//
// `steps` (0..100) is progress over [0, duration]; every interpolation below is
// roBrowser's, including its log10 "smooth" easing and the sparkling cosine.

import {
  AddEquation,
  BufferAttribute,
  BufferGeometry,
  CustomBlending,
  DoubleSide,
  DstAlphaFactor,
  DstColorFactor,
  Mesh,
  MeshBasicMaterial,
  OneFactor,
  OneMinusDstAlphaFactor,
  OneMinusDstColorFactor,
  OneMinusSrcAlphaFactor,
  OneMinusSrcColorFactor,
  type PerspectiveCamera,
  type Scene,
  SrcAlphaFactor,
  SrcAlphaSaturateFactor,
  SrcColorFactor,
  Vector3,
  ZeroFactor,
} from "three";
import { UNITS_PER_PX } from "../sprite";
import type { LoadedThreeD } from "./effectAssets";

const DEG = Math.PI / 180;
const MIRROR_X = -1; // see strEffect.ts MIRROR_X — our scene isn't view-mirrored
const FRONT_BIAS = 2.5; // pull toward camera to clear the ground (as StrEffect)

// blendMode int → three dst factor. Source is always SRC_ALPHA (roBrowser:
// `blendFunc(SRC_ALPHA, blendMode[n])`); values >0 && <16 select the dst factor,
// anything else falls back to ONE_MINUS_SRC_ALPHA (normal alpha). Same enum as
// CylinderEffect's BLEND_DST.
const BLEND_DST: Record<number, number> = {
  1: ZeroFactor,
  2: OneFactor,
  3: SrcColorFactor,
  4: OneMinusSrcColorFactor,
  5: DstColorFactor,
  6: OneMinusDstColorFactor,
  7: SrcAlphaFactor,
  8: OneMinusSrcAlphaFactor,
  9: DstAlphaFactor,
  10: OneMinusDstAlphaFactor,
  15: SrcAlphaSaturateFactor,
};

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// roBrowser interpolates a start→end value over `steps` (0..100) either linearly or
// with a log10 ease (`smooth`). Factored out — the render path applies it to x/y/z
// position and to width/height identically.
function interp(start: number, end: number, steps: number, smooth: boolean): number {
  if (start === end) return start;
  if (smooth) return Math.log10(steps * 0.09 + 1) * (end - start) + start;
  return (steps * (end - start)) / 100 + start;
}

export class ThreeDEffect {
  private readonly mesh: Mesh;
  private readonly material: MeshBasicMaterial;
  private readonly geometry: BufferGeometry;
  private readonly positions: BufferAttribute;
  private readonly center = new Vector3();
  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private readonly toCam = new Vector3();

  constructor(
    private readonly scene: Scene,
    private readonly e: LoadedThreeD,
    private readonly cellSize: number,
  ) {
    this.geometry = new BufferGeometry();
    this.positions = new BufferAttribute(new Float32Array(4 * 3), 3);
    this.positions.setUsage(35048 /* DynamicDrawUsage */);
    this.geometry.setAttribute("position", this.positions);
    // Centered quad, uv y-flipped (roBrowser base verts: -0.5..+0.5, uv 0..1 with
    // v=0 at top). Triangle order matches the sprite buffer's strip.
    this.geometry.setAttribute(
      "uv",
      new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2),
    );
    this.geometry.setIndex([0, 1, 2, 2, 1, 3]);
    this.material = new MeshBasicMaterial({
      map: e.texture,
      transparent: true,
      depthWrite: false,
      depthTest: !e.overlay,
      fog: false,
      side: DoubleSide,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: SrcAlphaFactor,
      blendDst: (e.blendMode > 0 && e.blendMode < 16
        ? (BLEND_DST[e.blendMode] ?? OneMinusSrcAlphaFactor)
        : OneMinusSrcAlphaFactor) as MeshBasicMaterial["blendDst"],
    });
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    // Over the ground/cylinder (2), alongside STR layers (3), under damage text.
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
    this.scene.add(this.mesh);
  }

  /** Advance to `elapsedMs` since this instance's (already-staggered) start and
   *  place the billboard. Returns false once past its duration (one-shot); `loop`
   *  wraps it for persistent emitters (the caller culls those on their lifetime). */
  update(elapsedMs: number, camera: PerspectiveCamera, anchor: Vector3, loop = false): boolean {
    const dur = this.e.duration > 0 ? this.e.duration : 1000;
    let ms = elapsedMs;
    if (loop) ms = ((ms % dur) + dur) % dur;
    else if (elapsedMs >= dur) {
      this.mesh.visible = false;
      return false;
    }
    if (elapsedMs < 0) {
      this.mesh.visible = false; // staggered instance not started yet
      return true;
    }

    const steps = Math.min((ms / dur) * 100, 100);
    const e = this.e;

    // --- Position (tiles) → world offset from anchor ------------------------
    let px: number;
    let py: number;
    if (e.rotatePosX > 0) {
      px =
        e.rotatePosX *
        Math.cos((steps * 3.5 * e.nbOfRotation * DEG) - (e.rotateLate * Math.PI) / 2) *
        (e.rotationClockwise ? -1 : 1);
    } else {
      px = interp(e.posxStart, e.posxEnd, steps, e.posxSmooth);
    }
    if (e.rotatePosY > 0) {
      py = e.rotatePosY * Math.sin((steps * 3.5 * e.nbOfRotation * DEG) - (e.rotateLate * Math.PI) / 2);
    } else {
      py = interp(e.posyStart, e.posyEnd, steps, e.posySmooth);
    }
    // retreat: pull back along the start→end travel direction, peaking mid-life.
    if (e.retreat !== 0) {
      let dx = e.posxEnd - e.posxStart;
      let dy = e.posyEnd - e.posyStart;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 0.001) {
        dx /= dist;
        dy /= dist;
        const rf = Math.sin((steps * Math.PI) / 100) * e.retreat;
        px = interp(e.posxStart, e.posxEnd, steps, false) - dx * rf;
        py = interp(e.posyStart, e.posyEnd, steps, false) - dy * rf;
      }
    }
    let pz = interp(e.poszStart, e.poszEnd, steps, e.poszSmooth);
    if (e.arc !== 0) pz += e.arc * Math.sin((steps * Math.PI) / 100); // parabolic hop

    // 2D variant: rotate the (px,py) ground offset by the camera azimuth so the
    // pattern stays screen-facing (roBrowser TwoDEffect rotates by Camera.angle[1]).
    if (e.twoD) {
      const cRad = Math.atan2(camera.position.x - anchor.x, camera.position.z - anchor.z);
      const rx = px * Math.cos(cRad) - py * Math.sin(cRad);
      const ry = py * Math.cos(cRad) + px * Math.sin(cRad);
      px = rx;
      py = ry;
    }

    this.center
      .copy(anchor)
      .add(this.tmpOffset(MIRROR_X * px * this.cellSize, pz * this.cellSize, py * this.cellSize));

    // --- Alpha (fadeIn / fadeOut / sparkling) -------------------------------
    let alpha = e.alphaMax;
    if (e.fadeIn && ms < dur / 4) {
      alpha = (ms * e.alphaMax) / (dur / 4);
    } else if (e.fadeOut && ms > dur / 2 + dur / 4) {
      alpha = ((dur - ms) * e.alphaMax) / (dur / 4);
    } else if (e.sparkling) {
      alpha = e.alphaMax * ((Math.cos(steps * 11 * e.sparkNumber * DEG) + 1) / 2);
    }
    alpha = clamp01(alpha);
    if (alpha <= 0.001) {
      this.mesh.visible = false;
      return true;
    }
    this.mesh.visible = true;
    this.material.opacity = alpha;
    this.material.color.setRGB(e.red, e.green, e.blue);

    // --- Size (world) -------------------------------------------------------
    const sizeX = interp(e.sizeStartX, e.sizeEndX, steps, e.sizeSmooth) * UNITS_PER_PX;
    const sizeY = interp(e.sizeStartY, e.sizeEndY, steps, e.sizeSmooth) * UNITS_PER_PX;

    // --- Billboard quad, centered, facing camera, spun by `angle` -----------
    this.right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    let ang = e.rotate ? interp(e.angle, e.toAngle, steps, false) : e.angle;
    if (e.rotateWithCamera) {
      ang += Math.atan2(camera.position.x - this.center.x, camera.position.z - this.center.z) / DEG;
    }
    const ca = Math.cos(ang * DEG);
    const sa = Math.sin(ang * DEG);
    const hx = sizeX / 2;
    const hy = sizeY / 2;
    // Corner (cx,cy) in the billboard plane, rotated by `ang`, mapped to right/up.
    const arr = this.positions.array as Float32Array;
    const corners = [
      [-hx, hy],
      [hx, hy],
      [-hx, -hy],
      [hx, -hy],
    ];
    this.toCam.copy(camera.position).sub(this.center).normalize();
    for (let i = 0; i < 4; i++) {
      const cx = corners[i][0] * ca - corners[i][1] * sa;
      const cy = corners[i][0] * sa + corners[i][1] * ca;
      arr[i * 3] = this.center.x + this.right.x * cx + this.up.x * cy + this.toCam.x * FRONT_BIAS;
      arr[i * 3 + 1] = this.center.y + this.right.y * cx + this.up.y * cy + this.toCam.y * FRONT_BIAS;
      arr[i * 3 + 2] = this.center.z + this.right.z * cx + this.up.z * cy + this.toCam.z * FRONT_BIAS;
    }
    this.positions.needsUpdate = true;
    return true;
  }

  private readonly _off = new Vector3();
  private tmpOffset(x: number, y: number, z: number): Vector3 {
    return this._off.set(x, y, z);
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.material.dispose();
    this.geometry.dispose();
    // Texture shared/cached in effectAssets; not disposed here.
  }
}
