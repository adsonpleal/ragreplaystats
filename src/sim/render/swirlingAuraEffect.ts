// The level-99 swirling aura — three blue ribbon "bands" that rise from the ground
// in a spiral around a high-level character. Port of roBrowser's SwirlingAura.js
// (+ .vs/.fs, MrAntares fork), the FUNC behind EF_LEVEL99 (effect 200), spawned as
// `new SwirlingAura(pos, 'ring_blue.tga', tick)`.
//
// Each band is a 21-segment strip along a 315° arc at radius `distance`: base verts
// on the ground, top verts pushed up + outward by a bell-shaped height profile
// (tallest mid-arc). The three bands differ in height/distance/rise-angle and spin
// at 3/4/5°/frame. roBrowser rebuilds the vertices every frame and ramps the height
// via a per-frame `process` counter — not scrub-safe — so we recompute the band
// state (spin + build-up) from the recording clock: the ribbons rise over ~1.5s then
// hold, spinning. Additive, blue-tinted (ring_blue.tga).

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
  type Texture,
  type Vector3,
} from "three";

const DEG = Math.PI / 180;
const MIRROR_X = -1; // see strEffect.ts — undo the scene's un-mirrored view
const GAME_TO_WORLD = 0.1 * 2.2; // roBrowser's visual-match scale
const E_DIVISION = 21;
const FULL_DISPLAY_ANGLE = 315;
const BASIC_ANGLE = FULL_DISPLAY_ANGLE / (E_DIVISION - 1); // 15.75°
const INNER_CIRCLE_SCALE = 0.6;
const FRAME_MS = 1000 / 60; // roBrowser advances one `process`/spin step per frame

// Bell-shaped height profile weight per division: sin(90 + (i-10)*9)°, peaking mid-arc.
const SIN_LIMIT = Array.from({ length: E_DIVISION }, (_, i) =>
  Math.sin((90 + (i - 10) * 9) * DEG),
);

interface Band {
  rotStart: number; // starting rotation (deg)
  maxHeight: number;
  distance: number;
  cosRise: number;
  sinRise: number;
  spinSpeed: number; // deg/frame
  mesh: Mesh;
  positions: BufferAttribute;
}

export class SwirlingAuraEffect {
  private readonly group = new Group();
  private readonly bands: Band[] = [];
  private readonly material: MeshBasicMaterial;

  constructor(
    private readonly scene: Scene,
    texture: Texture | null,
    private readonly cellSize: number,
  ) {
    this.material = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      fog: false,
      side: DoubleSide,
      blending: AdditiveBlending, // roBrowser: blendFunc(SRC_ALPHA, ONE)
      opacity: 120 / 255, // alphaB
    });
    this.material.color.setRGB(100 / 255, 100 / 255, 255 / 255); // blue variant
    // Static index + uv: a 21-segment strip (base/top pairs). uv.u = k/20, base v=1.
    const uv = new Float32Array(E_DIVISION * 2 * 2);
    const idx: number[] = [];
    for (let k = 0; k < E_DIVISION; k++) {
      uv[k * 4] = k / (E_DIVISION - 1); uv[k * 4 + 1] = 1; // base
      uv[k * 4 + 2] = k / (E_DIVISION - 1); uv[k * 4 + 3] = 0; // top
    }
    for (let k = 0; k < E_DIVISION - 1; k++) {
      const i0 = k * 2, i1 = k * 2 + 1, i2 = k * 2 + 2, i3 = k * 2 + 3;
      idx.push(i0, i1, i2, i1, i3, i2);
    }
    for (let ec = 0; ec < 3; ec++) {
      const geometry = new BufferGeometry();
      const positions = new BufferAttribute(new Float32Array(E_DIVISION * 2 * 3), 3);
      positions.setUsage(35048 /* DynamicDrawUsage */);
      geometry.setAttribute("position", positions);
      geometry.setAttribute("uv", new BufferAttribute(uv.slice(), 2));
      geometry.setIndex(idx.slice());
      const mesh = new Mesh(geometry, this.material);
      mesh.frustumCulled = false;
      mesh.renderOrder = 2; // above the ground glow, under the character
      this.bands.push({
        rotStart: ec * 90,
        maxHeight: (15 - 2 * ec) * GAME_TO_WORLD,
        distance: (3.9 + 0.2 * ec) * GAME_TO_WORLD * INNER_CIRCLE_SCALE,
        cosRise: Math.cos((55 - 5 * ec) * DEG),
        sinRise: Math.sin((55 - 5 * ec) * DEG),
        spinSpeed: ec + 3,
        mesh,
        positions,
      });
      this.group.add(mesh);
    }
    this.group.visible = false;
    scene.add(this.group);
  }

  /** Advance to `elapsedMs`; rebuild + spin the three rising ribbons at `anchor`.
   *  Persistent (always alive) — the caller culls it when the actor vanishes. */
  update(elapsedMs: number, _camera: PerspectiveCamera, anchor: Vector3): boolean {
    if (elapsedMs < 0) {
      this.group.visible = false;
      return true;
    }
    this.group.visible = true;
    this.group.position.copy(anchor);
    const frames = elapsedMs / FRAME_MS;
    // Build-up: roBrowser ramps height by sin(process°) over the first 90 frames,
    // then holds. Reproduce as sin(min(frames,90)°), clamped to 1.
    const build = Math.min(Math.sin(Math.min(frames, 90) * DEG), 1);
    const cs = this.cellSize;
    for (const b of this.bands) {
      const rot = (b.rotStart + b.spinSpeed * frames) % 360;
      const arr = b.positions.array as Float32Array;
      let o = 0;
      for (let k = 0; k < E_DIVISION; k++) {
        const angle = (rot + k * BASIC_ANGLE) * DEG;
        const ca = Math.cos(angle), sa = Math.sin(angle);
        const baseX = b.distance * ca, baseZ = b.distance * sa;
        const h = b.maxHeight * SIN_LIMIT[k] * build;
        const rx = b.cosRise * h, ry = b.sinRise * h;
        // base vert (ground), then top vert (up + outward). roBrowser's topY = -Ry
        // in its y-down world → +Ry up here.
        arr[o++] = MIRROR_X * baseX * cs; arr[o++] = 0; arr[o++] = baseZ * cs;
        arr[o++] = MIRROR_X * (baseX + rx * ca) * cs; arr[o++] = ry * cs; arr[o++] = (baseZ + rx * sa) * cs;
      }
      b.positions.needsUpdate = true;
    }
    return true;
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.material.dispose();
    for (const b of this.bands) b.mesh.geometry.dispose();
  }
}
