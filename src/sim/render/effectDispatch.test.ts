import { beforeAll, describe, expect, it, vi } from "vitest";

// The module resolves its URL through the db manifest (which fetches
// /db-manifest.json in the app). Short-circuit it so the only fetch the test
// stubs is the table itself.
vi.mock("../../db/manifest", () => ({
  dbUrl: async (name: string) => `/db/${name}`,
}));

import {
  castAlongside,
  castAura,
  casterEffect,
  effectLengthMs,
  hitEffects,
  isSustainedCastAura,
  preloadEffectDispatch,
  sideEffects,
  unitVisual,
} from "./effectDispatch";

/**
 * A miniature of public/db/effect-dispatch.json. The ids are the real ones —
 * 12 is EF_BEGINSPELL, 16 is Bash's burst, 54-59 the elemental cast auras — so a
 * reader can check these expectations against the client's own behaviour.
 */
const TABLE = {
  _source: { repo: "test", commit: "0", file: "effects.txt", license: "MIT" },
  castAuras: [12, 54, 56, 55, 57, 59, 58, 12, 12, 12],
  // A slice of the real set: the neutral/elemental ones plus 441, a per-school
  // aura that is fixed (not element-tinted) yet still sustained.
  castAuraEffects: [12, 54, 55, 56, 57, 58, 59, 441],
  defaultCaster: 16,
  noCasterEffect: [[5401, 5507]],
  // 5 = Bash: two hit effects. 100 = a row whose second effect is suppressed,
  // 101 = one whose FIRST is (the shape of skills 129/534/2307 in the real
  // table, and the reason the pair keeps its positions).
  hit: { 5: [0, 1], 100: [49, null], 101: [null, 49] },
  // 2237 = Arrow Storm: element-tinted aura. 300 = a fixed aura. 400 = none.
  // 500 = an aura plus two effects starting alongside it.
  cast: { 2237: [12], 300: [441], 400: [null], 500: [12, 805, 1277] },
  // 2237 shows nothing on its caster; 600 shows a specific effect.
  caster: { 2237: null, 600: 144 },
  used: { 700: [["c", 58]], 701: [["t", 37], ["c", 42]] },
  struck: { 800: [["c", 750], ["t", 666]] },
  ground: { 900: [["g", 235], ["c", 12]] },
  length: { 25: 40, 215: 500 },
  // Ground units, keyed by unit TYPE rather than by skill. Every row here is
  // the real one, and between them they cover each shape the table has:
  //   127  MG_FIREWALL's unit — an effect that RESTARTS while the wall stands
  //   131  PR_SANCTUARY's — laid down once and left to stand
  //   145  HT_ANKLESNARE's — a model, no effect, and the one type the server
  //        ever hides from a viewer
  //   148  a model that ALSO shows an effect (one of exactly two such types)
  //   245  an area type: the effect covers the whole area, lifted off the ground
  unit: { 127: 25, 131: 319, 148: 145 },
  unitOnce: [131],
  unitModel: { 145: "외부소품\\트랩01", 148: "외부소품\\트랩03_6" },
  unitArea: { 245: [959, 20] },
};

beforeAll(async () => {
  vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => TABLE }));
  await preloadEffectDispatch();
});

