// Tests for the effects.txt reader in tools/build-effect-dispatch.mjs.
//
// Every directive here is a shape that exists in the pinned upstream table, and
// the expectations encode upstream's own reading of it: which row wins when a
// skill repeats, whether a column is a list or a single value, and — the one
// that matters most — that `-1` is DATA ("show nothing") in some kinds and an
// instruction to drop the row in others. Nothing here touches the network.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseEffects } from "./build-effect-dispatch.mjs";

/** Build a tab-separated table from rows given as field arrays. */
const table = (...rows) => rows.map((fields) => fields.join("\t")).join("\n");

describe("parseEffects", () => {
  it("reads a hit row as a pair, keeping a suppressed half in place", () => {
    const out = parseEffects(
      table(["hit", "5", "0", "1"], ["hit", "100", "49", "-1"], ["hit", "101", "-1", "49"]),
    );
    expect(out.hit[5]).toEqual([0, 1]);
    expect(out.hit[100]).toEqual([49, null]);
    expect(out.hit[101]).toEqual([null, 49]);
  });

  it("keeps an explicit `none` caster apart from an absent one", () => {
    // The whole reason `-1` survives into the JSON: the runtime's default is
    // Bash's burst, and these skills opt out of it.
    const out = parseEffects(table(["caster", "2237", "-1"], ["caster", "600", "144"]));
    expect(out.caster[2237]).toBeNull();
    expect(out.caster[600]).toBe(144);
    expect(Object.hasOwn(out.caster, "12345")).toBe(false);
  });

  it("lets the last row win for hit and caster, as upstream's map insert does", () => {
    const out = parseEffects(
      table(["caster", "7", "11"], ["caster", "7", "22"], ["hit", "8", "1", "2"], ["hit", "8", "3", "4"]),
    );
    expect(out.caster[7]).toBe(22);
    expect(out.hit[8]).toEqual([3, 4]);
  });

  it("collects cast rows into a list, aura first", () => {
    // Upstream pushes into a Vec, so a skill with several cast rows keeps all
    // of them: row 0 is the aura, the rest start alongside it.
    const out = parseEffects(
      table(["cast", "2217", "805"], ["cast", "2217", "1277"], ["cast", "2217", "1261"]),
    );
    expect(out.cast[2217]).toEqual([805, 1277, 1261]);
  });

  it("stores a `-1` cast row rather than dropping it", () => {
    const out = parseEffects(table(["cast", "400", "-1"]));
    expect(out.cast[400]).toEqual([null]);
  });

  it("reads used/struck/ground as ordered side/effect pairs", () => {
    const out = parseEffects(
      table(
        ["used", "701", "target", "37"],
        ["used", "701", "caster", "42"],
        ["struck", "800", "caster", "750"],
        ["ground", "900", "ground", "235"],
      ),
    );
    expect(out.used[701]).toEqual([
      ["t", 37],
      ["c", 42],
    ]);
    expect(out.struck[800]).toEqual([["c", 750]]);
    expect(out.ground[900]).toEqual([["g", 235]]);
  });

  it("DROPS a `-1` used/struck/ground row instead of storing a none", () => {
    // Unlike cast/caster: upstream reads this column with a parse that fails on
    // -1, so the row never reaches the list at all.
    const out = parseEffects(table(["used", "702", "caster", "-1"], ["used", "702", "target", "9"]));
    expect(out.used[702]).toEqual([["t", 9]]);
  });

  it("reads length in the client's 16 ms ticks, unconverted", () => {
    // The runtime multiplies; keeping ticks here means the JSON still says what
    // the client's table says.
    const out = parseEffects(table(["length", "25", "40"]));
    expect(out.length[25]).toBe(40);
  });

  it("ignores the directives we deliberately do not import", () => {
    const out = parseEffects(
      table(
        ["str", "10", "maemor", "-", "1"],
        ["skill", "5", "effectId", "1"],
        ["wav", "5", "effect/ef_bash"],
        ["part", "1", "2D", "alphaMax=12"],
        ["status", "100", "1"],
        ["hit", "5", "0", "1"],
      ),
    );
    expect(Object.keys(out.hit)).toEqual(["5"]);
    for (const kind of ["cast", "caster", "used", "struck", "ground", "length"]) {
      expect(Object.keys(out[kind]), kind).toEqual([]);
    }
  });

  it("ignores comments, blank lines and an unparsable skill id", () => {
    const out = parseEffects(
      ["# a comment", "", "hit\tnotanumber\t0\t1", "hit\t6\t0\t1"].join("\n"),
    );
    expect(Object.keys(out.hit)).toEqual(["6"]);
  });
});

describe("the shipped public/db/effect-dispatch.json", () => {
  // The unit tests above pin the READING; this pins the FILE, so a rebuild that
  // quietly drops a kind or reshapes a row cannot ship green. It is also the
  // only test the runtime's own suite cannot do: that one stubs the fetch.
  const shipped = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../public/db/effect-dispatch.json", import.meta.url)),
      "utf8",
    ),
  );

  it("names its upstream revision", () => {
    expect(shipped._source.repo).toBe("kindraywind/rustnarok-client");
    expect(shipped._source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(shipped._source.license).toBe("MIT OR Apache-2.0");
  });

  it("carries every kind the runtime reads, none of them empty", () => {
    for (const kind of ["hit", "cast", "caster", "used", "struck", "ground", "length"]) {
      expect(Object.keys(shipped[kind]).length, kind).toBeGreaterThan(0);
    }
  });

  it("keeps the client's constants intact", () => {
    expect(shipped.defaultCaster).toBe(16);
    expect(shipped.castAuras).toEqual([12, 54, 56, 55, 57, 59, 58, 12, 12, 12]);
    // The elemental auras must all count as sustained, or every elemental cast
    // collapses into a one-frame pop.
    for (const id of [12, 54, 55, 56, 57, 58, 59]) {
      expect(shipped.castAuraEffects, String(id)).toContain(id);
    }
    expect(shipped.castAuraEffects).not.toContain(16);
    expect(shipped.noCasterEffect.every(([lo, hi]) => lo <= hi)).toBe(true);
  });

  it("gives every hit row exactly two positions", () => {
    for (const [skill, pair] of Object.entries(shipped.hit)) {
      expect(pair.length, skill).toBe(2);
    }
  });

  it("uses only sides the runtime knows how to place", () => {
    for (const kind of ["used", "struck", "ground"]) {
      for (const [skill, rows] of Object.entries(shipped[kind])) {
        for (const [side] of rows) {
          expect(["c", "t", "g"], `${kind} ${skill}`).toContain(side);
        }
      }
    }
  });

  it("has no row for skill 0 in any kind — an auto-attack is not a skill", () => {
    for (const kind of ["hit", "cast", "caster", "used", "struck", "ground"]) {
      expect(Object.hasOwn(shipped[kind], "0"), kind).toBe(false);
    }
  });
});
