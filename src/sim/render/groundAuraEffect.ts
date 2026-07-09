// The level-99 ground aura glow — two soft, additive light discs lying flat on the
// ground under a high-level character, gently breathing. Port of roBrowser's
// GroundAura.js (+ .vs/.fs, MrAntares fork), the FUNC behind EF_LEVEL99_2 (effect
// 201), spawned there as `new GroundAura(pos, 100, 15, 'pikapika2.bmp')`.
//
// roBrowser draws two quads at size+distance and size+distance*2, each pikapika2.bmp
// on the XZ plane, additively, oscillating size via a per-frame rise-angle
// accumulator. That accumulator is frame-rate-based and thus NOT scrub-safe, so we
// reproduce the same visual — two discs breathing between their base size and
// +distance — as a deterministic sine of the recording clock. Size is in
// SpriteRenderer units → world = size/35 (= UNITS_PER_PX, the sprite-px→world factor).

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  type PerspectiveCamera,
  type Scene,
  type Vector3,
} from "three";
import { UNITS_PER_PX } from "../sprite";
import type { LoadedGroundAura } from "./effectAssets";

// Breathing period (ms). roBrowser's rise-angle advances 3°/frame and reverses
// direction every 180° (~1s at 60fps); the disc breathes over roughly two of those.
const BREATHE_MS = 2000;

export class GroundAuraEffect {
  private readonly group = new Group();
  private readonly discs: { mesh: Mesh; material: MeshBasicMaterial; base: number; phase: number }[] = [];

  constructor(
    private readonly scene: Scene,
    e: LoadedGroundAura,
    private readonly cellSize: number,
  ) {
    const min = e.size + e.distance;
    const max = e.size + e.distance * 2;
    for (let i = 0; i < 2; i++) {
      const geometry = new BufferGeometry();
      // Unit quad flat on XZ (±0.5), uv 0..1; scaled per frame.
      // prettier-ignore
      geometry.setAttribute("position", new BufferAttribute(new Float32Array([
        -0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5,
      ]), 3));
      geometry.setAttribute("uv", new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
      geometry.setIndex([0, 1, 2, 0, 2, 3]);
      const material = new MeshBasicMaterial({
        map: e.texture,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        fog: false,
        side: DoubleSide,
        blending: AdditiveBlending, // roBrowser: blendFunc(SRC_ALPHA, ONE)
        opacity: 0.8, // uColor alpha
      });
      const mesh = new Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.rotation.y = (i * 23 * Math.PI) / 180; // fixed per-disc rotation (auraAngle)
      mesh.renderOrder = 1; // on the ground, under the character
      this.discs.push({ mesh, material, base: i === 0 ? min : max, phase: i * Math.PI });
      this.group.add(mesh);
    }
    this.group.visible = false;
    scene.add(this.group);
  }

  /** Advance to `elapsedMs`; breathe the two discs and place them flat at `anchor`.
   *  Persistent (always alive) — the caller culls it when the actor vanishes. */
  update(elapsedMs: number, _camera: PerspectiveCamera, anchor: Vector3): boolean {
    if (elapsedMs < 0) {
      this.group.visible = false;
      return true;
    }
    this.group.visible = true;
    this.group.position.copy(anchor);
    for (const d of this.discs) {
      // Breathe between base and base+distance-ish: base + a half-amplitude sine.
      const breathe = d.base * (1 + 0.1 * Math.sin((elapsedMs / BREATHE_MS) * Math.PI * 2 + d.phase));
      const world = breathe * UNITS_PER_PX * this.cellSize;
      d.mesh.scale.set(world, 1, world);
    }
    return true;
  }

  dispose(): void {
    this.scene.remove(this.group);
    for (const d of this.discs) {
      d.material.dispose();
      d.mesh.geometry.dispose();
    }
  }
}
