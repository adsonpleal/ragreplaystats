#!/usr/bin/env node
// Build the client-derived tables in public/db/ — item, job, skill, randomopt
// and status — from the sibling project ragassets.
//
// ragassets is the single place that reads the Ragnarok client's GRF and Lua
// data tables; it publishes a faithful, unopinionated projection of them at
//   https://assets.latam-tools.com.br/raw/<name>.json
// This script downloads those and reshapes them into the exact files the app
// loads at runtime (src/db/loader.ts → src/names.ts). It replaces the old
// in-repo GRF reader + Lua 5.1 VM (tools/build-db.mjs, now removed): no client
// install, no GRF, no bytecode walking here anymore.
//
// Everything opinionated stays on this side, which is the point of the split:
// the `[N]` slot suffix, FOOD_STATUS_NAMES, PLAYER_JT_IDS and JOB_NAME_OVERRIDE
// are RagnaRecap's own curation and must not leak upstream.
//
// The /raw shapes (compact JSON arrays, sorted by id):
//   items.json     { id, name, slots, aegisName, resourceName, description,
//                    view, equipSlots, costume }   — `name` is the BARE name
//                    and is null for rows the client never labels
//   jobs.json      { id, jt, name, hasIcon }       — `jt`/`name` may be null
//   classes.json   { id, renderId, jt, name, race, … }  — one row per PLAYABLE
//                    class, including every class pcidentity.lub never numbers
//                    (the 4th classes, Rebellion, Summoner, Star Emperor …).
//                    `renderId` is the id the packets carry; `id` is the
//                    client's own (they differ only for the expanded 4th
//                    classes, whose always-mounted sprite sits at 4309-4315)
//   skills.json    { id, name }
//   randomopt.json { id, name }
//   status.json    { id, name }
//
// Monster names/HP/level are not in the client (they're server-side) — those
// come from ragassets' mobs.json via tools/build-monsters.mjs.
//
// Usage:
//   node tools/sync-db.mjs                       # fetch from ragassets, write public/db/
//   node tools/sync-db.mjs --input <dir>         # use a local ragassets resources/raw/ instead
//   node tools/sync-db.mjs --url <base>          # override the source base URL
//   node tools/sync-db.mjs --out <dir>           # override the output directory

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_URL = "https://assets.latam-tools.com.br/raw";
const DEFAULT_OUT = "public/db";

