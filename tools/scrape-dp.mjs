#!/usr/bin/env node
// Offline scraper for the Divine Pride listing pages. Walks the paginated
// search pages (/database/{kind}?Page=N), extracts id + name (and HP/level
// for monsters), and writes each kind to public/db/dp-{kind}.json so the
// static site bundles it.
//
// Usage:
//   node tools/scrape-dp.mjs                      # all public kinds
//   node tools/scrape-dp.mjs --kinds=monster      # subset
//   DP_COOKIE="..." node tools/scrape-dp.mjs --kinds=efst   # buffs (need login)
//
// Buffs (efst) require login on DP — pass `DP_COOKIE=...` (the value of
// .ASPXAUTH from a logged-in browser session) to populate them. Without
// it, buffs are skipped with a warning.
//
// After the monster kind is scraped, a Firestore harvest pass walks
// every recording in `replays/` (Spark-tier, public read), collects the
// view ids referenced by mob/npc entities, and fills in any ids the
// listing scrape missed by hitting `/database/monster/<id>` directly.
// This is the offline replacement for the old runtime fallback —
// everything DP-related stays out of the browser.
//
// Politeness: concurrency 3, ~200 ms delay between page fetches.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const BASE = "https://www.divine-pride.net/database";
const LANG_HEADER = "pt-BR,pt;q=0.9";
const USER_AGENT = "ragreplaystats-scraper/1.0";
const CONCURRENCY = 3;
const INTER_PAGE_DELAY_MS = 200;
const OUT_DIR = resolve("public/db");
const FIRESTORE_BASE =
  "https://firestore.googleapis.com/v1/projects/ragreplaystats/databases/(default)/documents/replays";

// `kind` here matches the output filename (`public/db/dp-{kind}.json`).
// `extraParams` are appended before `Page=N`. `needsAuth` flags collections
// whose listing page requires .ASPXAUTH (efst).
const KINDS = {
  item:    { path: "item",    extraParams: "find=Busca", needsAuth: false },
  monster: { path: "monster", extraParams: "",           needsAuth: false },
  skill:   { path: "skill",   extraParams: "",           needsAuth: false },
  efst:    { path: "efst",    extraParams: "",           needsAuth: true  },
};

const args = parseArgs(process.argv.slice(2));
const onlyKinds = args.kinds ? args.kinds.split(",") : Object.keys(KINDS);
const cookie = process.env.DP_COOKIE ?? "";

if (args["self-test"]) {
  await selfTest();
  process.exit(0);
}

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

for (const kind of onlyKinds) {
  const cfg = KINDS[kind];
  if (!cfg) {
    console.error(`unknown kind: ${kind}`);
    process.exit(1);
  }
  if (cfg.needsAuth && !cookie) {
    console.warn(`[skip] ${kind}: needs DP_COOKIE — skipping`);
    continue;
  }
  console.log(`[start] ${kind}`);
  const data = await scrapeKind(kind, cfg);
  const outPath = resolve(OUT_DIR, `dp-${kind}.json`);
  // Compact JSON (no pretty-print) keeps the bundled file small.
  writeFileSync(outPath, JSON.stringify(data));
  console.log(`[done]  ${kind}: ${Object.keys(data).length} entries → ${outPath}`);
}

if (onlyKinds.includes("monster") && !args["skip-harvest"]) {
  await harvestFromReplays();
}

// ---------------------------------------------------------------------------
// Firestore harvest — walk every shared replay, collect mob/npc view ids
// referenced in `replay.entities`, and fill in any that the listing scrape
// missed by hitting DP's per-id pages.

async function harvestFromReplays() {
  const dbPath = resolve(OUT_DIR, "dp-monster.json");
  if (!existsSync(dbPath)) {
    console.warn("[harvest] dp-monster.json missing — run --kinds=monster first");
    return;
  }
  const existing = JSON.parse(readFileSync(dbPath, "utf8"));

  console.log("[harvest] building decoder bundle");
  const decoder = await loadDecoder();
  console.log("[harvest] walking Firestore replays/ collection");
  const referenced = await collectMobViewsFromFirestore(decoder);
  console.log(`[harvest] ${referenced.size} distinct mob/npc view ids referenced across all replays`);

  const missing = [...referenced].filter((id) => !(String(id) in existing) && id > 0);
  if (missing.length === 0) {
    console.log("[harvest] no new ids to fetch");
    return;
  }
  console.log(`[harvest] ${missing.length} ids missing from listing — fetching per-id from DP`);

  const added = {};
  let done = 0;
  await pool(missing, async (id) => {
    const entry = await fetchMonsterById(id);
    done++;
    if (entry) {
      added[id] = entry;
      console.log(`  ${id} → "${entry.name}" hp=${entry.hp}`);
    } else {
      console.log(`  ${id} → (no name)`);
    }
    if (done % 10 === 0) console.log(`  progress: ${done}/${missing.length}`);
    await sleep(INTER_PAGE_DELAY_MS);
  }, CONCURRENCY);

  if (Object.keys(added).length === 0) {
    console.log("[harvest] no ids resolved");
    return;
  }
  const merged = { ...existing, ...added };
  writeFileSync(dbPath, JSON.stringify(merged));
  console.log(`[harvest] +${Object.keys(added).length} entries → ${dbPath} (now ${Object.keys(merged).length} total)`);
}

