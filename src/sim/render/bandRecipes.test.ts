import { describe, expect, it } from "vitest";

import {
  BAND_EFFECTS,
  BAND_QUADS,
  BUBBLE_CAST_EFFECT,
  BUBBLE_TEXTURES,
  auraColour,
  auraLook,
  auraSetAdditive,
  auraSetTexture,
  auraSets,
  auraTicks,
  MAX_BANDS_PER_SET,
  bandPoints,
  bandedTicks,
  bandsAt,
  bandsInSet,
  bloom,
  bloomHeight,
  bloomSets,
  earthSheetRim,
  earthTurning,
  isBloom,
  turning,
  turningHeight,
  writeBandStrip,
} from "./bandRecipes";

// The client builds its cast auras out of bands, and the whole look is in the
// numbers: how fast a cone widens, when it has faded enough to start over, how
// its top waves. These pin that arithmetic, since a wrong constant here shows up
// as an aura that never appears or never leaves rather than as an error.

const COUPLE = 342; // a plain two-set bloom, used as the generic case
const CLEARANCE = 1560;
const TETRA = 805;
const EARTH = 1664;
const AURA_BLADE = 367;

describe("the effects this module claims", () => {
  it("has a look for every one of them", () => {
    for (const id of BAND_EFFECTS) expect(auraLook(id), `effect ${id}`).not.toBeNull();
  });

  it("leaves out the four whose texture the gateway has no file for", () => {
    // Jack Frost's cast (ring_ice) and the three ABR casts. An aura drawn with
    // the wrong picture is worse than one that stays dark.
    for (const id of [1449, 1902, 1910, 1918]) expect(BAND_EFFECTS).not.toContain(id);
  });

  it("claims no effect the gateway already draws", () => {
    // The elemental cast auras and Heal's/the teleport's walls have CYLINDER
    // rows; this module must not shadow them.
    for (const id of [12, 54, 55, 56, 57, 58, 59, 304, 312, 313, 314, 315, 320, 325, 454])
      expect(BAND_EFFECTS).not.toContain(id);
  });
});

describe("bloom", () => {
  it("starts a long cast's cone bright and shrinking", () => {
    // Age 0 of a 100-tick aura: the cone is already past radius 4, so it is
    // losing 3 alpha a tick from the 180 its band starts at, not gaining.
    const b = bloom(COUPLE, 0, 0, 100, 0)!;
    expect(b).toMatchObject({ arc: 360, turn: 180, lean: 79, alpha: 177, height: 20 });
    expect(b.radius).toBeCloseTo(4.17, 10);
  });

  it("gives the second set its own dimmer start", () => {
    expect(bloom(COUPLE, 1, 0, 100, 0)!.alpha).toBe(157); // 160 - 3
  });

  it("blooms the cone again once it has faded out", () => {
    // 180 alpha at -3 a tick runs out on tick 59, and with 30+ ticks still to
    // run the cone restarts at radius 3.37 leaning 74 — below radius 4, so it
    // now GAINS 10 a tick.
    expect(bloom(COUPLE, 0, 0, 100, 59)).toBeNull();
    const again = bloom(COUPLE, 0, 0, 100, 60)!;
    expect(again).toMatchObject({ lean: 73, alpha: 10 });
    expect(again.radius).toBeCloseTo(3.44, 10);
  });

  it("stops restarting when the aura is nearly over", () => {
    // Same cone, but in an aura of 80: at tick 59 there are only 21 ticks left,
    // under the 30 the client wants, so it stays gone for good.
    expect(bloom(COUPLE, 0, 0, 80, 59)).toBeNull();
    expect(bloom(COUPLE, 0, 0, 80, 70)).toBeNull();
    expect(bloom(COUPLE, 0, 0, 80, 79)).toBeNull();
  });

  it("staggers the four cones of a short cast and starts them dark", () => {
    // A 56-tick cast (the floor for most): every band starts at alpha 0 and
    // band k five ticks late, so the cones bloom in sequence.
    expect(bloom(COUPLE, 0, 0, 56, 0)).toBeNull();
    expect(bloom(COUPLE, 0, 0, 56, 1)!.alpha).toBe(10);
    for (const age of [0, 1, 2, 3, 4]) expect(bloom(COUPLE, 0, 1, 56, age)).toBeNull();
    expect(bloom(COUPLE, 0, 1, 56, 6)!.alpha).toBe(10);
  });

  it("gains slower and restarts lower for Clearance, and stands its cones 5 lower", () => {
    expect(bloom(CLEARANCE, 0, 0, 56, 1)!.alpha).toBe(5);
    expect(bloom(CLEARANCE, 0, 0, 56, 1)!.lean).toBe(63); // restarted at 64, then −1
    expect(bloom(CLEARANCE, 0, 0, 100, 0)!.height).toBe(15); // vs 20
  });

  it("stands the bubble cast's cones 10 higher", () => {
    expect(bloom(BUBBLE_CAST_EFFECT, 0, 0, 100, 0)!.height).toBe(30);
  });

  it("turns the four cones to the four quarters", () => {
    const turns = [0, 1, 2, 3].map((band) => bloom(COUPLE, 0, band, 100, 0)!.turn);
    expect(turns).toEqual([180, 270, 0, 90]);
  });
});

