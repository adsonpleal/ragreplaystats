// The level-99 aura's rising sparkles (EF_LEVEL99_3) — small blue whitelight
// bubbles that stream up from a high-level character's feet and fade. Port of
// roBrowser's Level99Bubble.js (MrAntares fork), spawned as
// `new Level99Bubble(pos, 'whitelight.tga', tick, 1)` (blue variant).
//
// roBrowser runs 16 particles (4 columns × 4 anchors): each starts at a random
// height y∈[0,99] game-units (hidden — y>0 is "underground" in its sign system),
// falls at 0.15/frame, is drawn only once y≤0 (i.e. above the ground in world
// space), fades by an alpha-vs-height ramp, and resets to a new random y at y<-30.
// That per-frame drift + random reset isn't scrub-safe, so each particle here gets
// a fixed seed and its height is a deterministic sawtooth of the recording clock;
// the horizontal jitter is a gentle deterministic sway growing with height. Same
// visual — a staggered stream of rising, fading blue motes — but scrub-safe.
//
// Sizes/heights are game-units → world via GAME_TO_WORLD × scaleMult (roBrowser).

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

const MIRROR_X = -1;
const GAME_TO_WORLD = 0.1 * 2.2;
const SCALE_MULT = 0.6;
const FRAME_MS = 1000 / 60;
const FALL_SPEED = 0.15; // game-units/frame
const SEED_MAX = 99;
const RESET_Y = -30;
const RANGE = SEED_MAX - RESET_Y; // 129 — full fall sweep
const RADIUS = 2.4 * GAME_TO_WORLD * SCALE_MULT; // billboard half-size (world)
const SWAY = 4; // horizontal wander amplitude (game-units) at full height
const NUM = 16;
// alpha(y) = clamp(250 + 30*(y+20), 0, 250)/255 — full at ground, gone by y≈-28.
const ALPHA_OFFSET = 20;
const ALPHA_GAIN = 30;

interface Particle {
  fallOffset: number; // stagger into the fall cycle
  swayPhaseX: number;
  swayPhaseZ: number;
  mesh: Mesh;
  material: MeshBasicMaterial;
  positions: BufferAttribute;
}

export class Level99BubbleEffect {
  private readonly group = new Group();
  private readonly particles: Particle[] = [];
  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private readonly toCam = new Vector3();
  private readonly center = new Vector3();

  constructor(
    private readonly scene: Scene,
    texture: Texture | null,
    private readonly cellSize: number,
  ) {
    for (let i = 0; i < NUM; i++) {
      const geometry = new BufferGeometry();
      const positions = new BufferAttribute(new Float32Array(4 * 3), 3);
      positions.setUsage(35048 /* DynamicDrawUsage */);
      geometry.setAttribute("position", positions);
      geometry.setAttribute("uv", new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2));
      geometry.setIndex([0, 1, 2, 2, 1, 3]);
      const material = new MeshBasicMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        depthTest: false, // rise over the sprite, like the swirl
        fog: false,
        side: DoubleSide,
        blending: AdditiveBlending,
      });
      material.color.setRGB(80 / 255, 80 / 255, 255 / 255); // blue variant
      const mesh = new Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.renderOrder = 3;
      mesh.visible = false;
      this.particles.push({
        fallOffset: Math.random() * RANGE,
        swayPhaseX: Math.random() * Math.PI * 2,
        swayPhaseZ: Math.random() * Math.PI * 2,
        mesh,
        material,
        positions,
      });
      this.group.add(mesh);
    }
    this.group.visible = false;
    scene.add(this.group);
  }

  /** Advance to `elapsedMs`; stream the rising bubbles at `anchor` (the feet).
   *  Persistent — the caller culls it when the actor vanishes. */
  update(elapsedMs: number, camera: PerspectiveCamera, anchor: Vector3): boolean {
    if (elapsedMs < 0) {
      this.group.visible = false;
      return true;
    }
    this.group.visible = true;
    const frame = elapsedMs / FRAME_MS;
    this.right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    const cs = this.cellSize;

    for (const p of this.particles) {
      // Deterministic fall: y sweeps 99 → -30 then wraps (roBrowser's fall + reset).
      const py = SEED_MAX - (((FALL_SPEED * frame + p.fallOffset) % RANGE + RANGE) % RANGE);
      if (py > 0) { p.mesh.visible = false; continue; } // still in the hidden window
      const alpha = Math.max(0, Math.min(250, 250 + ALPHA_GAIN * (py + ALPHA_OFFSET))) / 255;
      if (alpha <= 0.004) { p.mesh.visible = false; continue; }
      const progress = -py / -RESET_Y; // 0 at ground → 1 at top
      // World offset from the feet: rise (up) + a gentle sway that grows with height.
      const heightW = -py * GAME_TO_WORLD * SCALE_MULT * cs;
      const swayX = SWAY * progress * Math.sin(p.swayPhaseX + elapsedMs * 0.003) * GAME_TO_WORLD * SCALE_MULT * cs;
      const swayZ = SWAY * progress * Math.sin(p.swayPhaseZ + elapsedMs * 0.0027) * GAME_TO_WORLD * SCALE_MULT * cs;
      this.center.set(anchor.x + MIRROR_X * swayX, anchor.y + heightW, anchor.z + swayZ);

      p.mesh.visible = true;
      p.material.opacity = alpha;
      const r = RADIUS * cs;
      this.toCam.copy(camera.position).sub(this.center).normalize();
      const cx = [-r, r, -r, r];
      const cy = [r, r, -r, -r];
      const arr = p.positions.array as Float32Array;
      for (let k = 0; k < 4; k++) {
        arr[k * 3] = this.center.x + this.right.x * cx[k] + this.up.x * cy[k] + this.toCam.x * 2.5;
        arr[k * 3 + 1] = this.center.y + this.right.y * cx[k] + this.up.y * cy[k] + this.toCam.y * 2.5;
        arr[k * 3 + 2] = this.center.z + this.right.z * cx[k] + this.up.z * cy[k] + this.toCam.z * 2.5;
      }
      p.positions.needsUpdate = true;
    }
    return true;
  }

  dispose(): void {
    this.scene.remove(this.group);
    for (const p of this.particles) {
      p.material.dispose();
      p.mesh.geometry.dispose();
    }
  }
}