async function collectMobViewsFromFirestore(decoder) {
  const referenced = new Set();
  let pageToken = null;
  let docCount = 0;
  let decodeFailures = 0;
  do {
    const url = new URL(FIRESTORE_BASE);
    url.searchParams.set("pageSize", "50");
    url.searchParams.append("mask.fieldPaths", "bytes");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`Firestore list: HTTP ${res.status}`);
    const data = await res.json();
    for (const doc of data.documents ?? []) {
      docCount++;
      const b64 = doc.fields?.bytes?.bytesValue;
      if (!b64) continue;
      const buf = Buffer.from(b64, "base64");
      try {
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        const replay = decoder.decodeReplay(ab);
        for (const ent of replay.entities.values()) {
          // kind="npc" entities mostly have NPC sprite ids that DP's monster
          // database doesn't track (instructors, shopkeepers, etc.) — fetching
          // them just wastes per-id requests. Real damageable dummies arrive
          // as kind="mob".
          if (ent.kind !== "mob") continue;
          if (!ent.view || ent.view <= 0) continue;
          referenced.add(ent.view);
        }
      } catch {
        decodeFailures++;
      }
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  console.log(`[harvest] walked ${docCount} replays (${decodeFailures} decode failures)`);
  return referenced;
}

async function loadDecoder() {
  const { build } = await import("vite");
  const result = await build({
    configFile: false,
    logLevel: "error",
    build: {
      write: false,
      target: "node18",
      lib: {
        entry: resolve("src/rrf/decode.ts"),
        formats: ["es"],
        fileName: () => "decode.mjs",
      },
      rollupOptions: { external: [] },
    },
  });
  const out = Array.isArray(result) ? result[0] : result;
  const code = out.output[0].code;
  const dataUrl = "data:text/javascript;base64," + Buffer.from(code).toString("base64");
  return await import(dataUrl);
}

async function fetchMonsterById(id) {
  try {
    const res = await fetch(`${BASE}/monster/${id}`, {
      headers: { "Accept-Language": LANG_HEADER, "User-Agent": USER_AGENT },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const og = html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i);
    if (!og) return null;
    const decoded = decodeEntities(og[1]);
    // Strip the localized "Monstro: " / "Monster: " prefix.
    const sep = decoded.indexOf(": ");
    const name = (sep >= 0 ? decoded.slice(sep + 2) : decoded).trim();
    if (!name) return null;
    // First HP value on the page wins. The bold span wraps a pt-BR
    // formatted number ("23.986" → 23986).
    const hpMatch = html.match(
      /<span\s+style="font-weight:\s*bold;\s*">\s*([\d.]+)\s*<\/span>\s*HP\b/i,
    );
    const hp = hpMatch ? parseLocaleInt(hpMatch[1]) : 0;
    // Per-id pages don't surface level reliably on pt-BR; default to 0
    // (the UI doesn't read level off the bundled DB anyway).
    return { name, hp, level: 0 };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Scrape

async function scrapeKind(kind, cfg) {
  const firstHtml = await fetchPage(kind, 1, cfg);
  const maxPage = parseMaxPage(firstHtml) ?? 1;
  console.log(`  ${kind}: ${maxPage} page(s)`);

  const out = {};
  Object.assign(out, parseRows(kind, firstHtml));

  if (maxPage <= 1) return out;
  const rest = [];
  for (let p = 2; p <= maxPage; p++) rest.push(p);

  let done = 1;
  await pool(rest, async (p) => {
    const html = await fetchPage(kind, p, cfg);
    Object.assign(out, parseRows(kind, html));
    done++;
    if (done % 25 === 0 || done === maxPage) {
      console.log(`  ${kind}: ${done}/${maxPage} pages, ${Object.keys(out).length} entries so far`);
    }
    await sleep(INTER_PAGE_DELAY_MS);
  }, CONCURRENCY);

  return out;
}

async function fetchPage(kind, page, cfg) {
  const q = cfg.extraParams ? `${cfg.extraParams}&` : "";
  const url = `${BASE}/${cfg.path}?${q}Page=${page}`;
  const headers = {
    "Accept-Language": LANG_HEADER,
    "User-Agent": USER_AGENT,
  };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

// ---------------------------------------------------------------------------
// Parsers

function parseMaxPage(html) {
  const m = html.match(/page-link"\s+href="[^"]*Page=(\d+)"\s*>\s*Last\s*</i);
  return m ? Number(m[1]) : null;
}

function parseRows(kind, html) {
  switch (kind) {
    case "item":    return parseItemRows(html);
    case "monster": return parseMonsterRows(html);
    case "skill":   return parseSkillRows(html);
    case "efst":    return parseEfstRows(html);
  }
  throw new Error(`no parser for ${kind}`);
}

// Items: each row has `<a href="/database/item/<id>/<slug>">Name</a>` inside
// the tbody. Some names are Korean placeholders for unreleased items —
// preserve verbatim, that's what DP serves.
function parseItemRows(html) {
  const out = {};
  const re = /<a href="\/database\/item\/(\d+)\/[^"]*">([^<]+)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const id = m[1];
    const name = decodeEntities(m[2].trim());
    if (!name) continue;
    out[id] = { name };
  }
  return out;
}

// Monsters: row layout is
//   <td class="right">LEVEL</td>
//   <td>...<a href="/database/monster/<id>/<slug>">Name</a>...</td>
//   <td class="right"><span>HP</span></td>
//   ... more columns ignored ...
// The level cell is `<td class="right">LEVEL</td>` — bare number, no span,
// distinguishable from the wrapped `<span>HP</span>` cell after the name.
// Numbers in DP are pt-BR formatted with `.` thousands separators (e.g.
// HP=80.811 = 80,811), so the value pattern must accept dots.
function parseMonsterRows(html) {
  const out = {};
  const re =
    /<td\s+class="right"[^>]*>\s*([\d.]+)\s*<\/td>\s*<td[^>]*>[\s\S]*?<a href="\/database\/monster\/(\d+)\/[^"]*">([^<]+)<\/a>[\s\S]*?<td\s+class="right"[^>]*>\s*<span[^>]*>\s*([\d.]+)\s*<\/span>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const level = parseLocaleInt(m[1]);
    const id = m[2];
    const name = decodeEntities(m[3].trim());
    const hp = parseLocaleInt(m[4]);
    if (!name) continue;
    out[id] = { name, hp, level };
  }
  return out;
}

function parseLocaleInt(s) {
  // pt-BR: "80.811" → 80811. Stripping all dots is safe since the cells
  // are always integers (HP / Lvl), never decimals.
  return parseInt(s.replace(/\./g, ""), 10) || 0;
}

// Skills: single-td rows with `<a href="/database/skill/<id>/<slug>">Name</a>`.
// Many show `NPC_*` / `EFST_*` constants for un-localized entries —
// preserve verbatim; per-id pages return the same.
function parseSkillRows(html) {
  const out = {};
  const re = /<a href="\/database\/skill\/(\d+)\/[^"]*">([^<]+)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const id = m[1];
    const name = decodeEntities(m[2].trim());
    if (!name) continue;
    out[id] = { name };
  }
  return out;
}

