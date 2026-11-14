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

  it("reads a unit row by type, flagging the ones that play once", () => {
    const out = parseEffects(
      table(["unit", "126", "315"], ["unit", "135", "138", "once"], ["unit", "190", "-1"]),
    );
    expect(out.unit[126]).toBe(315);
    expect(out.unit[135]).toBe(138);
    expect(out.unitOnce).toEqual([135]);
    // Unlike `caster`, a `-1` unit row has nothing to suppress — there is no
    // default unit effect — so it is dropped rather than stored as null.
    expect(Object.hasOwn(out.unit, "190")).toBe(false);
  });

  it("lets the last unit row for a type win, and never doubles a `once`", () => {
    const out = parseEffects(
      table(["unit", "126", "315"], ["unit", "126", "316", "once"], ["unit", "126", "317", "once"]),
    );
    expect(out.unit[126]).toBe(317);
    expect(out.unitOnce).toEqual([126]);
  });

  it("reads a model row as a GRF path, backslashes intact", () => {
    const out = parseEffects(
      table(["rsm", "145", "외부소품\\트랩01"], ["rsm", "20852", "effect\\deepblindtrap\\deep_trap.rsm2"]),
    );
    expect(out.unitModel[145]).toBe("외부소품\\트랩01");
    expect(out.unitModel[20852]).toBe("effect\\deepblindtrap\\deep_trap.rsm2");
  });

  it("reads an area row as effect plus lift, keeping a zero lift", () => {
    const out = parseEffects(table(["area", "245", "959", "20"], ["area", "246", "964", "0"]));
    expect(out.unitArea[245]).toEqual([959, 20]);
    // A 0 lift is a real value (flat on the ground), not a missing column.
    expect(out.unitArea[246]).toEqual([964, 0]);
  });

  it("ignores the unit kinds it has no renderer for", () => {
    // keep/every/unitr/unitw each drive a procedural prim we do not have. They
    // must not leak into `unit`, where the runtime would draw them at a cell.
    const out = parseEffects(
      table(
        ["keep", "248", "992"],
        ["every", "219", "1276", "992"],
        ["unitr", "225", "1546", "1"],
        ["unitw", "202", "1654"],
        ["trap", "143", "106"],
      ),
    );
    expect(out.unit).toEqual({});
    expect(out.unitOnce).toEqual([]);
    expect(out.unitModel).toEqual({});
    expect(out.unitArea).toEqual({});
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
    for (const kind of [
      "hit",
      "cast",
      "caster",
      "used",
      "struck",
      "ground",
      "length",
      "unit",
      "unitModel",
      "unitArea",
    ]) {
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

  it("has no unit row for type 0 — that is a truncated record, not a unit", () => {
    // rrfparser decodes a truncated 0x09ca with `unitType` 0 rather than
    // dropping it (the unit→caster link still matters for AoE attribution). If
    // type 0 ever gained a row, every truncated record would draw it.
    for (const kind of ["unit", "unitModel", "unitArea"]) {
      expect(Object.hasOwn(shipped[kind], "0"), kind).toBe(false);
    }
    expect(shipped.unitOnce).not.toContain(0);
  });

  it("keys the unit kinds by unit type, in rathena's UNT_ range", () => {
    // The client's table covers roughly 126-301. A type outside it does occur
    // on the wire (21292), which is exactly why the runtime needs a
    // fall-through rather than an assumption — but nothing in the TABLE should
    // sit outside the range, or the import read the wrong column.
    const types = [
      ...Object.keys(shipped.unit),
      ...Object.keys(shipped.unitModel),
      ...Object.keys(shipped.unitArea),
    ].map(Number);
    expect(types.length).toBeGreaterThan(100);
    for (const t of types) {
      expect(t, String(t)).toBeGreaterThanOrEqual(126);
      // The 2085x block is the newer trap models (deep blind, solid, swift, flame).
      expect(t <= 301 || (t >= 20852 && t <= 20855), String(t)).toBe(true);
    }
  });

  it("gives every `once` type a unit effect to play once", () => {
    for (const type of shipped.unitOnce) {
      expect(shipped.unit[type], String(type)).toBeTypeOf("number");
    }
  });

  it("anchors the unit types rrfparser pinned the field's offset from", () => {
    // The same four anchors that established where `unitType` sits in 0x09ca,
    // read here from the other side: each skill's unit type must still name the
    // effect the client draws for it. If the import ever shifts a column, these
    // move together.
    expect(shipped.unit[126]).toBe(315); // MG_SAFETYWALL's unit
    expect(shipped.unit[127]).toBe(25); // MG_FIREWALL's
    expect(shipped.unit[131]).toBe(319); // PR_SANCTUARY's
    expect(shipped.unit[132]).toBe(318); // PR_MAGNUS'
    expect(shipped.unit[133]).toBe(141); // AL_PNEUMA's
    expect(shipped.unit[135]).toBe(138); // WZ_FIREPILLAR's
    // Sanctuary's and Magnus' squares are placed once per unit and left to
    // stand; the Fire Wall's flame restarts for as long as the wall is there.
    expect(shipped.unitOnce).toContain(131);
    expect(shipped.unitOnce).toContain(132);
    expect(shipped.unitOnce).not.toContain(127);
    // 134 is UNT_DUMMYSKILL — the type every skill with no ground graphic of
    // its own lands on, which is what that member exists for. A row here would
    // draw something for all of them.
    expect(Object.hasOwn(shipped.unit, "134")).toBe(false);
    expect(Object.hasOwn(shipped.unitModel, "134")).toBe(false);
    expect(Object.hasOwn(shipped.unitArea, "134")).toBe(false);
  });

  it("keeps the model paths as GRF names, not URLs", () => {
    for (const [type, file] of Object.entries(shipped.unitModel)) {
      expect(file, type).not.toMatch(/^https?:/);
      // GRF model names are backslash-separated and mostly Korean; a forward
      // slash would mean the path was rewritten somewhere it should not be.
      expect(file, type).not.toContain("/");
      expect(file.length, type).toBeGreaterThan(0);
    }
    // Ankle Snare's trap, the one unit the server can hide from a viewer.
    expect(shipped.unitModel[145]).toBe("외부소품\\트랩01");
  });

  it("gives every area row an effect and a lift", () => {
    for (const [type, row] of Object.entries(shipped.unitArea)) {
      expect(row.length, type).toBe(2);
      const [effect, lift] = row;
      expect(effect, type).toBeTypeOf("number");
      expect(lift, type).toBeTypeOf("number");
      expect(lift, type).toBeGreaterThanOrEqual(0);
    }
    expect(shipped.unitArea[245]).toEqual([959, 20]);
    expect(shipped.unitArea[246]).toEqual([964, 0]);
  });
});
