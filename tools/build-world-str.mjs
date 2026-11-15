#!/usr/bin/env node
// Build public/db/world-str.json — the CLIENT's own effect id → .str file table
// — from rustnarok-client's `src/fx/world_str.txt`.
//
// WHY THIS EXISTS
// ---------------
// Until now the only answer to "what does effect N look like?" came from the
// ragassets gateway's roBrowser-derived EffectTable (`/effect/table`). That
// table stops being the client's table at the top of its id space. The two name
// only 21 of the same ids at all, and of those they agree on 4 and differ on 17:
// 204-209 are the same asset under two spellings, 1062 is a real disagreement
// (the gateway serves a `stormgust` placeholder where the client has
// RL_HAMMER_OF_GOD), and 1873..1883 are roBrowser UI flourishes (new_failed,
// ui_intro_yellow, ui_levelup_success…) where the client has WH_DEEPBLINDTRAP,
// WH_SWIFTTRAP and WH_SOLIDTRAP. So the clean "they agree below N" story is not
// true — 1062 sits well under the trap range — and the precedence rule below
// does not rely on it. Of the ids this file names the gateway table has a STR
// row for only 21.
//
// So this is the modern half of the effect table, and it is why the hand-written
// MODERN_EFFECT_OVERRIDES in src/sim/render/effectAssets.ts existed: each was an
// id roBrowser ships as an empty stub. Those nine entries are data, recovered one
// at a time from the client; this file supplies 1198 of them at once.
//
// TWO ID SPACES, ONE RESOLVER. An effect id can mean different things depending
// on where it came from:
//   * from the gateway skill-map        → a roBrowser id
//   * from effect-dispatch.json or a
//     0x01f3 ZC_NOTIFY_EFFECT packet    → a CLIENT id
// Above ~1100 the same number can name a different effect in each. There is only
// ONE resolver — loadEffect in src/sim/render/effectAssets.ts — and it does NOT
// keep the two apart: it overlays this table onto whatever id it is handed. That
// is a deliberate bet, not an oversight, and the numbers behind it are small
// enough to state: of the 17 ids where the two tables disagree, exactly one is
// reachable from the skill-map or the dispatch table (1062), and there the
// client's file is the right one. Anything that widens this table has to re-check
// that bet rather than assume it.
//
// WHAT A ROW CARRIES
//   file    under data\texture\effect\, forward slashes, no .str. `%d` picks a
//           variant 1..3 at play time, exactly like the gateway's STR rows.
//   min     the file /mineffect plays instead (the client's "minimum effects"
//           setting). Kept for completeness; we always play the full one.
//   flags   single (relaunching for the same owner returns the running copy),
//           loop (restart at the end), owner (lives while its owner does)
//   head    where the STR sits: feet + 80px by default, the hat tables ("hat"),
//           an explicit dx/height adjust, or a camera-relative view offset
//   tint    alpha a tick the full-screen black fill gains, capped at 170
//   events  sounds (data\wav\) and camera quakes at a given age in 16 ms ticks
//
// NOT IMPORTED: rows whose file is `-` (named by whoever launches the STR) or
// `lua` (named by the hat tables) — we have no launch-by-name path and no hat
// tables, so there is nothing to resolve them to. Nor rows whose file carries a
// placeholder we do not substitute: `%d` is resolved at play time, but upstream's
// own debug rows (`test_effect/%02d/%02d`) are not, and importing them would ship
// a handful of guaranteed 404s.
//
// Usage:
//   node tools/build-world-str.mjs                 # fetch the pinned upstream revision
//   node tools/build-world-str.mjs --src <file>    # use a local world_str.txt
//   node tools/build-world-str.mjs --out <file>    # write somewhere else

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/** Upstream source, pinned by commit so a rebuild is reproducible. */
export const UPSTREAM = {
  repo: "kindraywind/rustnarok-client",
  commit: "c01cce3e5b37d8c4eb377d290f8dbe3f93a862de",
  file: "src/fx/world_str.txt",
  license: "MIT OR Apache-2.0",
};
const RAW_URL = `https://raw.githubusercontent.com/${UPSTREAM.repo}/${UPSTREAM.commit}/${UPSTREAM.file}`;

/** An STR tick is 16 ms — the unit of every `w<tick>` / `q<tick>` event. */
const TICK_MS = 16;
/** Default anchor: the STR's own (0, -80) px rise over the owner's feet. */
const RISE_PX = 80;
/** The one id whose STR sits on the point itself, with no rise. It is also the
 *  one launch-named row we skip, so it names no row in `rows` — it is here for a
 *  future consumer of the anchor rule, not for anything shipped today. */
const NO_RISE = 1412;
/** The one id whose head-height rule starts from 18 instead of 0. */
const LOW_HEAD = 1817;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function source() {
  const local = arg("--src");
  if (local) return readFile(resolve(process.cwd(), local), "utf8");
  const res = await fetch(RAW_URL);
  if (!res.ok) throw new Error(`${RAW_URL} → HTTP ${res.status}`);
  return res.text();
}

/** `-` is the table's "no value here". */
const dash = (field) => (field === "-" ? null : field);

/** A whole non-negative integer, as Rust's `u32::from_str` takes one: no sign,
 *  no decimal point, no empty string (`Number("")` is 0, which would quietly
 *  turn a missing id or tick into id 0 / tick 0). */
const u32 = (text) => (/^\d+$/.test(text) ? Number(text) : null);