// Buffs (EFST): same shape as skills — `<a href="/database/efst/<id>/...">Name</a>`.
// Auth is checked at fetch time; if the cookie isn't valid the body comes
// back with an empty <tbody>, which yields zero matches and we just don't
// populate anything (no false positives).
function parseEfstRows(html) {
  const out = {};
  const re = /<a href="\/database\/efst\/(\d+)\/[^"]*">([^<]+)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const id = m[1];
    const name = decodeEntities(m[2].trim());
    if (!name) continue;
    out[id] = { name };
  }
  return out;
}

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

// ---------------------------------------------------------------------------
// Self-test (offline, against pre-saved /tmp/dp-*-search.html files)

async function selfTest() {
  const fixtures = [
    { kind: "monster", file: "/tmp/dp-monster-search.html", probe: "1002" },
    { kind: "item",    file: "/tmp/dp-item-search.html",    probe: "22593" },
    { kind: "skill",   file: "/tmp/dp-skill-search.html",   probe: "795" },
    { kind: "efst",    file: "/tmp/dp-efst-search.html",    probe: null },
  ];
  for (const f of fixtures) {
    if (!existsSync(f.file)) {
      console.warn(`[skip] ${f.kind}: ${f.file} not found (run the curl probes first)`);
      continue;
    }
    const html = readFileSync(f.file, "utf8");
    const rows = parseRows(f.kind, html);
    const max = parseMaxPage(html);
    console.log(`${f.kind}: ${Object.keys(rows).length} rows, maxPage=${max}`);
    if (f.probe && rows[f.probe]) {
      console.log(`  ${f.probe} → ${JSON.stringify(rows[f.probe])}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (!a.startsWith("--")) continue;
    const [k, v = "true"] = a.slice(2).split("=");
    out[k] = v;
  }
  return out;
}

async function pool(items, fn, concurrency) {
  const queue = [...items];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        await fn(item);
      } catch (e) {
        console.error(`  error: ${e.message}`);
      }
    }
  });
  await Promise.all(workers);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