describe("cast auras", () => {
  it("tints a `12` row by the cast's element", () => {
    // The client's table: 0 neutral, 1 water, 2 earth, 3 fire, 4 wind, 5 poison,
    // 6 holy. Anything past the table falls back to neutral.
    expect(castAura(2237, 0)).toBe(12);
    expect(castAura(2237, 1)).toBe(54);
    expect(castAura(2237, 3)).toBe(55);
    expect(castAura(2237, 6)).toBe(58);
    expect(castAura(2237, 99)).toBe(12);
  });

  it("leaves a non-12 row fixed whatever the element", () => {
    expect(castAura(300, 0)).toBe(441);
    expect(castAura(300, 4)).toBe(441);
  });

  it("shows nothing for a `-1` row", () => {
    expect(castAura(400)).toBeNull();
  });

  it("falls back to the client's default burst for an unlisted skill", () => {
    expect(castAura(12345)).toBe(16);
  });

  it("shows nothing for the newest jobs' skills", () => {
    // 5401-5507 is one of the client's no-caster-effect ranges, inclusive at
    // BOTH ends — an off-by-one here silently un-suppresses a whole job.
    expect(castAura(5450)).toBeNull();
    expect(castAura(5401)).toBeNull();
    expect(castAura(5507)).toBeNull();
    expect(castAura(5400)).toBe(16); // just below it
    expect(castAura(5508)).toBe(16); // just above it
  });

  it("falls back to the default burst for skill 0", () => {
    // Skill 0 is an auto-attack. The table has no row for it, so it inherits
    // the default like any unlisted skill — which is exactly why the caller
    // must not run the cast/caster dispatch for a plain swing.
    expect(castAura(0)).toBe(16);
    expect(casterEffect(0)).toBe(16);
  });

  it("knows which auras are sustained for a whole cast", () => {
    // The bands loop while the bar fills; Bash's burst is a single pop. 441 is
    // a fixed aura that is nonetheless sustained — being element-tinted and
    // being sustained are different properties.
    expect(isSustainedCastAura(12)).toBe(true);
    expect(isSustainedCastAura(58)).toBe(true);
    expect(isSustainedCastAura(441)).toBe(true);
    expect(isSustainedCastAura(16)).toBe(false);
  });

  it("reports the effects that start alongside an aura", () => {
    expect(castAlongside(500)).toEqual([805, 1277]);
    expect(castAlongside(2237)).toEqual([]);
    expect(castAlongside(12345)).toEqual([]);
  });
});

describe("caster effects", () => {
  it("distinguishes an explicit none from an absent row", () => {
    // This is the whole point of keeping `-1` in the data: 2237 opts out of the
    // default burst, while an unlisted skill inherits it.
    expect(casterEffect(2237)).toBeNull();
    expect(casterEffect(12345)).toBe(16);
  });

  it("uses a specific effect where the table names one", () => {
    expect(casterEffect(600)).toBe(144);
  });

  it("shows nothing for the newest jobs' skills", () => {
    expect(casterEffect(5450)).toBeNull();
  });
});

describe("hit effects", () => {
  it("returns the pair in table order", () => {
    expect(hitEffects(5)).toEqual([0, 1]);
  });

  it("keeps a suppressed effect in its own position, either side", () => {
    // The two are not interchangeable in the client (the first plays on every
    // hit, the second only on the first), so compacting the pair would lose
    // which is which the moment anyone implements per-hit timing.
    expect(hitEffects(100)).toEqual([49, null]);
    expect(hitEffects(101)).toEqual([null, 49]);
  });

  it("returns null for an unlisted skill so the caller can fall back", () => {
    // A null here is what makes the gateway's own hitEffectId the fallback; an
    // empty array would wrongly mean "the client shows nothing".
    expect(hitEffects(12345)).toBeNull();
    expect(hitEffects(0)).toBeNull();
  });
});

describe("side effects", () => {
  it("splits used/struck/ground rows by side", () => {
    expect(sideEffects("used", 700)).toEqual({ caster: [58], target: [], ground: [] });
    expect(sideEffects("used", 701)).toEqual({ caster: [42], target: [37], ground: [] });
    expect(sideEffects("struck", 800)).toEqual({ caster: [750], target: [666], ground: [] });
    expect(sideEffects("ground", 900)).toEqual({ caster: [12], target: [], ground: [235] });
  });

  it("is empty for an unlisted skill", () => {
    expect(sideEffects("struck", 12345)).toEqual({ caster: [], target: [], ground: [] });
  });
});