describe("bloomHeight", () => {
  it("leaves the ends of the cone at its plain height and waves the middle", () => {
    // sin 9s is 0 at s = 0 and s = 20, so the wave only moves the rim between.
    expect(bloomHeight(0, 10, 30, 0)).toBeCloseTo(10, 10);
    expect(bloomHeight(0, 10, 30, 20)).toBeCloseTo(10, 10);
    expect(bloomHeight(0, 10, 90, 10)).toBeCloseTo(13, 10); // 10 × (1 + 0.3 × 1 × 1)
  });

  it("waves the back two cones at twice the rate", () => {
    // Cone 0's rim takes 180 ticks to go from its peak to its trough; cone 2's
    // takes 90, because its angle advances twice as fast.
    expect(bloomHeight(0, 10, 90, 10)).toBeCloseTo(13, 10);
    expect(bloomHeight(0, 10, 270, 10)).toBeCloseTo(7, 10);
    expect(bloomHeight(2, 10, 135, 10)).toBeCloseTo(13, 10);
    expect(bloomHeight(2, 10, 45, 10)).toBeCloseTo(7, 10);
  });

  it("offsets the front two cones from each other by a quarter turn", () => {
    expect(bloomHeight(1, 10, 0, 10)).toBeCloseTo(bloomHeight(0, 10, 90, 10), 10);
  });
});

describe("turning", () => {
  it("opens the three arcs 315 degrees and spins them 3, 4 and 5 a tick", () => {
    const arcs = [0, 1, 2].map((band) => turning(band, 100, 10));
    expect(arcs.map((b) => b.arc)).toEqual([315, 315, 315]);
    expect(arcs.map((b) => b.turn)).toEqual([30, 90 + 40, 180 + 50]);
    expect(arcs.map((b) => b.radius)).toEqual([4.5, 5, 5.5]);
    expect(arcs.map((b) => b.lean)).toEqual([70, 57, 45]);
  });

  it("stands a faint closed column behind them, dimmer after the first tick", () => {
    expect(turning(3, 100, 0)).toMatchObject({ arc: 360, radius: 4, height: 250, alpha: 70 });
    expect(turning(3, 100, 1).alpha).toBe(60);
  });

  it("fades everything over the last 40 ticks", () => {
    expect(turning(0, 100, 60).alpha).toBe(180); // fading starts AT 60
    expect(turning(0, 100, 70).alpha).toBe(130); // 10 ticks × 5
    expect(turning(0, 100, 99).alpha).toBe(0);
    expect(turning(3, 100, 90).alpha).toBe(0); // the column loses 2 a tick from 60
  });
});

describe("turningHeight", () => {
  it("humps the arc in the middle and rises over the first 90 ticks", () => {
    expect(turningHeight(0, 10, 90, 0)).toBeCloseTo(0, 10);
    expect(turningHeight(0, 10, 90, 10)).toBeCloseTo(10, 10);
    expect(turningHeight(0, 10, 90, 20)).toBeCloseTo(0, 10);
    expect(turningHeight(0, 10, 30, 10)).toBeCloseTo(5, 10); // sin 30
    // Held at full once past 90, not folded back down by sin.
    expect(turningHeight(0, 10, 200, 10)).toBeCloseTo(10, 10);
  });
});

