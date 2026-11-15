// The renderer's side of the band bound. bandRecipes.test.ts pins what the
// recipe HANDS BACK; this pins that the renderer actually draws all of it.
// Those are different bugs: shipping a renderer that sized a texture set for
// four bands while the recipe handed back eight left 18 of the 25 auras drawing
// half their cones, and because `bandsAt` compacts its result the survivors
// shifted about as others faded and restarted — so it read as a wrong animation
// rather than as missing geometry. Type-checking and the recipe's own tests were
// both green through all of it.

import { type Mesh, PerspectiveCamera, Scene, Vector3 } from "three";
import { describe, expect, it } from "vitest";

import type { LoadedBanded } from "./effectAssets";
import {
  BAND_EFFECTS,
  BUBBLE_CAST_EFFECT,
  MAX_BANDS_PER_SET,
  auraSets,
  auraTicks,
  bandedTicks,
  bandsInSet,
  maxBandsInSet,
} from "./bandRecipes";
import { BandedEffect } from "./bandedEffect";

/** A BandedEffect on its own scene, plus the meshes it put there. No textures:
 *  every assertion here is about which meshes are visible, and a null map
 *  changes nothing about that. */
function stage(effect: number, durationMs: number) {
  const scene = new Scene();
  const frames = effect === BUBBLE_CAST_EFFECT ? 27 : 1;
  const banded: LoadedBanded = {
    effect,
    textures: Array.from({ length: auraSets(effect) }, () =>
      Array.from({ length: frames }, () => null),
    ),
  };
  const aura = new BandedEffect(scene, banded, durationMs);
  const camera = new PerspectiveCamera();
  const anchor = new Vector3();
  const meshes = scene.children.flatMap((c) => c.children as Mesh[]);
  return {
    meshes,
    ticks: durationMs > 0 ? auraTicks(effect, durationMs) : bandedTicks(effect),
    at(age: number) {
      aura.update(age * 16, camera, anchor, false);
      return meshes.filter((m) => m.visible).length;
    },
    dispose: () => aura.dispose(),
  };
}

/** What the recipe says should be on screen at this moment. */
function expected(effect: number, ticks: number, age: number): number {
  let n = 0;
  for (let set = 0; set < auraSets(effect); set++) {
    n += bandsInSet(effect, ticks, age, set).filter((b) => b.band.alpha > 0).length;
  }
  return n;
}

describe("BandedEffect", () => {
  it("builds exactly the meshes a texture set can need", () => {
    for (const effect of BAND_EFFECTS) {
      const s = stage(effect, 5000);
      expect(s.meshes).toHaveLength(auraSets(effect) * maxBandsInSet(effect));
      s.dispose();
    }
    // Both arms of maxBandsInSet are exercised by that sweep.
    expect(new Set(BAND_EFFECTS.map(maxBandsInSet))).toEqual(
      new Set([MAX_BANDS_PER_SET, MAX_BANDS_PER_SET / 2]),
    );
  });

  it("draws every band the recipe hands back, at every age", () => {
    // Both paths: a short cast, where the cones start staggered, and a long one,
    // where they bloom and restart.
    for (const effect of BAND_EFFECTS) {
      for (const durationMs of [0, 900, 5000]) {
        const s = stage(effect, durationMs);
        for (let age = 0; age < s.ticks; age++) {
          expect(s.at(age), `effect ${effect} at ${durationMs} ms, tick ${age}`).toBe(
            expected(effect, s.ticks, age),
          );
        }
        s.dispose();
      }
    }
  });

  it("shows all eight cones of a one-texture aura", () => {
    // The regression itself, named: 342 is a one-texture bloom, so its single
    // pass carries both cone sets.
    const s = stage(342, 5000);
    expect(auraSets(342)).toBe(1);
    expect(s.meshes).toHaveLength(MAX_BANDS_PER_SET);
    expect(s.at(20)).toBe(MAX_BANDS_PER_SET);
    s.dispose();
  });

  it("ends when its ticks are spent, and loops instead when asked", () => {
    const scene = new Scene();
    const banded: LoadedBanded = { effect: 342, textures: [[null]] };
    const aura = new BandedEffect(scene, banded, 900);
    const camera = new PerspectiveCamera();
    const anchor = new Vector3();
    const ticks = auraTicks(342, 900);
    expect(aura.update((ticks - 1) * 16, camera, anchor, false)).toBe(true);
    expect(aura.update(ticks * 16, camera, anchor, false)).toBe(false);
    // A cast that outlasts the ticks the client gives its kind runs on.
    expect(aura.update(ticks * 16 * 3, camera, anchor, true)).toBe(true);
    aura.dispose();
  });
});
