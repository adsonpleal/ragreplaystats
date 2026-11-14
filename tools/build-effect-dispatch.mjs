#!/usr/bin/env node
// Build public/db/effect-dispatch.json — WHICH effect a skill plays, WHERE and
// WHEN — from rustnarok-client's `src/fx/effects.txt`.
//
// WHY THIS EXISTS
// ---------------
// Our map viewer resolves a skill's visuals through the ragassets gateway's
// roBrowser-derived tables (`/effect/skill-map` + `/effect/table`). That pair
// only answers three questions: the skill's MAIN effect, its hit effect, and its
// ground effect. The client asks six more, and we were answering none of them:
//
//   cast    the aura that glows under a caster while a cast bar fills
//   caster  what a damaging skill flashes on its CASTER as the packet lands
//   hit     the TWO effects a damaging skill puts on its target per hit
//   struck  an extra effect on either side when damage lands
//   used    what a no-damage skill (ZC_USE_SKILL) shows, per side
//   ground  what a ground skill shows at its cell / on its caster
//   unit    what a skill's UNIT standing on the ground shows, by unit TYPE
//
// rustnarok-client (a from-scratch native RO client, MIT OR Apache-2.0) keeps
// all nine in one hand-verified text table. Measured against OUR renderable
// effect set, those six extra kinds give a visual to hundreds of skills that
// currently draw nothing — using only assets the gateway already serves. Its
// `skill` rows are the same roBrowser map we already have (288 of the 293
// comparable rows identical), so we do NOT import those: `skillEntry()` stays
// the source of truth for the main effect. The one exception is `hit`, which
// differs from our `hitEffectId` on 38 skills; the runtime prefers this table
// and falls back to the gateway's.
//
// THESE ROWS REPLACE, THEY DO NOT JOIN. `used`, `struck` and `ground` are read
// by the client INSTEAD of the skill line, not alongside it, and 172 `used` /
// 71 `struck` rows name the very effect our skill-map already gives. Spawning
// both would draw those skills twice over, so the runtime suppresses the main
// effect wherever one of these kinds has a row.
//
// THE UNIT ROWS ARE KEYED BY UNIT TYPE, NOT BY SKILL. Every other kind above is
// keyed by skill id; `unit`, `rsm` and `area` are keyed by rathena's UNT_ number,
// which is what the client itself keys a ground unit's visual off. We read that
// number straight off 0x09ca (`GroundSkillUnit.unitType`, rrfparser >= 1.5.0)
// instead of the `skillId` beside it, which is only CORRELATED from the caster's
// latest cast and is 0 when nothing could be attributed. That is the whole point
// of importing them: a Storm Gust's ice and a trap's model stop depending on a
// guess. Unit types outside the table do occur in real recordings (21292 shows
// up in 73 records of one replay), so the runtime needs a fall-through.
//
// WHAT IS DELIBERATELY NOT IMPORTED
//   skill   superseded by our own skill-map (see above)
//   str/part/ring/spr/func/wav   asset rows; the gateway already serves these
//   status/item   later phases; needs packet fields we do not decode yet
//   trap    what a trap shows WHEN IT GOES OFF. 0x09ca carries the unit's type,
//           not the later state change that fires it, so there is no event to
//           hang these 23 rows on. `visible` does tell us a trap is HIDDEN
//           (false for exactly one type, 145/HT_ANKLESNARE), which the runtime
//           uses to draw nothing at all.
//   keep/every/unitr/unitw   9 rows between them, and each one drives a
//           procedural prim we do not have (Zenkai's and Makibishi's self-launch,
//           Severe Rainstorm's periodic rain, Poison Smoke's random puffs,
//           Epiclesis' tree). Importing the numbers without the renderers would
//           only let the runtime draw the wrong thing.
//   misc/minid/quake  no 0x019b events, no /mineffect, no camera shake
//
// `-1` IS DATA, NOT ABSENCE. The client's default caster/cast effect is 16
// (Bash's burst); a `-1` row SUPPRESSES it. Dropping those rows would make
// hundreds of skills flash a burst the client does not draw, so they are kept
// verbatim and the runtime distinguishes "absent" from "explicitly none".
//
// Usage:
//   node tools/build-effect-dispatch.mjs                 # fetch the pinned upstream revision
//   node tools/build-effect-dispatch.mjs --src <file>    # use a local effects.txt
//   node tools/build-effect-dispatch.mjs --out <file>    # write somewhere else

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/** Upstream source, pinned by commit so a rebuild is reproducible. The table
 *  itself is `file`; the handful of constants below it (the element→aura list,
 *  the default caster effect, the suppressed skill ranges, the sustained-aura
 *  set) are transcribed from the Rust sources named in `constants`. */