describe("Earth Grave's and Earth Drive's casts", () => {
  it("is not treated as a bloom", () => {
    expect(isBloom(EARTH)).toBe(false);
    expect(isBloom(1709)).toBe(false);
    expect(isBloom(COUPLE)).toBe(true);
  });

  it("ramps the sheet from 70 to 100 over its first 20 ticks", () => {
    expect(earthTurning(3, 1000, 0).alpha).toBe(78);
    expect(earthTurning(3, 1000, 19).alpha).toBe(100);
    expect(earthTurning(3, 1000, 99).alpha).toBe(100);
  });

  it("keeps the arcs' own alpha curve", () => {
    expect(earthTurning(0, 1000, 10).alpha).toBe(180);
  });

  it("breathes the sheet's rim after the first 90 ticks instead of holding it", () => {
    expect(earthSheetRim(90)).toBeCloseTo(1, 10);
    expect(earthSheetRim(90 + 360)).toBeCloseTo(1, 10);
    expect(earthSheetRim(360)).toBeCloseTo(0.55, 10); // sin 0
    expect(earthSheetRim(270)).toBeCloseTo(0.1, 10); // sin 270 = −1
  });
});

describe("the texture sets", () => {
  it("gives Aura Blade's second set its own picture", () => {
    expect(auraSets(AURA_BLADE)).toBe(2);
    expect(auraSetTexture(AURA_BLADE, 0)).toBe("ring_white.tga");
    expect(auraSetTexture(AURA_BLADE, 1)).toBe("ring_yellow.tga");
  });

  it("adds the bubble cast's first set on and blends its second", () => {
    expect(auraSets(BUBBLE_CAST_EFFECT)).toBe(2);
    expect(auraSetAdditive(BUBBLE_CAST_EFFECT, 0)).toBe(true);
    expect(auraSetAdditive(BUBBLE_CAST_EFFECT, 1)).toBe(false);
    expect(auraColour(BUBBLE_CAST_EFFECT, 0, 0)).toEqual([100, 100, 255]);
    expect(auraColour(BUBBLE_CAST_EFFECT, 1, 0)).toEqual([255, 255, 255]);
  });

  it("cycles 27 bubble pictures, one a tick", () => {
    expect(BUBBLE_TEXTURES).toHaveLength(27);
    expect(BUBBLE_TEXTURES[0]).toBe("W_bubble01.tga");
    expect(BUBBLE_TEXTURES[26]).toBe("W_bubble27.tga");
  });

  it("draws one set for everything else", () => {
    expect(auraSets(COUPLE)).toBe(1);
    expect(auraSetTexture(COUPLE, 0)).toBe("ring_red.tga");
  });

  it("still makes both sets of CONES for a one-texture aura", () => {
    // Two different things both called "set": the texture passes (auraSets) and
    // the two groups of four cones (bloomSets). A one-texture aura draws all
    // eight cones in one pass — a renderer that sizes a pass for four throws
    // half of every such aura away.
    expect(auraSets(COUPLE)).toBe(1);
    expect(bloomSets(COUPLE)).toBe(2);
    expect(bandsInSet(COUPLE, 100, 0, 0)).toHaveLength(8);
    expect(bloomSets(1418)).toBe(1); // Comet's: only the first four
    expect(bandsAt(1418, 100, 0)).toHaveLength(4);
  });

  it("never hands back more bands than a renderer sizes itself for", () => {
    let most = 0;
    for (const id of BAND_EFFECTS) {
      for (const ticks of [56, 60, 70, 100, 312]) {
        for (let age = 0; age < ticks; age++) {
          for (let set = 0; set < auraSets(id); set++) {
            most = Math.max(most, bandsInSet(id, ticks, age, set).length);
          }
        }
      }
    }
    expect(most).toBe(MAX_BANDS_PER_SET);
  });

  it("splits a two-texture aura's cones between its passes", () => {
    expect(bandsInSet(AURA_BLADE, 100, 0, 0)).toHaveLength(4);
    expect(bandsInSet(AURA_BLADE, 100, 0, 1)).toHaveLength(4);
  });
});

describe("auraColour", () => {
  it("cycles Tetra Vortex's cast through four colours, 25 ticks each", () => {
    expect(auraColour(TETRA, 0, 0)).toEqual([0x64, 0x64, 0xff]);
    expect(auraColour(TETRA, 0, 24)).toEqual([0xff, 0x64, 0x64]);
    expect(auraColour(TETRA, 0, 49)).toEqual([0x64, 0xff, 0x64]);
    expect(auraColour(TETRA, 0, 74)).toEqual([0xff, 0xff, 0xaa]);
    expect(auraColour(TETRA, 0, 99)).toEqual([0x64, 0x64, 0xff]);
  });

  it("lightens Maelstrom's second set", () => {
    expect(auraColour(1556, 0, 0)).toEqual([0x0a, 0x42, 0x72]);
    expect(auraColour(1556, 1, 0)).toEqual([0x23, 0x92, 0xb9]);
  });

  it("holds every other aura's colour steady", () => {
    expect(auraColour(COUPLE, 0, 0)).toEqual(auraColour(COUPLE, 0, 70));
  });
});

