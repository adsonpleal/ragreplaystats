// The ground "lock-on" cast circle — the rotating targeting ring under a caster
// while its cast bar fills. Faithful port of roBrowser's LockOnTarget.js
// (+ LockOnTarget.vs/.fs, MrAntares fork), the FUNC behind EF_LOCKON (effect 60).
//
// It's a flat quad laid on the ground (XZ plane) textured with effect/lockon128.tga
// (rotated 45° at load in the client — folded into the spin here), spinning about Y,
// shrinking from a wide ring to a tight one over the first ~250ms, and pulsing
// white→red. Unlike the table effects this carries no params: the client spawns it
// directly on cast-start for the cast's duration, so EffectsLayer builds it via a
// dedicated path (not loadEffect).
//
// Model (matches roBrowser render()):
//   time  = clamp(elapsed/50, 1, 5)          → size = (6 - time) * 3   (15 → 3 tiles)
//   color = (20 - floor(elapsed/20) % 20)/20 → tint, applied to G+B (red stays)
//   spin  = elapsed/4 degrees about Y         (+45° for the baked texture rotation)
// Sizes are in TILES → world = size × cellSize. Driven off `elapsed` (recording
// clock) so scrubbing/pausing track, like every other effect renderer.

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
  type Texture,
  type Vector3,
} from "three";

const DEG = Math.PI / 180;
// The client rotates lockon128.tga 45° when it uploads the texture; we bake that
// into the quad's base spin instead of pre-rotating the image.
const TEXTURE_ROT = 45 * DEG;

export class CastCircleEffect {
  private readonly mesh: Mesh;
  private readonly material: MeshBasicMaterial;
  private readonly geometry: BufferGeometry;

  constructor(
    private readonly scene: Scene,
    texture: Texture | null,
    private readonly cellSize: number,
  ) {
    // A unit quad flat on the XZ plane (y=0), corners ±0.5, uv 0..1. Scaled by the
    // animated size each frame; spun about Y.
    this.geometry = new BufferGeometry();
    // prettier-ignore
    this.geometry.setAttribute("position", new BufferAttribute(new Float32Array([
      -0.5, 0, -0.5,  0.5, 0, -0.5,  0.5, 0, 0.5,  -0.5, 0, 0.5,
    ]), 3));
    // prettier-ignore
    this.geometry.setAttribute("uv", new BufferAttribute(new Float32Array([
      0, 0, 1, 0, 1, 1, 0, 1,
    ]), 2));
    this.geometry.setIndex([0, 1, 2, 0, 2, 3]);
    this.material = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      fog: false,
      side: DoubleSide,
      // The client discards fully-transparent texels and draws the ring over the
      // ground — normal alpha (the bright ring reads on any floor).
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: SrcAlphaFactor,
      blendDst: OneMinusSrcAlphaFactor,
      alphaTest: 0.01, // roBrowser's `if (a == 0.0) discard`
    });
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1; // on the ground, under cylinders/sprites/STR
    this.mesh.visible = false;
    this.scene.add(this.mesh);
  }

  /** Advance to `elapsedMs` since cast-start and place the ring at `anchor`. Always
   *  returns true (a persistent cast visual); the caller culls it when the cast
   *  ends (its lifetime). */
  update(elapsedMs: number, _camera: PerspectiveCamera, anchor: Vector3): boolean {
    if (elapsedMs < 0) {
      this.mesh.visible = false;
      return true;
    }
    // Size: 15 → 3 tiles over the first ~250ms, then held.
    const time = Math.min(Math.max(elapsedMs / 50, 1), 5);
    const size = (6 - time) * 3 * this.cellSize;
    // Pulse: white (1) down to near-0 every 400ms, tinting toward red (G+B fade).
    const color = (20 - (Math.floor(elapsedMs / 20) % 20)) / 20;

    this.mesh.visible = true;
    this.mesh.scale.set(size, 1, size);
    this.mesh.rotation.y = (elapsedMs / 4) * DEG + TEXTURE_ROT;
    this.mesh.position.copy(anchor);
    this.material.color.setRGB(1, color, color);
    return true;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.material.dispose();
    this.geometry.dispose();
    // Texture is shared/cached in effectAssets; not disposed here.
  }
}
