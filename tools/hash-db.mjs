#!/usr/bin/env node
// Content-hash the reference DBs in dist/db/ and emit dist/db-manifest.json.
//
// WHY: public/db/*.json (item, job, monster, randomopt, skill, status — ~830 KB)
// ship at stable URLs. That leaves only two bad options: cache them and a
// `npm run build:db` after a client patch is invisible behind a stale cache, or
// revalidate them and every page load pays six conditional round-trips. Hashing
// gets both — immutable caching AND an update that lands the moment it deploys,
// because a changed file is a changed URL.
//
// The manifest maps logical name -> hashed name:
//   { "item.json": "item-1a2b3c4d.json", ... }
// and is written to the dist ROOT, not into dist/db/. That is deliberate: the
// `/db/*` rule in public/_headers is greedy and would otherwise mark the manifest
// immutable too, which would pin the whole scheme to one build forever.
//
// Runs after `vite build` and before prerender (the prerendered HTML boots the
// real app, which fetches the manifest — so the manifest must already exist).
//
// Usage: node tools/hash-db.mjs [--dist dir]

import { createHash } from "node:crypto";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DIST = resolve(__dirname, "..", arg("--dist", "dist"));
const DB_DIR = join(DIST, "db");
const MANIFEST = join(DIST, "db-manifest.json");

const files = (await readdir(DB_DIR)).filter((f) => f.endsWith(".json"));
if (!files.length) {
  console.error(`hash-db: no .json files in ${DB_DIR}`);
  process.exit(1);
}

const manifest = {};
for (const name of files.sort()) {
  const src = join(DB_DIR, name);
  const buf = await readFile(src);
  // 8 hex chars of sha-256 — same length Vite uses, ample against accidental
  // collision across a handful of files.
  const hash = createHash("sha256").update(buf).digest("hex").slice(0, 8);
  const hashed = name.replace(/\.json$/, `-${hash}.json`);
  await rename(src, join(DB_DIR, hashed));
  manifest[name] = hashed;
  console.log(`hash-db: ${name} -> ${hashed} (${(buf.length / 1024).toFixed(0)} KB)`);
}

await writeFile(MANIFEST, JSON.stringify(manifest), "utf8");
console.log(`hash-db: wrote ${MANIFEST} (${files.length} entries)`);