// kRO-default JT name → numeric id, used as a fallback for classes the server's
// own pcidentity.lub doesn't number. jobs.json only carries the ids pcidentity
// gives, so every 4th class (and the alt-sprite ids) reaches us through here.
export const PLAYER_JT_IDS = {
  JT_NOVICE: 0, JT_SWORDMAN: 1, JT_MAGICIAN: 2, JT_ARCHER: 3,
  JT_ACOLYTE: 4, JT_MERCHANT: 5, JT_THIEF: 6, JT_KNIGHT: 7,
  JT_PRIEST: 8, JT_WIZARD: 9, JT_BLACKSMITH: 10, JT_HUNTER: 11,
  JT_ASSASSIN: 12, JT_KNIGHT2: 13, JT_CRUSADER: 14, JT_MONK: 15,
  JT_SAGE: 16, JT_ROGUE: 17, JT_ALCHEMIST: 18, JT_BARD: 19,
  JT_DANCER: 20, JT_CRUSADER2: 21, JT_WEDDING: 22, JT_SUPERNOVICE: 23,
  JT_GUNSLINGER: 24, JT_NINJA: 25, JT_TAEKWON: 4046, JT_STAR_GLADIATOR: 4047,
  JT_STAR_GLADIATOR2: 4048, JT_SOUL_LINKER: 4049,
  JT_NOVICE_H: 4001, JT_SWORDMAN_H: 4002, JT_MAGICIAN_H: 4003,
  JT_ARCHER_H: 4004, JT_ACOLYTE_H: 4005, JT_MERCHANT_H: 4006,
  JT_THIEF_H: 4007, JT_KNIGHT_H: 4008, JT_PRIEST_H: 4009,
  JT_WIZARD_H: 4010, JT_BLACKSMITH_H: 4011, JT_HUNTER_H: 4012,
  JT_ASSASSIN_H: 4013, JT_KNIGHT2_H: 4014, JT_CRUSADER_H: 4015,
  JT_MONK_H: 4016, JT_SAGE_H: 4017, JT_ROGUE_H: 4018,
  JT_ALCHEMIST_H: 4019, JT_BARD_H: 4020, JT_DANCER_H: 4021,
  JT_CRUSADER2_H: 4022,
  JT_RUNE_KNIGHT: 4054, JT_WARLOCK: 4055, JT_RANGER: 4056,
  JT_ARCH_BISHOP: 4057, JT_MECHANIC: 4058, JT_GUILLOTINE_CROSS: 4059,
  JT_ROYAL_GUARD: 4060, JT_SORCERER: 4061, JT_MINSTREL: 4062,
  JT_WANDERER: 4063, JT_SURA: 4064, JT_GENETIC: 4065, JT_SHADOW_CHASER: 4066,
  JT_RUNE_KNIGHT_H: 4067, JT_WARLOCK_H: 4068, JT_RANGER_H: 4069,
  JT_ARCH_BISHOP_H: 4070, JT_MECHANIC_H: 4071, JT_GUILLOTINE_CROSS_H: 4072,
  JT_ROYAL_GUARD_H: 4073, JT_SORCERER_H: 4074, JT_MINSTREL_H: 4075,
  JT_WANDERER_H: 4076, JT_SURA_H: 4077, JT_GENETIC_H: 4078,
  JT_SHADOW_CHASER_H: 4079,
  JT_RUNE_KNIGHT2: 4080, JT_RUNE_KNIGHT_H2: 4081,
  JT_ROYAL_GUARD2: 4082, JT_ROYAL_GUARD_H2: 4083,
  JT_RANGER2: 4084, JT_RANGER_H2: 4085,
  JT_MECHANIC2: 4086, JT_MECHANIC_H2: 4087,
  JT_DRAGON_KNIGHT: 4252, JT_MEISTER: 4253, JT_SHADOW_CROSS: 4254,
  JT_ARCH_MAGE: 4255, JT_CARDINAL: 4256, JT_WINDHAWK: 4257,
  JT_IMPERIAL_GUARD: 4258, JT_BIOLO: 4259, JT_ABYSS_CHASER: 4260,
  JT_ELEMENTAL_MASTER: 4261, JT_INQUISITOR: 4262, JT_TROUBADOUR: 4263,
  JT_TROUVERE: 4264,
  // The four mounted 4th sprites — 4278-4281, NOT 4302-4308: that block is the
  // expanded 4th branch (Sky Emperor … Spirit Handler), which classes.json
  // numbers. Ordering per the client's own job id space (JOBID/rAthena mmo.hpp).
  JT_WINDHAWK2: 4278, JT_MEISTER2: 4279,
  JT_DRAGON_KNIGHT2: 4280, JT_IMPERIAL_GUARD2: 4281,
  JT_SUMMONER: 4218,
  JT_CHICKEN: 4045, JT_CHICKEN2: 4046,
};

// Class labels we pin ourselves, keyed by JT constant.
//
// The 13 original 4th classes come from bROWiki's "Classe 4" column and are kept
// in sync with the sibling project latam-visuais (NAME_OVERRIDE). classes.json
// does carry a label for them now, but it is the client's own — and the client's
// string tables predate the LATAM renames (they still say "Arquimágico",
// "Assassino", "Poeta", "Patrulheiro", "Ladino"), so ours wins.
//
// Shinkiro/Shiranui are the other half: the client ships no label for them in
// any language, so without a pin they would fall back to their base class
// (Kagerou/Oboro). Untranslated, like Kagerou and Oboro themselves.
export const JOB_NAME_OVERRIDE = {
  JT_DRAGON_KNIGHT: "Cavaleiro Draconiano",
  JT_MEISTER: "Engenheiro",
  JT_SHADOW_CROSS: "Executor",
  JT_ARCH_MAGE: "Magus",
  JT_CARDINAL: "Cardeal",
  JT_WINDHAWK: "Falcão do Vento",
  JT_IMPERIAL_GUARD: "Guardião Imperial",
  JT_BIOLO: "Cientista",
  JT_ABYSS_CHASER: "Mandraque",
  JT_ELEMENTAL_MASTER: "Elementalista",
  JT_INQUISITOR: "Inquisidor",
  JT_TROUBADOUR: "Maestro",
  JT_TROUVERE: "Diva",
  JT_SHINKIRO: "Shinkiro",
  JT_SHIRANUI: "Shiranui",
};

