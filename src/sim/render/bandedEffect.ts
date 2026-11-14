// Draws the band auras bandRecipes.ts describes: one or two texture sets of
// ribbon strips, standing round an actor's feet and rebuilt every frame from the
// recording clock (so scrubbing and pausing track, like every other renderer
// here).
//
// Geometry per band: a 20-quad strip, 21 foot points on the ground and 21 tops
// pushed up and outward along the band's lean. One Mesh per (set, band) so each
// band keeps its own alpha — the recipes fade the bands independently — with its
// set's texture, colour and blending on a shared-per-set material. How many a set
// can need is maxBandsInSet: eight for a one-texture aura, which draws both cone
// sets in its single pass, four for the three that filter by cone set. Bands come
// and go between frames (a bloomed cone restarts), so every mesh a set can need
// exists for the effect's life and the unused ones are just hidden.
//
// depthTest off, like SwirlingAuraEffect: the ribbons rise from the feet, so
// testing against the character sprite drawn just before culls the half behind it
// and the aura all but disappears. renderOrder 3 puts it over the sprite with the
// skill effects.

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  type PerspectiveCamera,
  type Scene,
  type Vector3,
} from "three";
import { UNITS_PER_PX } from "../sprite";
import {
  BAND_QUADS,
  auraColour,
  auraSetAdditive,
  auraTicks,
  bandedTicks,
  bandsInSet,
  maxBandsInSet,
  writeBandStrip,
} from "./bandRecipes";
import type { LoadedBanded } from "./effectAssets";

/** One client unit → world units: 7 screen pixels a unit (the client's own
 *  PIXELS_PER_UNIT) times UNITS_PER_PX, which is exactly 0.2. A 4.5-unit cast
 *  radius is therefore 0.9 world units, and a map cell is 1, so the aura is a
 *  little under two cells across — which is the size the gateway's CYLINDER row
 *  for the same aura (effect 12) draws. roBrowser's SwirlingAura reads the same
 *  bands at 3.9 units and then multiplies by its own 0.6 "inner circle" fudge;
 *  that fudge is roBrowser's, not the client's, and is deliberately not copied
 *  here. No cellSize: these are pixel-derived, not tile-derived, unlike every
 *  other renderer in this folder. */
const UNIT_TO_WORLD = 7 * UNITS_PER_PX;
/** See strEffect.ts — undo the scene's un-mirrored view. Invisible on the
 *  closed 360-degree bands, which is all but two of these auras; on Earth
 *  Grave's and Earth Drive's three open 315-degree arcs (1664, 1709) it decides
 *  which way they open and spin, and that has not been checked against a
 *  recording of the real client. Not a band-specific doubt: every world-space
 *  renderer in this folder mirrors x and leaves z alone, SwirlingAuraEffect —
 *  the same band primitive — included, so if the sign is wrong here it is wrong
 *  in all of them. */
const MIRROR_X = -1;
/** One client tick. */
const TICK_MS = 16;
const POINTS = BAND_QUADS + 1;

interface BandMesh {
  mesh: Mesh;
  material: MeshBasicMaterial;
  positions: BufferAttribute;
}

export class BandedEffect {
  private readonly group = new Group();
  private readonly sets: BandMesh[][] = [];

  /** Its whole run in ticks: a cast aura runs the cast, floored at the minimum
   *  the client gives its kind; anything else runs its own length. */
  private readonly ticks: number;

  /** Meshes per texture set — see maxBandsInSet. */
  private readonly perSet: number;

