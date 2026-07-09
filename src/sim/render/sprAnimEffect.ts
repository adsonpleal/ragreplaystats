// A played .spr/.act sprite animation, rendered as a camera-facing billboard —
// RO's "SPR" effect type (poison hits, shockwaves, sparkles, the Comodo fireworks
// ball, …) and the sprite-textured branch of "3D". The client plays action 0 of an
// effect sprite frame-by-frame; roBrowser does it through SpriteRenderer.
//
// The gateway pre-composites each .act frame into a PNG (every layer's placement,
// scale, colour baked in) and serves the play-list as /effects/sprites/<key>/
// sprite.json = { frames: [{ img, delay, offset:[x,y] }] } (see ragassets
// extract-grf.mjs buildSpriteEffect). So this renderer is simple: swap the frame
// texture on the play-list's timing and size the quad to the frame's own pixels —
// no .spr/.act parsing on the client. `offset` is the composited image centre in RO
// px (+x right, +y down; we negate y for the Y-up world), like StrEffect's anchor.
//
// Placement matches the other effect renderers: centred billboard facing the camera,
// MIRROR_X to undo the scene's un-mirrored view, FRONT_BIAS toward the camera to
// clear the ground. `head`/`yOffset` raise it (a hit spark over the target's head).

import {
  AddEquation,
  BufferAttribute,
  BufferGeometry,
  CustomBlending,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  OneMinusSrcAlphaFactor,
  type PerspectiveCamera,
  type Scene,
  SrcAlphaFactor,
  Vector3,
} from "three";
import { UNITS_PER_PX } from "../sprite";
import type { LoadedSprAnim } from "./effectAssets";

const MIRROR_X = -1; // see strEffect.ts MIRROR_X
const FRONT_BIAS = 2.5;
// A head-attached spark sits ~1 tile above the ground anchor (RO body height).
const HEAD_UP = 1.0;

export class SprAnimEffect {
  private readonly mesh: Mesh;
  private readonly material: MeshBasicMaterial;
  private readonly geometry: BufferGeometry;
  private readonly positions: BufferAttribute;
  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private readonly toCam = new Vector3();
  private readonly center = new Vector3();
  private readonly totalMs: number;

  constructor(
    private readonly scene: Scene,
    private readonly e: LoadedSprAnim,
    private readonly cellSize: number,
  ) {
    this.totalMs = e.frames.reduce((s, f) => s + f.delayMs, 0) || 1;
    this.geometry = new BufferGeometry();
    this.positions = new BufferAttribute(new Float32Array(4 * 3), 3);
    this.positions.setUsage(35048 /* DynamicDrawUsage */);
    this.geometry.setAttribute("position", this.positions);
    // Centered quad, uv y-flipped (v=0 at top).
    this.geometry.setAttribute(
      "uv",
      new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2),
    );
    this.geometry.setIndex([0, 1, 2, 2, 1, 3]);
    this.material = new MeshBasicMaterial({
      map: e.frames[0]?.texture ?? null,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      fog: false,
      side: DoubleSide,
      // Sprite frames are colorkeyed RGBA — normal alpha (roBrowser SpriteRenderer).
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: SrcAlphaFactor,
      blendDst: OneMinusSrcAlphaFactor,
    });
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
    this.scene.add(this.mesh);
  }

  /** Advance to `elapsedMs` since (staggered) start; pick the play-list frame and
   *  place the billboard at `anchor`. Returns false once a non-looping animation
   *  finishes (unless `stopAtEnd`, which holds the last frame alive). */
  update(elapsedMs: number, camera: PerspectiveCamera, anchor: Vector3, loop = false): boolean {
    const frames = this.e.frames;
    if (!frames.length || elapsedMs < 0) {
      this.mesh.visible = false;
      return elapsedMs < 0; // pre-start: stay alive; empty: cull
    }
    const cycling = loop || this.e.loop;
    let t = elapsedMs;
    if (cycling) t %= this.totalMs;
    else if (elapsedMs >= this.totalMs) {
      if (!this.e.stopAtEnd) {
        this.mesh.visible = false;
        return false;
      }
      t = this.totalMs - 1; // hold the last frame
    }

    // Pick the frame whose cumulative window contains t.
    let acc = 0;
    let fi = frames.length - 1;
    for (let i = 0; i < frames.length; i++) {
      acc += frames[i].delayMs;
      if (t < acc) { fi = i; break; }
    }
    const frame = frames[fi];
    const tex = frame.texture;
    const img = tex?.image as HTMLImageElement | undefined;
    if (!tex || !img || img.complete === false || !img.width) {
      this.mesh.visible = false;
      return true;
    }
    this.mesh.visible = true;
    if (this.material.map !== tex) {
      this.material.map = tex;
      this.material.needsUpdate = true;
    }

    // Frame quad sized to its own pixels; centered on anchor + offset (+ head lift).
    const hw = (img.width * UNITS_PER_PX) / 2;
    const hh = (img.height * UNITS_PER_PX) / 2;
    this.center.copy(anchor);
    if (this.e.head) this.center.y += HEAD_UP * this.cellSize;
    this.center.y += this.e.yOffset * UNITS_PER_PX;

    this.right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    this.toCam.copy(camera.position).sub(this.center).normalize();
    // Offset the frame's composited centre (RO px: +x right, +y down).
    const ox = MIRROR_X * frame.offX * UNITS_PER_PX;
    const oy = -frame.offY * UNITS_PER_PX;
    const cx = [-hw, hw, -hw, hw];
    const cy = [hh, hh, -hh, -hh];
    const arr = this.positions.array as Float32Array;
    for (let i = 0; i < 4; i++) {
      const lx = cx[i] + ox;
      const ly = cy[i] + oy;
      arr[i * 3] = this.center.x + this.right.x * lx + this.up.x * ly + this.toCam.x * FRONT_BIAS;
      arr[i * 3 + 1] = this.center.y + this.right.y * lx + this.up.y * ly + this.toCam.y * FRONT_BIAS;
      arr[i * 3 + 2] = this.center.z + this.right.z * lx + this.up.z * ly + this.toCam.z * FRONT_BIAS;
    }
    this.positions.needsUpdate = true;
    return true;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.material.dispose();
    this.geometry.dispose();
    // Frame textures are shared/cached in effectAssets; not disposed here.
  }
}