describe("how long an aura runs", () => {
  it("runs the cast, but never under the floor for its kind", () => {
    expect(auraTicks(COUPLE, 5000)).toBe(312); // the cast itself
    expect(auraTicks(COUPLE, 100)).toBe(56); // the short-cast floor
    expect(auraTicks(EARTH, 100)).toBe(70); // the turning floor
    expect(auraTicks(BUBBLE_CAST_EFFECT, 100)).toBe(100);
    expect(auraTicks(564, 100)).toBe(60); // the homunculus cast
  });

  it("floors Aura Blade at 70 even though it blooms", () => {
    // The client's 56-tick list and its blooming auras are nearly the same set
    // but not the same set, and 367 is where they part. Deriving one from the
    // other is a divergence that only shows up on a cast long enough to matter.
    expect(isBloom(AURA_BLADE)).toBe(true);
    expect(auraTicks(AURA_BLADE, 100)).toBe(70);
  });

  it("gives a band effect that is not a cast its own length", () => {
    expect(bandedTicks(AURA_BLADE)).toBe(60);
    expect(bandedTicks(COUPLE)).toBe(100);
  });
});

describe("bandPoints", () => {
  const band = { arc: 360, turn: 0, radius: 4, lean: 90, height: 10, alpha: 180 };
  const flat = Array.from({ length: BAND_QUADS + 1 }, () => 10);

  it("walks the arc in 21 points", () => {
    expect(bandPoints(band, flat)).toHaveLength(21);
  });

  it("closes a 360-degree band back on its first point", () => {
    const p = bandPoints(band, flat);
    expect(p[20].foot[0]).toBeCloseTo(p[0].foot[0], 10);
    expect(p[20].foot[2]).toBeCloseTo(p[0].foot[2], 10);
  });

  it("points the first foot due north", () => {
    const [first] = bandPoints(band, flat);
    expect(first.foot[0]).toBeCloseTo(0, 10);
    expect(first.foot[2]).toBeCloseTo(4, 10);
  });

  it("sends an upright band straight up and a flat one straight out", () => {
    const up = bandPoints(band, flat)[0];
    expect(up.top[1]).toBeCloseTo(10, 10);
    expect(up.top[2]).toBeCloseTo(4, 10); // no outward lean

    const lying = bandPoints({ ...band, lean: 0 }, flat)[0];
    expect(lying.top[1]).toBeCloseTo(0, 10);
    expect(lying.top[2]).toBeCloseTo(14, 10); // radius + height, all outward
  });

  it("keeps the feet on the ground whatever the height profile", () => {
    const wavy = bandPoints(band, flat.map((h, s) => h * s));
    expect(wavy.every((p) => p.foot[1] === 0)).toBe(true);
  });
});

describe("writeBandStrip", () => {
  // The per-frame form of bandPoints, writing straight into a GPU buffer. The
  // two have to agree, which is the whole reason the slow readable one is kept.
  const band = { arc: 315, turn: 37, radius: 4.5, lean: 70, height: 25, alpha: 180 };
  const heights = Array.from({ length: BAND_QUADS + 1 }, (_, s) => 10 + s);

  it("writes the same points bandPoints builds", () => {
    const out = new Float32Array((BAND_QUADS + 1) * 2 * 3);
    const written = writeBandStrip(band, heights, out);
    expect(written).toBe(out.length);
    const expected = bandPoints(band, heights).flatMap((p) => [...p.foot, ...p.top]);
    for (let i = 0; i < expected.length; i++) expect(out[i]).toBeCloseTo(expected[i], 5);
  });

  it("applies the caller's scale and x mirror", () => {
    const plain = new Float32Array((BAND_QUADS + 1) * 2 * 3);
    const scaled = new Float32Array(plain.length);
    writeBandStrip(band, heights, plain);
    writeBandStrip(band, heights, scaled, 0.2, -1);
    for (let i = 0; i < plain.length; i += 3) {
      expect(scaled[i]).toBeCloseTo(-plain[i] * 0.2, 5);
      expect(scaled[i + 1]).toBeCloseTo(plain[i + 1] * 0.2, 5);
      expect(scaled[i + 2]).toBeCloseTo(plain[i + 2] * 0.2, 5);
    }
  });
});