const UPSTREAM = {
  repo: "kindraywind/rustnarok-client",
  commit: "c01cce3e5b37d8c4eb377d290f8dbe3f93a862de",
  file: "src/fx/effects.txt",
  constants: ["src/main.rs", "src/fx/effects.rs"],
  license: "MIT OR Apache-2.0",
};
const RAW_URL = `https://raw.githubusercontent.com/${UPSTREAM.repo}/${UPSTREAM.commit}/${UPSTREAM.file}`;

/**
 * The cast aura by the cast packet's `property` (element) index, from the
 * client's own table: neutral/unknown fall back to EF_BEGINSPELL (12) and the
 * six elemental auras are EF_PROPERTY* 54-59.
 *   0 neutral, 1 water, 2 earth, 3 fire, 4 wind, 5 poison, 6 holy, 7+ neutral
 * A `cast` row of exactly 12 means "use this element's aura"; any other id is
 * fixed regardless of element.
 */
const CAST_AURAS = [12, 54, 56, 55, 57, 59, 58, 12, 12, 12];

/** What most damaging skills show on their caster when no `caster` row says otherwise. */
const DEFAULT_CASTER = 16;

/**
 * Every effect the client treats as a SUSTAINED cast aura — "one a caster has
 * at a time", glowing for as long as the bar fills — as opposed to a one-off
 * flash. Transcribed from upstream's `is_cast_aura` (src/fx/effects.rs), whose
 * named constants are resolved here: 564 homunculus, 805 tetra vortex, 826
 * shadow, 454 dark, 830 bubble, 342 couple, 441 blue, 911 green, 1418 comet,
 * 1449 jack, 1556 maelstrom, 1560 clearance, 1565 varetyr, 1664 earth, 1677
 * cart, 1709 earth drive, 1932 frami.
 *
 * The distinction is not cosmetic: the client's fallback cast effect for an
 * unlisted skill is 16, Bash's burst, and looping THAT for a two-second cast
 * re-fires the burst over and over.
 */
const CAST_AURA_EFFECTS = [
  12, 54, 55, 56, 57, 58, 59, 342, 441, 454, 564, 805, 826, 830, 911, 1418, 1449, 1556, 1560,
  1565, 1664, 1677, 1709, 1872, 1876, 1902, 1910, 1918, 1923, 1932, 1938, 1959, 1963, 1986,
  1998, 2240, 2249, 2255,
];

/** Skill ranges whose casts/casters show nothing at all (the newest jobs'). */
const NO_CASTER_EFFECT = [
  [5401, 5507],
  [6001, 6006],
  [6525, 6606],
];

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

/** Side column → the short key the runtime uses. */
const SIDE = { caster: "c", target: "t", ground: "g" };

async function source() {
  const local = arg("--src");
  if (local) return readFile(resolve(process.cwd(), local), "utf8");
  const res = await fetch(RAW_URL);
  if (!res.ok) throw new Error(`${RAW_URL} → HTTP ${res.status}`);
  return res.text();
}

