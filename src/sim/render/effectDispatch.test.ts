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