/** A finite number, rejecting the empty string for the same reason. */
function f32(text) {
  if (text.trim() === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** A `a,b` pair, split at the FIRST comma with the rest parsed whole — upstream
 *  uses `split_once`, so `1,2,3` is not (1, 2) but a parse failure. */
function pair(text) {
  const comma = text.indexOf(",");
  if (comma < 0) return null;
  const a = f32(text.slice(0, comma));
  const b = f32(text.slice(comma + 1));
  return a == null || b == null ? null : [a, b];
}

/**
 * The head column: where the STR sits. `-` is the default 80px rise above the
 * feet, `lua` defers to the hat tables, `view:dx,dy` is a camera-relative offset
 * from the feet, and a bare `dx,adjust` pair is the client's head-height rule.
 *
 * `lua` keeps a sentinel of its own rather than collapsing into the default: 151
 * of the rows we import carry it, and once it is gone there is no telling them
 * apart from the feet default — a future head consumer would hang them 80px over
 * the feet instead of on the headgear. Nothing reads `head` yet, which is exactly
 * why the distinction has to survive the conversion.
 */
function head(field) {
  if (field === "-") return null;
  if (field === "lua") return "hat";
  if (field.startsWith("view:")) {
    const offset = pair(field.slice(5));
    return offset ? { view: offset } : null;
  }
  return pair(field);
}

/**
 * A sound as the gateway wants it: GRF-relative, forward slashes, no extension
 * (`effect\RL_HAMMER_OF_GOD.wav` → `effect/RL_HAMMER_OF_GOD`), which is the same
 * shape the effect table's own `wav` fields arrive in.
 */
const wav = (file) => file.replace(/\\/g, "/").replace(/\.wav$/i, "");

/** `w<tick>:<wav>` and `q<tick>`, `;`-separated, both keyed by age in ticks. */
function events(field) {
  const sounds = [];
  const quakes = [];
  for (const event of (dash(field) ?? "").split(";")) {
    if (event.startsWith("w")) {
      const at = event.indexOf(":");
      const tick = at > 0 ? u32(event.slice(1, at)) : null;
      if (tick != null) sounds.push([tick * TICK_MS, wav(event.slice(at + 1))]);
    } else if (event.startsWith("q")) {
      const tick = u32(event.slice(1));
      if (tick != null) quakes.push(tick * TICK_MS);
    }
  }
  return { sounds, quakes };
}

/**
 * Parse world_str.txt into `{ rows, launchNamed, hatNamed }`. A row is written
 * with its defaults OMITTED, not as false/0/[] — the table ships to every
 * viewer, so a plain effect stays one field long.
 */
export function parseWorldStr(text) {
  const rows = {};
  let launchNamed = 0;
  let hatNamed = 0;
  let unsubstituted = 0;

  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const fields = line.split("\t");
    if (fields.length !== 7) continue;
    const [rawId, file, min, flags, rawHead, rawTint, rawEvents] = fields;
    const id = u32(rawId);
    if (id == null) continue;
    // A file we cannot resolve on our own is no use to us: `-` is named by
    // whoever launches the STR, `lua` by the hat tables.
    if (file === "-") {
      launchNamed++;
      continue;
    }
    if (file === "lua") {
      hatNamed++;
      continue;
    }
    // A placeholder we do not substitute (upstream's `test_effect/%02d/%02d`
    // debug rows). `%d` IS substituted at play time, so it stays.
    if (file.includes("%") && !file.includes("%d")) {
      unsubstituted++;
      continue;
    }

    const flag = (name) => flags.split(",").includes(name);
    const { sounds, quakes } = events(rawEvents);
    const tint = Number(rawTint);
    const anchor = head(rawHead);

    const row = { file };
    const minFile = dash(min);
    if (minFile) row.min = minFile;
    if (flag("single")) row.single = true;
    if (flag("loop")) row.loop = true;
    if (flag("owner")) row.owner = true;
    if (anchor) row.head = anchor;
    if (Number.isFinite(tint) && tint > 0) row.tint = tint;
    if (sounds.length) row.sounds = sounds;
    if (quakes.length) row.quakes = quakes;
    rows[id] = row;
  }

  return { rows, launchNamed, hatNamed, unsubstituted };
}

async function main() {
  const { rows, launchNamed, hatNamed, unsubstituted } = parseWorldStr(await source());
  const json = {
    _source: UPSTREAM,
    risePx: RISE_PX,
    noRise: NO_RISE,
    lowHead: LOW_HEAD,
    rows,
  };

  const outPath = resolve(ROOT, arg("--out") ?? "public/db/world-str.json");
  await writeFile(outPath, JSON.stringify(json));

  const count = (pred) => Object.values(rows).filter(pred).length;
  console.log(
    `world-str.json written to ${outPath}\n` +
      `  rows ${Object.keys(rows).length} · single ${count((r) => r.single)} · ` +
      `loop ${count((r) => r.loop)} · owner ${count((r) => r.owner)} · ` +
      `head ${count((r) => r.head)} (hat ${count((r) => r.head === "hat")}) · ` +
      `tint ${count((r) => r.tint)} · ` +
      `sounds ${count((r) => r.sounds)} · quakes ${count((r) => r.quakes)}\n` +
      `  skipped ${launchNamed} launch-named + ${hatNamed} hat-named + ` +
      `${unsubstituted} placeholder rows`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