// Stat/utility food buffs carry a bare "%s" title in the client (it substitutes
// the food item name at runtime), so status.json would otherwise show a literal
// "%s". Descriptive pt-BR names keyed by EFST id — the CASH variants (271-276)
// are the same effect as the base ones (241-246). NOTE the client order is
// STR/AGI/VIT/DEX/INT/LUK (DEX before INT). See efstids.lub EFST_FOOD_*.
export const FOOD_STATUS_NAMES = {
  241: "Comida de FOR", 242: "Comida de AGI", 243: "Comida de VIT",
  244: "Comida de DES", 245: "Comida de INT", 246: "Comida de SOR",
  247: "Comida de Esquiva", 248: "Comida de Precisão", 249: "Comida de Crítico",
  271: "Comida de FOR", 272: "Comida de AGI", 273: "Comida de VIT",
  274: "Comida de DES", 275: "Comida de INT", 276: "Comida de SOR",
};

// ---------------------------------------------------------------------------
// Transforms — pure functions from a /raw array to the public/db/ object.
// Keys are numeric strings, so JSON.stringify emits them in ascending id order
// no matter what order we insert them in.
// ---------------------------------------------------------------------------

// item.json — { "<id>": { name, view? } }. Unnamed rows are skipped: ~640 items
// carry a `view` but no label, and the app has nothing to show for them.
export function buildItems(items) {
  const out = {};
  for (const it of items) {
    if (!it.name) continue;
    // Slotted gear is displayed with its slot count, like the client ("Faca" →
    // "Faca [3]"). /raw keeps `name` bare so consumers can format it freely.
    const rec = { name: it.slots > 0 ? `${it.name} [${it.slots}]` : it.name };
    // `view` is the client's ClassNum — the sprite id the character viewer needs
    // for headgears/costumes/garments/weapons. Kept only when set.
    if (it.view > 0) rec.view = it.view;
    out[String(it.id)] = rec;
  }
  return out;
}

// job.json — { "<id>": "<name>" }, player classes only.
//
// Two /raw tables feed this. jobs.json is the client's own numbering
// (pcidentity.lub) and covers the classic tree down to every baby and trans
// sprite, but it numbers nothing past Oboro — no 4th class, no Rebellion, no
// Summoner, no Star Emperor. classes.json is the playable-class table and
// numbers all of them, so it fills the gap; where both know a class they agree,
// and the client's own label is kept so existing names don't churn.
export function buildJobs(jobs, classes = []) {
  const labelByJt = new Map();
  const idByJt = new Map();
  // Extra ids that render the same class as their JT's main id — today only the
  // expanded 4th branch's always-mounted sprites (4309-4315), which we name too
  // rather than leave a replay showing "job#4314" if one ever carries it.
  const altIds = [];
  for (const j of jobs) {
    if (!j.jt) continue; // icon-only rows: an id with no name the client uses
    idByJt.set(j.jt, j.id);
    if (j.name) labelByJt.set(j.jt, j.name);
  }
  for (const c of classes) {
    if (!c.jt) continue;
    // `renderId` is the id the class packets carry (and the id its party icon is
    // filed under); `id` is the client's own, which differs only for the
    // expanded 4th classes. The client's numbering wins when it has one.
    const id = c.renderId ?? c.id;
    if (!idByJt.has(c.jt)) idByJt.set(c.jt, id);
    if (c.name && !labelByJt.has(c.jt)) labelByJt.set(c.jt, c.name);
    if (c.id != null && c.id !== id) altIds.push([c.jt, c.id]);
  }
  for (const [jt, id] of Object.entries(PLAYER_JT_IDS)) {
    if (!idByJt.has(jt)) idByJt.set(jt, id);
  }

  // Trans (_H), baby (_B) and alt-sprite ("2" — the mounted forms: Knight on a
  // peco, Rune Knight on a dragon, Meister in a madogear …) classes reuse the
  // base class label when the client doesn't give them one of their own. The
  // suffixes stack, so this peels them one at a time: JT_KNIGHT2_H → JT_KNIGHT2
  // → JT_KNIGHT.
  const baseOf = (jt) => {
    if (jt.endsWith("_H") || jt.endsWith("_B")) return jt.slice(0, -2);
    if (jt.endsWith("2")) return jt.slice(0, -1);
    return null;
  };
  const labelFor = (jt) => {
    for (let cur = jt; cur; cur = baseOf(cur)) {
      if (JOB_NAME_OVERRIDE[cur]) return JOB_NAME_OVERRIDE[cur];
      if (labelByJt.has(cur)) return labelByJt.get(cur);
    }
    return null;
  };

  const out = {};
  for (const [jt, id] of [...idByJt, ...altIds]) {
    const key = String(id);
    if (out[key]) continue; // first JT to name an id wins (alt sprites share ids)
    const label = labelFor(jt);
    if (label) out[key] = label;
  }
  return out;
}

