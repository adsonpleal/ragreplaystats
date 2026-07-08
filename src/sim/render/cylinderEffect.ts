// A procedurally-built cone/cylinder/ring standing on the ground — RO's ground
// AoE visuals (Sanctuary, Magnus Exorcismus' red pillar, Basílica's dome, Storm
// Gust rings, the Spirit Sphere aura, …). Faithful port of roBrowser's
// Cylinder.js (src/Renderer/Effects/Cylinder.js + Cylinder.vs, MrAntares fork),
// which our scene descends from. Unlike StrEffect's camera-facing quads this is
// a real 3D mesh, so it shares StrEffect's update/dispose contract but builds an
// actual cylinder geometry each frame.
//
// Model (matches roBrowser exactly):
//  - the base is a `circleSides`-segment ring of the unit circle; `top` verts sit
//    at height, `bottom` verts at 0. roBrowser's vertex shader scales the unit
//    ring by uTopSize/uBottomSize and the height by uHeight; we do it on the CPU.
//  - topSize/bottomSize/height are in TILES (the shader adds sin*size straight to
//    the cell coordinate), so world units = size * cellSize.
//  - blend: source is always SRC_ALPHA; `blendMode` is its own enum picking only
//    the DEST factor (2 = ONE = additive, the common ground-glow case).
//  - `animation` (0..5) ramps height/top/bottom over the effect's duration;
//    `fade` ramps alpha up over the first quarter and down over the last quarter.
//  - `rotate` spins the ring about its axis at tick/4 degrees; angleX/Y/Z are
//    static tilts; rotateWithCamera adds the camera azimuth (dome panels facing
//    the viewer). posX/Y/Z offsets and fixedPerspective are rare and omitted.

import {
  AddEquation,
  BufferAttribute,
  BufferGeometry,
  CustomBlending,
  DoubleSide,
  DstAlphaFactor,
  DstColorFactor,
  Euler,
  Group,
  Mesh,
  MeshBasicMaterial,
  OneFactor,
  OneMinusDstAlphaFactor,
  OneMinusDstColorFactor,
  OneMinusSrcAlphaFactor,
  OneMinusSrcColorFactor,
  type PerspectiveCamera,
  SrcAlphaFactor,
  SrcAlphaSaturateFactor,
  SrcColorFactor,
  type Scene,
  Vector3,
  ZeroFactor,
} from "three";
import type { LoadedCylinder } from "./effectAssets";

const DEG = Math.PI / 180;

// Cylinder `blendMode` int → three dst factor. Source is fixed to SRC_ALPHA
// (roBrowser: `blendFunc(SRC_ALPHA, blendMode[n])`). Note this is a DIFFERENT
// enum than StrEffect's D3DBLEND — here 2 = ONE (additive), 8 = 1-SRC_ALPHA.
// 9/10 (DST_ALPHA) map to the ONE/ZERO constants because our backbuffer has no
// destination alpha (same reasoning as strEffect's D3DBLEND 7/8).
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

/** One triangle vertex of the unit ring: position on the unit circle (sin/cos),
 *  which cap it belongs to (top vs bottom), and its static texcoord. */
interface UnitVertex {
  sin: number;
  cos: number;
  top: boolean;
}

/** roBrowser generateCylinder: a `circleSides`-segment ring (two triangles per
 *  segment, bottom+top). We close the ring with i in [0, circleSides) using the
 *  wrap point circleSides (== point 0 for a full circle), avoiding roBrowser's
 *  off-by-one over-read of an undefined vertex. */
function generateRing(
  totalCircleSides: number,
  circleSides: number,
  repeatTextureX: number,
): { verts: UnitVertex[]; uv: Float32Array } {
  const pts: { sin: number; cos: number; u: number }[] = [];
  for (let i = 0; i <= circleSides; i++) {
    const a = i / totalCircleSides;
    pts.push({
      sin: Math.sin(a * Math.PI * 2),
      cos: Math.cos(a * Math.PI * 2),
      u: a * (totalCircleSides / circleSides) * repeatTextureX,
    });
  }
  const verts: UnitVertex[] = [];
  const uv: number[] = [];
  const push = (p: { sin: number; cos: number; u: number }, top: boolean) => {
    verts.push({ sin: p.sin, cos: p.cos, top });
    uv.push(p.u, top ? 0 : 1);
  };
  for (let i = 0; i < circleSides; i++) {
    const b0 = pts[i];
    const b1 = pts[i + 1];
    // bottom[i], top[i], bottom[i+1]  +  top[i], bottom[i+1], top[i+1]
    push(b0, false); push(b0, true); push(b1, false);
    push(b0, true); push(b1, false); push(b1, true);
  }
  return { verts, uv: new Float32Array(uv) };
}

/** Height / top / bottom size (in tiles) at `rc` ms into a `dur`-ms lifetime,
 *  per roBrowser's `animation` mode. bottomSize stays full except in 3/4. */
