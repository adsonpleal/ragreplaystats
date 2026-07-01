#!/usr/bin/env node
// Build public/db/monster.json — the monster name/HP/level table the app reads
// at runtime (src/names.ts → getMonsterName/getMonsterHp).
//
// Source of truth is the sibling project ragassets' mobs.json:
//   https://github.com/adsonpleal/ragassets/blob/main/mobs.json
// ragassets derives it from the client's navi data (mob id ↔ aegis name) and
// localizes it, then enriches each mob with HP/level/etc. That replaces the old
// Divine Pride scrape (tools/scrape-dp.mjs, now removed) — no runtime DP calls,
// no scraping here. We extract only what the UI consumes (name/hp/level); the
// rest of mobs.json (race, size, property, exp, boss/mvp flags, aegisId) is
// left upstream rather than bundled into the site.
//
// mobs.json shape: a JSON array of objects, e.g.
//   { "id": 1002, "aegisId": "PORING", "name": "Poring", "hp": 55, "level": 1, … }
// `name` is the localized (pt-BR) display name.
//
// Usage:
//   node tools/build-monsters.mjs                 # fetch from GitHub, write public/db/monster.json
//   node tools/build-monsters.mjs --input mobs.json   # use a local copy instead of fetching
//   node tools/build-monsters.mjs --url <url>     # override the source URL
//   node tools/build-monsters.mjs --out <path>    # override the output file

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

const DEFAULT_URL =
  "https://raw.githubusercontent.com/adsonpleal/ragassets/main/mobs.json";
const DEFAULT_OUT = "public/db/monster.json";

const args = parseArgs(process.argv.slice(2));
const outPath = resolve(args.out ?? DEFAULT_OUT);

const arr = await loadSource(args);
if (!Array.isArray(arr)) {
  console.error("Expected mobs.json to be a JSON array of mob objects.");
  process.exit(1);
}

const out = {};
let skipped = 0;
for (const e of arr) {
  // `id` and `name` are the only required fields; skip anything missing them so
  // we never write a `mob#undefined` or empty-name entry.
  if (e == null || e.id == null || !e.name) {
    skipped++;
    continue;
  }
  const rec = { name: String(e.name) };
  // HP feeds the max-HP fallback shown when a replay didn't report it; level is
  // kept for parity with the previous schema (and future use). Default missing
  // numerics to 0 rather than dropping the key, matching the old file's shape.
  rec.hp = Number.isFinite(e.hp) ? Math.round(e.hp) : 0;
  rec.level = Number.isFinite(e.level) ? Math.round(e.level) : 0;
  out[String(e.id)] = rec;
}

const dir = dirname(outPath);
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
// Compact JSON (no pretty-print) keeps the bundled file small.
writeFileSync(outPath, JSON.stringify(out));

console.log(
  `monster.json: ${Object.keys(out).length} entries → ${outPath}` +
    (skipped ? ` (${skipped} source row(s) skipped: missing id/name)` : ""),
);

async function loadSource(args) {
  if (args.input) {
    const p = resolve(args.input);
    console.log(`Reading ${p}`);
    return JSON.parse(readFileSync(p, "utf8"));
  }
  const url = args.url ?? DEFAULT_URL;
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
    else if (a === "-h" || a === "--help") {
      console.error(
        "usage: node tools/build-monsters.mjs [--input <mobs.json>] [--url <url>] [--out <path>]",
      );
      process.exit(1);
    }
  }
  return out;
}