// skill.json — { "<id>": { name } }.
export function buildSkills(skills) {
  const out = {};
  for (const s of skills) out[String(s.id)] = { name: s.name };
  return out;
}

// randomopt.json — { "<id>": "<template>" }. The value is a display template
// like "ATQM +%d"; the UI fills it in at runtime from the replay's (id, value).
export function buildRandomOpt(options) {
  const out = {};
  for (const o of options) out[String(o.id)] = o.name;
  return out;
}

// status.json — { "<id>": { name } }, keyed by EFST id (the id the
// status-change packets carry), with the food buffs named on top.
export function buildStatus(status) {
  const out = {};
  for (const s of status) out[String(s.id)] = { name: s.name };
  for (const [id, name] of Object.entries(FOOD_STATUS_NAMES)) out[id] = { name };
  return out;
}

// Source table(s) → output file; `sources` are passed to `build` in order.
// Order is the order they're written/logged in.
const TABLES = [
  { sources: ["items"], out: "item.json", build: buildItems },
  { sources: ["jobs", "classes"], out: "job.json", build: buildJobs },
  { sources: ["skills"], out: "skill.json", build: buildSkills },
  { sources: ["randomopt"], out: "randomopt.json", build: buildRandomOpt },
  { sources: ["status"], out: "status.json", build: buildStatus },
];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(argv) {
  const args = parseArgs(argv);
  const outDir = resolve(args.out ?? DEFAULT_OUT);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  for (const { sources, out, build } of TABLES) {
    const inputs = [];
    for (const source of sources) {
      const rows = await loadSource(source, args);
      if (!Array.isArray(rows) || rows.length === 0) {
        console.error(`Expected ${source}.json to be a non-empty JSON array.`);
        process.exit(1);
      }
      inputs.push(rows);
    }
    const table = build(...inputs);
    const outPath = join(outDir, out);
    // Compact JSON (no pretty-print) keeps the bundled files small.
    writeFileSync(outPath, JSON.stringify(table));
    console.log(`${out}: ${Object.keys(table).length} entries → ${outPath}`);
  }
}

async function loadSource(name, args) {
  if (args.input) {
    const p = resolve(args.input, `${name}.json`);
    console.log(`Reading ${p}`);
    return JSON.parse(readFileSync(p, "utf8"));
  }
  const url = `${args.url ?? DEFAULT_URL}/${name}.json`;
  console.log(`Fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`HTTP ${res.status} fetching ${url}`);
    process.exit(1);
  }
  return res.json();
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--input") out.input = argv[++i];
    else if (a === "--url") out.url = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else {
      console.error(
        "usage: node tools/sync-db.mjs [--input <raw-dir>] [--url <base-url>] [--out <dir>]",
      );
      process.exit(1);
    }
  }
  return out;
}

// The transforms are importable (tools/sync-db.test.mjs exercises them against
// committed fixtures); only a direct CLI invocation writes anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
