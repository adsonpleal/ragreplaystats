// A four-sided pyramid "horn" standing on the ground — RO's Ice Wall / stone-spike
// ground effect ("QuadHorn" type). Faithful port of roBrowser's QuadHorn.js
// (+ QuadHorn.vs, MrAntares fork). The client draws a fixed 4-face pyramid mesh
// scaled by bottomSize (base) × height (up), rotated (X/Y/Z), placed at the cell,
// with a grow/rise animation. We reproduce the shader's scale→rotate→translate as a
// three.js TRS on a unit-pyramid mesh (apex (0,1,0), base at ±1).
//
// Coordinates (as the other effect renderers): bottomSize/height/offsets are in
// TILES → world = value × cellSize; offsetX→world x (× MIRROR_X for our unmirrored
// scene), offsetY→world z, height→world y (up). The shader sinks the base ~0.9×height
// so the spike emerges from the ground; we place the pyramid centre that far up so its
// base sits just under the anchor and its apex points up.

import {
  AddEquation,
  BufferAttribute,
  BufferGeometry,
  CustomBlending,
  DoubleSide,
  DstAlphaFactor,
  DstColorFactor,
  Euler,
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
import type { LoadedQuadHorn } from "./effectAssets";

const DEG = Math.PI / 180;
const MIRROR_X = -1;

// blendMode int → dst factor (source SRC_ALPHA), same enum as CylinderEffect.
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

// roBrowser's QuadHorn base mesh: a pyramid, apex at (0,1,0), square base at y=-1.
// 4 triangular faces (12 verts) with the file's own texcoords.
// prettier-ignore
const VERTS = new Float32Array([
  0, 1, 0, -1, -1, 1, 1, -1, 1,
  0, 1, 0, 1, -1, 1, 1, -1, -1,
  0, 1, 0, 1, -1, -1, -1, -1, -1,
  0, 1, 0, -1, -1, -1, -1, -1, 1,
]);
// prettier-ignore
const UVS = new Float32Array([
  0, 0, 1, 0, 1, 1,
  0, 0, 1, 1, 0, 1,
  1, 0, 1, 1, 0, 1,
  1, 0, 0, 1, 0, 0,
]);

export class QuadHornEffect {
  private readonly mesh: Mesh;
  private readonly material: MeshBasicMaterial;
  private readonly geometry: BufferGeometry;
  private readonly euler = new Euler();

  constructor(
    private readonly scene: Scene,
    private readonly e: LoadedQuadHorn,
    private readonly cellSize: number,
  ) {
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute("position", new BufferAttribute(VERTS, 3));
    this.geometry.setAttribute("uv", new BufferAttribute(UVS, 2));
    this.material = new MeshBasicMaterial({
      map: e.texture,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      fog: false,
      side: DoubleSide,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: SrcAlphaFactor,
      blendDst: (BLEND_DST[e.blendMode] ?? OneMinusSrcAlphaFactor) as MeshBasicMaterial["blendDst"],
    });
    this.material.color.setRGB(e.color[0], e.color[1], e.color[2]);
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2; // a ground spike, under sprites/STR
    this.mesh.visible = false;
    this.scene.add(this.mesh);
  }

  /** Advance to `elapsedMs`; grow/rise the spike and place it at `anchor`. `loop`
   *  keeps it alive for a persistent ground unit (the caller culls on lifetime);
   *  otherwise it stays up until animationOut sinks it past the ground. */
  update(elapsedMs: number, _camera: PerspectiveCamera, anchor: Vector3, loop = false): boolean {
    const e = this.e;
    if (elapsedMs < 0) {
      this.mesh.visible = false;
      return true;
    }
    const dSec = elapsedMs / 1000;
    const speedSec = e.animationSpeed / 1000;

    // Height / rise animation (roBrowser QuadHorn.render animation modes).
    let height = e.height;
    let offsetZ = e.offsetZ;
    if (e.animation === 1) {
      // Grow up: height lerps 0→height over animationSpeed.
      height = Math.min(dSec / speedSec, e.height);
    } else if (e.animation === 2 || e.animation === 3) {
      // Rise: offsetZ lerps 0→offsetZ (mode 3 tops out at height/2).
      const cap = e.animation === 3 ? e.height / 2 : e.offsetZ;
      offsetZ = Math.min(dSec / speedSec, cap);
    }

    // animationOut: after duration, sink back down (offsetZ ramps negative); cull
    // once fully below ground.
    if (!loop && e.duration > 0 && elapsedMs > e.duration) {
      if (e.animationOut) {
        const dEnd = (elapsedMs - e.duration) / 1000;
        offsetZ = -((dEnd / speedSec) * e.height);
        if (offsetZ < -(e.height + e.offsetZ)) {
          this.mesh.visible = false;
          return false;
        }
      } else {
        this.mesh.visible = false;
        return false;
      }
    }
    if (height <= 0.0001) {
      this.mesh.visible = false;
      return true;
    }

    this.mesh.visible = true;
    // TRS: scale the unit pyramid (base × height), rotate, place. Base sinks ~0.9×
    // height so the spike stands on the ground (shader's height*0.9 term) + offsetZ.
    this.mesh.scale.set(e.bottomSize * this.cellSize, height * this.cellSize, e.bottomSize * this.cellSize);
    this.euler.set(e.rotateX * DEG, e.rotateY * DEG, (180 + e.rotateZ) * DEG, "XYZ");
    this.mesh.quaternion.setFromEuler(this.euler);
    this.mesh.position.set(
      anchor.x + MIRROR_X * e.offsetX * this.cellSize,
      anchor.y + (height * 0.9 + offsetZ) * this.cellSize,
      anchor.z + e.offsetY * this.cellSize,
    );
    this.material.opacity = e.color[3];
    return true;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.material.dispose();
    this.geometry.dispose();
  }
}
