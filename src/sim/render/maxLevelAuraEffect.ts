// The max-level ("150/160/185/250") aura — recovered from the client EXE's
// CLevel150Effect (2025 Ragexe, via Ghidra; see project memory aura-150-exe-recovery).
// The EXE builds it as: (1) dense rings of animated W_bubble01-27.tga billboards
// arranged by angle and spun via a sin/cos table, and (2) two flat rotating ground
// rings (cir0002.tga size 18, "emp shock.tga" size 11). One class, tinted by the
// tier's effect id: 150=blue, 160=yellow, 185=pink, and the base-250 4th-job aura
// (EF_LEVEL4TH 2275) = GOLD (255,155,0).
//
// This is a faithful approximation of that structure (the exact 176-billboard count
// + matrix pipeline is simplified to rotating rings for the same read): concentric
// rings of camera-facing gold W_bubble billboards orbiting + cycling the 27 frames,
// over two flat additive ground rings. Verified on the golden stage; the exact
// particle math can be tightened against a base-250 recording later.

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
  Vector3,
} from "three";
import { UNITS_PER_PX } from "../sprite";

const MIRROR_X = -1;
const GAME_TO_WORLD = 0.1 * 2.2; // matches the level-99 aura scale
// Billboard ring layout (approximating the EXE's 4-ring × 22 dense arrangement).
const RINGS = [
  { count: 14, radius: 1.6, height: 0.4, spin: 24 },
  { count: 12, radius: 2.4, height: 1.1, spin: -18 },
  { count: 10, radius: 3.0, height: 1.9, spin: 14 },
];
const BUBBLE_FRAMES = 27; // W_bubble01..27.tga
const FRAME_MS = 55; // per-frame cadence
const BUBBLE_SIZE = 34; // sprite-px → world × UNITS_PER_PX

interface Bubble { mesh: Mesh; material: MeshBasicMaterial; positions: BufferAttribute; ring: number; idx: number; }

export class MaxLevelAuraEffect {
  private readonly group = new Group();
  private readonly bubbles: Bubble[] = [];
  private readonly rings: { mesh: Mesh; material: MeshBasicMaterial; dir: number }[] = [];
  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private readonly toCam = new Vector3();
  private readonly center = new Vector3();

  constructor(
    private readonly scene: Scene,
    bubbleFrames: (Texture | null)[], // the 27 W_bubble textures
    ringTextures: (Texture | null)[], // [cir0002, emp shock]
    private readonly color: [number, number, number],
    private readonly cellSize: number,
  ) {
    // Two flat ground rings (list 2), counter-rotating, additive, tier-tinted.
    ringTextures.forEach((tex, i) => {
      const geometry = new BufferGeometry();
      // prettier-ignore
      geometry.setAttribute("position", new BufferAttribute(new Float32Array([-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5]), 3));
      geometry.setAttribute("uv", new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
      geometry.setIndex([0, 1, 2, 0, 2, 3]);
      const size = (i === 0 ? 18 : 11) * GAME_TO_WORLD;
      const material = this.mat(tex);
      const mesh = new Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.renderOrder = 1;
      mesh.scale.set(size, 1, size);
      this.rings.push({ mesh, material, dir: i === 0 ? 1 : -1 });
      this.group.add(mesh);
    });

    // Bubble billboard rings (list 1), camera-facing, cycling the W_bubble frames.
    RINGS.forEach((ring, ri) => {
      for (let k = 0; k < ring.count; k++) {
        const geometry = new BufferGeometry();
        const positions = new BufferAttribute(new Float32Array(4 * 3), 3);
        positions.setUsage(35048 /* DynamicDrawUsage */);
        geometry.setAttribute("position", positions);
        geometry.setAttribute("uv", new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2));
        geometry.setIndex([0, 1, 2, 2, 1, 3]);
        const material = this.mat(bubbleFrames[k % BUBBLE_FRAMES] ?? null);
        const mesh = new Mesh(geometry, material);
        mesh.frustumCulled = false;
        mesh.renderOrder = 3;
        this.bubbles.push({ mesh, material, positions, ring: ri, idx: k });
        this.group.add(mesh);
      }
    });
    // stash the frames for animation
    this.frames = bubbleFrames;
    this.group.visible = false;
    scene.add(this.group);
  }

  private readonly frames: (Texture | null)[];
  private mat(tex: Texture | null): MeshBasicMaterial {
    const m = new MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false, depthTest: false, fog: false,
      side: DoubleSide, blending: AdditiveBlending,
    });
    m.color.setRGB(this.color[0], this.color[1], this.color[2]);
    return m;
  }

  update(elapsedMs: number, camera: PerspectiveCamera, anchor: Vector3): boolean {
    if (elapsedMs < 0) { this.group.visible = false; return true; }
    this.group.visible = true;
    this.group.position.copy(anchor);
    const cs = this.cellSize;
    const frame = Math.floor(elapsedMs / FRAME_MS);

    // Flat rings: spin about Y.
    for (const r of this.rings) r.mesh.rotation.y = (elapsedMs / 1000) * r.dir * 1.2;

    // Bubble rings: orbit + animate frames, billboarded.
    this.right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    const half = (BUBBLE_SIZE * UNITS_PER_PX * cs) / 2;
    for (const b of this.bubbles) {
      const ring = RINGS[b.ring];
      const ang = (b.idx / ring.count) * Math.PI * 2 + (elapsedMs / 1000) * (ring.spin * Math.PI) / 180;
      const rad = ring.radius * GAME_TO_WORLD * cs * 10; // ring radius (tiles-ish)
      // gentle bob so the ring breathes vertically
      const h = (ring.height + 0.25 * Math.sin(elapsedMs / 500 + b.idx)) * cs;
      this.center.set(anchor.x + MIRROR_X * Math.cos(ang) * rad, anchor.y + h, anchor.z + Math.sin(ang) * rad);
      const tex = this.frames[(frame + b.idx) % BUBBLE_FRAMES] ?? null;
      if (b.material.map !== tex) { b.material.map = tex; b.material.needsUpdate = true; }
      this.toCam.copy(camera.position).sub(this.center).normalize();
      const cx = [-half, half, -half, half];
      const cy = [half, half, -half, -half];
      const arr = b.positions.array as Float32Array;
      for (let i = 0; i < 4; i++) {
        arr[i * 3] = this.center.x + this.right.x * cx[i] + this.up.x * cy[i] + this.toCam.x * 2.5;
        arr[i * 3 + 1] = this.center.y + this.right.y * cx[i] + this.up.y * cy[i] + this.toCam.y * 2.5;
        arr[i * 3 + 2] = this.center.z + this.right.z * cx[i] + this.up.z * cy[i] + this.toCam.z * 2.5;
      }
      b.positions.needsUpdate = true;
    }
    return true;
  }

  dispose(): void {
    this.scene.remove(this.group);
    for (const r of this.rings) { r.material.dispose(); r.mesh.geometry.dispose(); }
    for (const b of this.bubbles) { b.material.dispose(); b.mesh.geometry.dispose(); }
  }
}
