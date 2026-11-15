// Tests for the world_str.txt reader in tools/build-world-str.mjs.
//
// The fixture lines are copied verbatim from the pinned upstream table (plus a
// couple of hand-made edge cases), because the whole value of this converter is
// that it reproduces upstream's reading exactly: a column read one place to the
// left turns a camera offset into a head height and nobody notices until an
// effect floats. Nothing here touches the network.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { UPSTREAM, parseWorldStr } from "./build-world-str.mjs";

/** Build a tab-separated table from rows given as field arrays. */
const table = (...rows) => rows.map((fields) => fields.join("\t")).join("\n");

describe("parseWorldStr", () => {
  it("reads a plain row as just its file", () => {
    const { rows } = parseWorldStr(table(["996", "jyumonjikiri", "-", "-", "-", "-", "-"]));
    expect(rows[996]).toEqual({ file: "jyumonjikiri" });
  });

  it("keeps the %d variant placeholder for the loader to resolve", () => {
    const { rows } = parseWorldStr(table(["141", "Pneuma%d", "-", "owner", "-", "-", "-"]));
    expect(rows[141]).toEqual({ file: "Pneuma%d", owner: true });
  });

  it("reads each flag independently", () => {
    const { rows } = parseWorldStr(
      table(
        ["1", "a", "-", "single,loop,owner", "-", "-", "-"],
        ["2", "b", "-", "loop", "-", "-", "-"],
        ["3", "c", "-", "single", "-", "-", "-"],
      ),
    );
    expect(rows[1]).toEqual({ file: "a", single: true, loop: true, owner: true });
    expect(rows[2]).toEqual({ file: "b", loop: true });
    expect(rows[3]).toEqual({ file: "c", single: true });
  });

  it("does not match a flag as a substring of another", () => {
    // "looped" is not "loop": upstream compares whole comma-separated items.
    const { rows } = parseWorldStr(table(["1", "a", "-", "looped,ownership", "-", "-", "-"]));
    expect(rows[1]).toEqual({ file: "a" });
  });

  it("reads the four head rules apart", () => {
    const { rows } = parseWorldStr(
      table(
        ["1", "a", "-", "-", "-", "-", "-"], // default: 80px over the feet
        ["2", "b", "-", "-", "lua", "-", "-"], // from the hat tables
        ["3", "c", "-", "-", "5.0,-6", "-", "-"], // head-height rule
        ["4", "d", "-", "-", "view:3,-2", "-", "-"], // camera-relative from the feet
      ),
    );
    expect(rows[1].head).toBeUndefined();
    expect(rows[3].head).toEqual([5, -6]);
    expect(rows[4].head).toEqual({ view: [3, -2] });
  });

  it("keeps the hat rule apart from the default instead of collapsing it", () => {
    // Nothing reads `head` yet, which is exactly why this matters: once "from
    // the hat tables" is written as "no rule", the 151 rows that carry it are
    // indistinguishable from the feet default for good.
    const { rows } = parseWorldStr(table(["2", "b", "-", "-", "lua", "-", "-"]));
    expect(rows[2].head).toBe("hat");
  });

  it("rejects a head value with more than two parts, as split_once does", () => {
    // Upstream splits at the FIRST comma and parses the rest whole, so `1,2,3`
    // is a parse failure, not (1, 2).
    const { rows } = parseWorldStr(
      table(["1", "a", "-", "-", "1,2,3", "-", "-"], ["2", "b", "-", "-", "view:1,2,3", "-", "-"]),
    );
    expect(rows[1].head).toBeUndefined();
    expect(rows[2].head).toBeUndefined();
  });

  it("rejects an empty or non-numeric head part", () => {
    const { rows } = parseWorldStr(
      table(["1", "a", "-", "-", "1,", "-", "-"], ["2", "b", "-", "-", ",2", "-", "-"]),
    );
    expect(rows[1].head).toBeUndefined();
    expect(rows[2].head).toBeUndefined();
  });

  it("skips a file whose placeholder we never substitute", () => {
    // `%d` is resolved at play time; upstream's `%02d` debug rows are not, so
    // importing them would ship guaranteed 404s.
    const { rows, unsubstituted } = parseWorldStr(
      table(
        ["1", "test_effect/%02d/%02d", "-", "-", "-", "-", "-"],
        ["2", "Pneuma%d", "-", "-", "-", "-", "-"],
      ),
    );
    expect(rows[1]).toBeUndefined();
    expect(rows[2]).toEqual({ file: "Pneuma%d" });
    expect(unsubstituted).toBe(1);
  });

  it("keeps an explicit 0,0 head rule, which is NOT the default", () => {
    // `-` means "80 px over the feet"; `0,0` means "at the head, no adjust".
    const { rows } = parseWorldStr(table(["1012", "cloudh", "-", "single,loop,owner", "0.0,0", "-", "-"]));
    expect(rows[1012].head).toEqual([0, 0]);
  });

  it("converts event ticks to milliseconds and normalises the sound name", () => {
    // 16 ms a tick; the gateway wants a GRF-relative name with forward slashes
    // and no extension.
    const { rows } = parseWorldStr(
      table(["1062", "RL_HAMER_GOD/hogg2", "-", "-", "-", "-", "w0:effect\\RL_HAMMER_OF_GOD.wav"]),
    );
    expect(rows[1062].sounds).toEqual([[0, "effect/RL_HAMMER_OF_GOD"]]);
  });

  it("splits several events and separates sounds from quakes", () => {
    const { rows } = parseWorldStr(
      table(["1", "a", "-", "-", "-", "-", "w10:effect/one.wav;q20;w30:two.wav"]),
    );
    expect(rows[1].sounds).toEqual([
      [160, "effect/one"],
      [480, "two"],
    ]);
    expect(rows[1].quakes).toEqual([320]);
  });

  it("reads the tint column, dropping a zero", () => {
    const { rows } = parseWorldStr(
      table(
        ["1", "a", "-", "-", "-", "10", "-"],
        ["2", "b", "-", "-", "-", "0", "-"],
        ["3", "c", "-", "-", "-", "-", "-"],
      ),
    );
    expect(rows[1].tint).toBe(10);
    expect(rows[2].tint).toBeUndefined();
    expect(rows[3].tint).toBeUndefined();
  });

  it("keeps the /mineffect replacement file when there is one", () => {
    const { rows } = parseWorldStr(
      table(["1", "big_effect", "small_effect", "-", "-", "-", "-"]),
    );
    expect(rows[1]).toEqual({ file: "big_effect", min: "small_effect" });
  });

  it("skips the rows whose file we cannot resolve, and counts them", () => {
    const { rows, launchNamed, hatNamed } = parseWorldStr(
      table(
        ["1", "-", "-", "-", "-", "-", "-"], // named by whoever launches it
        ["2", "lua", "-", "-", "lua", "-", "-"], // named by the hat tables
        ["3", "real", "-", "-", "-", "-", "-"],
      ),
    );
    expect(Object.keys(rows)).toEqual(["3"]);
    expect({ launchNamed, hatNamed }).toEqual({ launchNamed: 1, hatNamed: 1 });
  });

  it("ignores comments, blank lines and malformed rows", () => {
    const { rows } = parseWorldStr(
      [
        "# a comment",
        "",
        "notanumber\tfile\t-\t-\t-\t-\t-",
        "\tnoid\t-\t-\t-\t-\t-", // an empty id is not id 0
        "-3\tnegative\t-\t-\t-\t-\t-",
        "5\tshort\t-\t-", // too few columns
        "6\tgood\t-\t-\t-\t-\t-",
      ].join("\n"),
    );
    expect(Object.keys(rows)).toEqual(["6"]);
  });

  it("ignores an event whose tick is empty or signed", () => {
    // `Number("")` is 0, so a sloppy parse would fire `w:` at t=0 and put a
    // quake at -16 ms; upstream's u32 parse rejects both outright.
    const { rows } = parseWorldStr(
      table(["1", "a", "-", "-", "-", "-", "w:effect\\x.wav;q;q-1"]),
    );
    expect(rows[1]).toEqual({ file: "a" });
  });

  it("lets a later row for the same id win, as upstream's map insert does", () => {
    const { rows } = parseWorldStr(
      table(["7", "first", "-", "-", "-", "-", "-"], ["7", "second", "-", "-", "-", "-", "-"]),
    );
    expect(rows[7]).toEqual({ file: "second" });
  });
});
describe("the shipped public/db/world-str.json", () => {
  // The tests above pin the READING; this pins the FILE. A column shift across
  // the whole table, or an upstream re-pin that drops half the rows, passes
  // every unit test above and would ship green without this.
  const shipped = JSON.parse(
    readFileSync(fileURLToPath(new URL("../public/db/world-str.json", import.meta.url)), "utf8"),
  );

  it("names its upstream revision", () => {
    expect(shipped._source).toEqual(UPSTREAM);
  });

  it("carries the whole table", () => {
    expect(Object.keys(shipped.rows)).toHaveLength(1188);
  });

  it("ships the anchor constants the head rule needs", () => {
    expect(shipped.risePx).toBe(80);
    expect(shipped.noRise).toBe(1412);
    expect(shipped.lowHead).toBe(1817);
  });

  it("holds the id the precedence rule turns on", () => {
    // 1062: the gateway serves a `stormgust` placeholder here, the client has
    // Hammer of God. The one disagreement between the two tables that anything
    // in the app actually reaches.
    expect(shipped.rows["1062"].file).toBe("RL_HAMER_GOD/hogg2");
  });

  it("keeps a %d variant, a hat anchor, a view offset and a late sound", () => {
    expect(shipped.rows["1163"].file).toBe("MeteorStorm/meteor%d");
    expect(shipped.rows["2477"].head).toBe("hat");
    expect(shipped.rows["10010"].head).toEqual({ view: [0, 10] });
    expect(shipped.rows["1162"].sounds.at(-1)[0]).toBe(3200);
    expect(shipped.rows["1162"].quakes).toEqual([800, 1600, 2400, 3200, 4000]);
  });

  it("ships no file with a placeholder it cannot resolve", () => {
    const bad = Object.entries(shipped.rows).filter(
      ([, row]) => row.file.includes("%") && !row.file.includes("%d"),
    );
    expect(bad).toEqual([]);
  });
});