describe("effect lengths", () => {
  it("converts the client's 16 ms ticks to ms", () => {
    expect(effectLengthMs(25)).toBe(40 * 16);
    expect(effectLengthMs(215)).toBe(500 * 16);
  });

  it("returns null when the table says nothing", () => {
    expect(effectLengthMs(12345)).toBeNull();
  });
});

describe("before the table has loaded", () => {
  // The fetch is kicked off at map-open and a few early casts can drain before
  // it lands. The documented contract is that every accessor then behaves as if
  // the table were empty — not that it throws, and not that it invents a
  // default it cannot know applies.
  it("reports nothing rather than throwing", async () => {
    vi.resetModules();
    const fresh = await import("./effectDispatch");
    expect(fresh.castAura(2237)).toBeNull();
    expect(fresh.casterEffect(2237)).toBeNull();
    expect(fresh.hitEffects(5)).toBeNull();
    expect(fresh.castAlongside(500)).toEqual([]);
    expect(fresh.isSustainedCastAura(12)).toBe(false);
    expect(fresh.sideEffects("used", 700)).toEqual({ caster: [], target: [], ground: [] });
    expect(fresh.effectLengthMs(25)).toBeNull();
  });
});

describe("ground units", () => {
  it("reads the restarting kind as a looping cell effect", () => {
    // A Fire Wall's flame: the client restarts it for as long as the wall is
    // there, so `once` false is what tells the caller to loop it.
    expect(unitVisual(127)).toEqual({ effectId: 25, once: false, areaLift: null, model: null });
  });

  it("flags the kind that is laid down once", () => {
    expect(unitVisual(131)).toEqual({ effectId: 319, once: true, areaLift: null, model: null });
  });

  it("gives a model-only type its model and no effect", () => {
    // 21 of the 23 model types look like this. The caller draws nothing until a
    // gateway route can serve a model by path — but it must be able to tell
    // "this unit is a model we cannot fetch" from "this unit is not in the
    // table", because the second falls back to the skill and the first must not.
    expect(unitVisual(145)).toEqual({
      effectId: null,
      once: false,
      areaLift: null,
      model: "외부소품\\트랩01",
    });
  });

  it("carries both parts for a type that is a model AND an effect", () => {
    expect(unitVisual(148)).toEqual({
      effectId: 145,
      once: false,
      areaLift: null,
      model: "외부소품\\트랩03_6",
    });
  });

  it("marks an area type with its lift, so the caller can tell it apart", () => {
    // The effect covers a (2·radius+1)² grid, not one cell. A caller that drew
    // this like a cell effect would put one lone copy at the centre of an area
    // that should be covered, which is why the lift is surfaced rather than
    // folded into effectId.
    const area = unitVisual(245);
    expect(area?.effectId).toBe(959);
    expect(area?.areaLift).toBe(20);
    expect(area?.model).toBeNull();
  });

  it("returns null for a type the client's table does not know", () => {
    // Both of these are normal, not errors: 21292 is a real value seen in 73
    // records of one recording, and 134 is UNT_DUMMYSKILL, where every skill
    // with no ground graphic of its own lands. A null is the caller's cue to
    // fall back to the correlated skill id.
    expect(unitVisual(21292)).toBeNull();
    expect(unitVisual(134)).toBeNull();
  });

  it("returns null for type 0 — a truncated record, not a unit", () => {
    // rrfparser decodes a truncated 0x09ca with unitType 0 rather than dropping
    // it, so this path is reached in practice and must not resolve to a visual.
    expect(unitVisual(0)).toBeNull();
  });

  it("never reports `once` for a type with no cell effect", () => {
    // `once` qualifies the cell effect. A model-only or area type has none, so
    // the flag would be meaningless — and a caller branching on it first would
    // take the wrong path.
    for (const type of [145, 245]) {
      expect(unitVisual(type)?.once, String(type)).toBe(false);
    }
  });
});