/** An effect column: a number, or null for the table's `-1` ("explicitly none"). */
const effect = (raw) => {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** A column upstream reads with `parse::<u32>()`: a run of digits and nothing
 *  else. Stricter than `Number.isFinite` on purpose — `Number("")` is 0, and 0
 *  is the one unit type that must never have a row, since rrfparser decodes a
 *  truncated 0x09ca as type 0 rather than dropping the record. A blank column
 *  in some future upstream edit would otherwise mint `unit[0]` and draw that
 *  effect for every truncated record in every replay. Negatives, fractions and
 *  `0x…` are rejected for the same reason: upstream skips the row, so we do. */
const u32 = (raw) => (/^\d+$/.test(String(raw ?? "").trim()) ? Number(raw) : null);

/**
 * Read effects.txt into the six dispatch kinds plus `length`.
 *
 * hit/caster: one row per skill wins (upstream inserts into a map, so the LAST
 * row of a duplicated skill is the live one — mirrored here).
 * cast: a list per skill — the first entry is the aura, the rest start alongside it.
 * used/struck/ground: an ordered list of [side, effect] per skill.
 * unit/unitModel/unitArea: keyed by UNIT TYPE (rathena's UNT_ number), not by
 * skill. One row per type wins, like hit/caster — upstream inserts into a map.
 *
 * Columns are split on a SINGLE tab, like upstream: collapsing runs of tabs
 * would silently shift every column right of an empty one.
 */
export function parseEffects(text) {
  const rows = text
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => line.split("\t"));

  const out = {
    hit: {},
    cast: {},
    caster: {},
    used: {},
    struck: {},
    ground: {},
    length: {},
    unit: {},
    unitOnce: [],
    unitModel: {},
    unitArea: {},
  };

  for (const r of rows) {
    const kind = r[0];
    switch (kind) {
      case "hit": {
        // `hit <skill> <effect 1> <effect 2>` — both play on the target per hit.
        const skill = Number(r[1]);
        if (!Number.isFinite(skill)) break;
        out.hit[skill] = [effect(r[2]), effect(r[3])];
        break;
      }
      case "caster": {
        const skill = Number(r[1]);
        if (!Number.isFinite(skill)) break;
        out.caster[skill] = effect(r[2]);
        break;
      }
      case "cast": {
        const skill = Number(r[1]);
        if (!Number.isFinite(skill)) break;
        (out.cast[skill] ??= []).push(effect(r[2]));
        break;
      }
      case "used":
      case "struck":
      case "ground": {
        // `<kind> <skill> <caster|target|ground> <effect>`
        const skill = Number(r[1]);
        const side = SIDE[r[2]] ?? "t";
        const id = effect(r[3]);
        if (!Number.isFinite(skill) || id == null) break;
        (out[kind][skill] ??= []).push([side, id]);
        break;
      }
      case "unit": {
        // `unit <unit type> <effect> [once]` — what the unit shows while it
        // stands. Without `once` the client restarts the effect for as long as
        // the unit is there, so a one-shot STR would flash once under a Storm
        // Gust that lasts seconds.
        const type = u32(r[1]);
        const id = u32(r[2]);
        if (type == null || id == null) break;
        out.unit[type] = id;
        if (r[3]?.trim() === "once" && !out.unitOnce.includes(type)) out.unitOnce.push(type);
        break;
      }
      case "rsm": {
        // `rsm <unit type> <model>` — the unit stands as a 3D MODEL, not an
        // effect: a Hunter's trap, a Blast Mine. The path is a GRF model name
        // (Korean, backslash-separated) and is kept exactly as upstream has it;
        // our RSW loader already reads this format for map objects.
        const type = u32(r[1]);
        const file = r[2];
        // Upstream matches `["rsm", _, file]` exactly, so a row with a trailing
        // column is not an rsm row at all.
        if (type == null || !file || r.length !== 3) break;
        out.unitModel[type] = file;
        break;
      }
      case "area": {
        // `area <unit type> <effect> <lift>` — an effect spread over the unit's
        // whole area rather than its one cell, lifted `lift` units off the
        // ground. Sized by the unit's radius, which 0x09ca carries.
        const type = u32(r[1]);
        const id = u32(r[2]);
        const lift = u32(r[3]);
        // Upstream matches `["area", kind, effect, lift]` exactly — four fields,
        // no more.
        if (type == null || id == null || lift == null || r.length !== 4) break;
        out.unitArea[type] = [id, lift];
        break;
      }
      case "length": {
        // `length <effect id> <ticks>` — the effect's own run time, which may be
        // shorter OR longer than its STR. We only honour the shorter case.
        const id = Number(r[1]);
        const ticks = Number(r[2]);
        if (Number.isFinite(id) && Number.isFinite(ticks)) out.length[id] = ticks;
        break;
      }
      default:
        break; // every other directive: see "WHAT IS DELIBERATELY NOT IMPORTED"
    }
  }

  return out;
}

async function main() {
  const out = parseEffects(await source());
  const json = {
    _source: UPSTREAM,
    castAuras: CAST_AURAS,
    castAuraEffects: CAST_AURA_EFFECTS,
    defaultCaster: DEFAULT_CASTER,
    noCasterEffect: NO_CASTER_EFFECT,
    ...out,
  };

  const outPath = resolve(ROOT, arg("--out") ?? "public/db/effect-dispatch.json");
  await writeFile(outPath, JSON.stringify(json));

  const count = (o) => Object.keys(o).length;
  console.log(
    `effect-dispatch.json written to ${outPath}\n` +
      `  hit ${count(out.hit)} · cast ${count(out.cast)} · caster ${count(out.caster)} · ` +
      `used ${count(out.used)} · struck ${count(out.struck)} · ground ${count(out.ground)} · ` +
      `length ${count(out.length)}\n` +
      `  unit ${count(out.unit)} (${out.unitOnce.length} once) · model ${count(out.unitModel)} · ` +
      `area ${count(out.unitArea)}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