function animate(
  animation: number,
  rc: number,
  dur: number,
  height: number,
  topSize: number,
  bottomSize: number,
): { h: number; top: number; bottom: number } {
  switch (animation) {
    case 1: {
      // Height grows (over the first second, or the whole life if shorter).
      const h = dur > 1000 ? Math.min(rc / 1000, 1) * height : (rc / dur) * height;
      return { h, top: topSize, bottom: bottomSize };
    }
    case 2: {
      const top = dur > 1000 ? Math.min(rc / 1000, 1) * topSize : (rc / dur) * topSize;
      return { h: height, top, bottom: bottomSize };
    }
    case 3: {
      // Sizes shrink; height pulses up then down.
      const k = 1 - rc / dur;
      let h = height;
      if (rc < dur / 2) h = (rc * height) / (dur / 2);
      else if (rc > dur / 2) h = ((dur - rc) * height) / (dur / 2);
      return { h, top: k * topSize, bottom: k * bottomSize };
    }
    case 4: {
      const g = Math.max(0, rc / dur);
      return { h: height, top: g * topSize, bottom: g * bottomSize };
    }
    case 5: {
      const h =
        rc < dur / 2 ? ((rc * 2) / dur) * height : ((dur - rc) * height) / (dur / 2);
      return { h, top: topSize, bottom: bottomSize };
    }
    default:
      return { h: height, top: topSize, bottom: bottomSize };
  }
}

export class CylinderEffect {
  private readonly group = new Group();
  private readonly mesh: Mesh;
  private readonly material: MeshBasicMaterial;
  private readonly geometry: BufferGeometry;
  private readonly positions: BufferAttribute;
  private readonly verts: UnitVertex[];
  private readonly euler = new Euler();

  constructor(
    private readonly scene: Scene,
    private readonly cyl: LoadedCylinder,
    private readonly cellSize: number,
  ) {
    const { verts, uv } = generateRing(
      cyl.totalCircleSides,
      cyl.circleSides,
      cyl.repeatTextureX,
    );
    this.verts = verts;
    this.geometry = new BufferGeometry();
    this.positions = new BufferAttribute(new Float32Array(verts.length * 3), 3);
    this.positions.setUsage(35048 /* DynamicDrawUsage */);
    this.geometry.setAttribute("position", this.positions);
    this.geometry.setAttribute("uv", new BufferAttribute(uv, 2));
    this.material = new MeshBasicMaterial({
      map: cyl.texture,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      fog: false,
      side: DoubleSide,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: SrcAlphaFactor,
      blendDst: (BLEND_DST[cyl.blendMode] ?? OneFactor) as MeshBasicMaterial["blendDst"],
    });
    this.material.color.setRGB(cyl.color[0], cyl.color[1], cyl.color[2]);
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    // Under StrEffect (3) and the character billboard/damage text: a ground disc
    // should draw beneath the sprites standing on it.
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
    this.group.add(this.mesh);
    scene.add(this.group);
  }

  /** Advance to `elapsedMs` since spawn; place + orient the ring at `anchor`
   *  (its base sits on the ground point). Same contract as StrEffect: returns
   *  false once a one-shot effect passes its duration; `loop` keeps it alive
   *  (the caller culls looped ground effects on their own lifetime). */
  update(elapsedMs: number, camera: PerspectiveCamera, anchor: Vector3, loop = false): boolean {
    const dur = this.cyl.duration > 0 ? this.cyl.duration : 1000;
    const cycle = loop || this.cyl.repeat;
    let rc = elapsedMs;
    if (cycle) rc = ((rc % dur) + dur) % dur;
    else if (elapsedMs >= dur) {
      this.mesh.visible = false;
      return false;
    }
    if (elapsedMs < 0) {
      this.mesh.visible = false;
      return true; // staged part not started yet (negative = pre-delay)
    }

    // Size/height ramp (tiles) → world units.
    const { h, top, bottom } = animate(
      this.cyl.animation,
      rc,
      dur,
      this.cyl.height,
      this.cyl.topSize,
      this.cyl.bottomSize,
    );
    const rTop = top * this.cellSize;
    const rBottom = bottom * this.cellSize;
    const hW = h * this.cellSize;
    const arr = this.positions.array as Float32Array;
    for (let i = 0; i < this.verts.length; i++) {
      const v = this.verts[i];
      const r = v.top ? rTop : rBottom;
      // X negated to match our scene's mirrored world (see strEffect MIRROR_X);
      // a radial ring is symmetric so this only sets texture/rotation handedness.
      arr[i * 3] = -v.sin * r;
      arr[i * 3 + 1] = v.top ? hW : 0;
      arr[i * 3 + 2] = v.cos * r;
    }
    this.positions.needsUpdate = true;

    // Alpha: alphaMax, optionally faded in over the first quarter and out over
    // the last quarter of the lifetime.
    let alpha = this.cyl.alphaMax;
    if (this.cyl.fade) {
      const q = dur / 4;
      if (rc < q) alpha = (rc * this.cyl.alphaMax) / q;
      else if (rc > dur - q) alpha = ((dur - rc) * this.cyl.alphaMax) / q;
    }
    if (alpha <= 0.001) {
      this.mesh.visible = false;
      return true;
    }
    this.mesh.visible = true;
    this.material.opacity = alpha;

    // Orient about the base: continuous spin + camera azimuth + static tilts.
    let yaw = this.cyl.angleY * DEG;
    if (this.cyl.rotate) yaw += (elapsedMs / 4) * DEG;
    if (this.cyl.rotateWithCamera) {
      yaw += Math.atan2(camera.position.x - anchor.x, camera.position.z - anchor.z);
    }
    this.euler.set(this.cyl.angleX * DEG, yaw, this.cyl.angleZ * DEG, "YXZ");
    this.mesh.quaternion.setFromEuler(this.euler);
    this.mesh.position.copy(anchor);
    return true;
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.material.dispose();
    this.geometry.dispose();
    // Texture is shared/cached in effectAssets; not disposed here.
  }
}