  constructor(
    private readonly scene: Scene,
    private readonly banded: LoadedBanded,
    durationMs = 0,
  ) {
    this.ticks =
      durationMs > 0 ? auraTicks(banded.effect, durationMs) : bandedTicks(banded.effect);
    this.perSet = maxBandsInSet(banded.effect);
    // Static index + uv for a 21-point strip. u = s/21 (the client's own divisor,
    // which leaves the last 1/21 of the picture unused rather than stretching it
    // to the seam); v runs 0 at the foot to 1 at the top.
    const uv = new Float32Array(POINTS * 2 * 2);
    const idx: number[] = [];
    for (let s = 0; s < POINTS; s++) {
      uv[s * 4] = s / 21;
      uv[s * 4 + 1] = 0; // foot
      uv[s * 4 + 2] = s / 21;
      uv[s * 4 + 3] = 1; // top
    }
    for (let s = 0; s < BAND_QUADS; s++) {
      const i0 = s * 2;
      idx.push(i0, i0 + 1, i0 + 2, i0 + 1, i0 + 3, i0 + 2);
    }
    for (let set = 0; set < banded.textures.length; set++) {
      const additive = auraSetAdditive(banded.effect, set);
      const bands: BandMesh[] = [];
      for (let band = 0; band < this.perSet; band++) {
        const material = new MeshBasicMaterial({
          map: banded.textures[set][0] ?? null,
          transparent: true,
          depthWrite: false,
          depthTest: false,
          fog: false,
          side: DoubleSide,
          blending: additive ? AdditiveBlending : NormalBlending,
        });
        const geometry = new BufferGeometry();
        const positions = new BufferAttribute(new Float32Array(POINTS * 2 * 3), 3);
        positions.setUsage(35048 /* DynamicDrawUsage */);
        geometry.setAttribute("position", positions);
        geometry.setAttribute("uv", new BufferAttribute(uv.slice(), 2));
        geometry.setIndex(idx.slice());
        const mesh = new Mesh(geometry, material);
        mesh.frustumCulled = false;
        mesh.renderOrder = 3;
        mesh.visible = false;
        this.group.add(mesh);
        bands.push({ mesh, material, positions });
      }
      this.sets.push(bands);
    }
    scene.add(this.group);
  }

  /** Advance to `elapsedMs` and rebuild the bands at `anchor`. Returns false once
   *  the aura's ticks are spent, which disposes it. `loop` restarts the recipe
   *  rather than ending it — a sustained cast aura whose cast outlasts the ticks
   *  the client gives its kind. */
  update(elapsedMs: number, _camera: PerspectiveCamera, anchor: Vector3, loop = false): boolean {
    if (elapsedMs < 0) {
      this.group.visible = false;
      return true;
    }
    const { effect } = this.banded;
    const ticks = this.ticks;
    let age = Math.floor(elapsedMs / TICK_MS);
    if (age >= ticks) {
      if (!loop) return false;
      age %= ticks;
    }
    this.group.visible = true;
    this.group.position.copy(anchor);
    for (let set = 0; set < this.sets.length; set++) {
      const shaped = bandsInSet(effect, ticks, age, set);
      const [r, g, b] = auraColour(effect, set, age);
      const frames = this.banded.textures[set];
      // The bubble cast's picture moves on every tick; every other set has one.
      const texture = frames.length > 1 ? frames[(age + 1) % frames.length] : frames[0];
      for (let band = 0; band < this.perSet; band++) {
        const target = this.sets[set][band];
        const next = shaped[band];
        // A band that is gone, or that the recipe has faded to nothing, costs a
        // draw call for an invisible quad otherwise.
        if (!next || next.band.alpha <= 0) {
          target.mesh.visible = false;
          continue;
        }
        target.mesh.visible = true;
        target.material.map = texture ?? null;
        target.material.color.setRGB(r / 255, g / 255, b / 255);
        target.material.opacity = Math.min(next.band.alpha, 255) / 255;
        writeBandStrip(
          next.band,
          next.heights,
          target.positions.array as Float32Array,
          UNIT_TO_WORLD,
          MIRROR_X,
        );
        target.positions.needsUpdate = true;
      }
    }
    return true;
  }

  dispose(): void {
    this.scene.remove(this.group);
    for (const set of this.sets) {
      for (const b of set) {
        b.mesh.geometry.dispose();
        b.material.dispose();
      }
    }
  }
}
