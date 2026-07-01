#!/usr/bin/env node
// Backfill `mvpRecords` on existing `replays/{id}` Firestore docs.
//
// Reads each existing doc, decodes its `bytes` blob, runs the same
// `mvpMatchups` aggregator that runs at upload time, and writes the result
// back. Idempotent — docs that already have a `mvpRecords` field are
// skipped (unless --force is passed).
//
// Usage:
//   firebase login                       # one-time
//   GOOGLE_APPLICATION_CREDENTIALS=path/to/service-account.json \
//     node tools/backfill-mvp-records.mjs                          # writes prod
//   node tools/backfill-mvp-records.mjs --project ragreplaystats-dev  # target dev
//   node tools/backfill-mvp-records.mjs --dry-run                  # no writes
//   node tools/backfill-mvp-records.mjs --force                    # re-overwrite
//
// Auth: relies on Application Default Credentials. The fastest path is a
// service-account JSON downloaded from Firebase Console → Project Settings
// → Service Accounts → Generate new private key, then export
// GOOGLE_APPLICATION_CREDENTIALS=<path>. The Firebase CLI's gcloud-style
// ADC also works if you've run `gcloud auth application-default login`.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "vite";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");
const projectFlagIdx = process.argv.indexOf("--project");
const PROJECT_ID =
  projectFlagIdx >= 0 ? process.argv[projectFlagIdx + 1] : "ragreplaystats";

// ---------------------------------------------------------------------------
// Bundle decoder + aggregator for Node. Same trick as tools/smoke.mjs — vite
// build to an in-memory ES module which we import via data: URL. Avoids
// shipping a pre-built artifact.
// ---------------------------------------------------------------------------

async function bundleModule(entry) {
  const result = await build({
    configFile: false,
    logLevel: "error",
    build: {
      write: false,
      target: "node18",
      lib: {
        entry: resolve(entry),
        formats: ["es"],
        fileName: () => "bundle.mjs",
      },
      rollupOptions: { external: [] },
    },
  });
  const out = Array.isArray(result) ? result[0] : result;
  const code = out.output[0].code;
  const dataUrl =
    "data:text/javascript;base64," + Buffer.from(code).toString("base64");
  return import(dataUrl);
}

console.log("Bundling decoder + aggregator…");
const decode = await bundleModule("src/rrf/decode.ts");
const aggregate = await bundleModule("src/aggregate/index.ts");

// ---------------------------------------------------------------------------
// Load the bundled monster name DB so resolveMob() produces real names.
// (Built by tools/build-monsters.mjs from ragassets' mobs.json.)
// ---------------------------------------------------------------------------

const monRaw = await readFile(resolve("public/db/monster.json"), "utf8");
const monDb = JSON.parse(monRaw);
function resolveMob(view) {
  const entry = monDb[String(view)];
  return entry?.name || `mob#${view}`;
}

const jobRaw = await readFile(resolve("public/db/job.json"), "utf8");
const jobDb = JSON.parse(jobRaw);
function resolveJob(id) {
  return jobDb[String(id)] ?? `job#${id}`;
}

// ---------------------------------------------------------------------------
// Firebase Admin init.
// ---------------------------------------------------------------------------

initializeApp({
  credential: applicationDefault(),
  projectId: PROJECT_ID,
});
const fs = getFirestore();

// ---------------------------------------------------------------------------
// Walk every replays doc; backfill mvpRecords where missing (or with --force,
// always). Pagination protects us against huge collections; ordering by
// __name__ is stable.
// ---------------------------------------------------------------------------

const PAGE_SIZE = 100;
let cursor = null;
let totalSeen = 0;
let totalWritten = 0;
let totalSkipped = 0;
let totalFailed = 0;

console.log(
  `\nBackfilling${DRY_RUN ? " (DRY RUN — no writes)" : ""}${FORCE ? " (FORCE — rewrites existing)" : ""}\n`,
);

while (true) {
  let q = fs.collection("replays").orderBy("__name__").limit(PAGE_SIZE);
  if (cursor) q = q.startAfter(cursor);
  const snap = await q.get();
  if (snap.empty) break;

  for (const docSnap of snap.docs) {
    totalSeen += 1;
    const id = docSnap.id;
    const data = docSnap.data();

    if (!FORCE && Array.isArray(data.mvpRecords)) {
      // Schema upgrades added `highestHit` and later `class` — re-aggregate
      // docs that lack either so existing records get the new fields. Once
      // every row has them, the script idempotently no-ops. Empty array is
      // a valid up-to-date state (no boss in the recording).
      const missingNewFields = data.mvpRecords.some(
        (r) =>
          typeof r?.highestHit !== "number" || typeof r?.class !== "string",
      );
      if (!missingNewFields) {
        totalSkipped += 1;
        process.stdout.write(
          `. ${id} (already has ${data.mvpRecords.length} records)\n`,
        );
        continue;
      }
    }

    const bytes = data.bytes;
    if (!bytes) {
      console.warn(`! ${id} — no bytes field, skipping`);
      totalFailed += 1;
      continue;
    }

    try {
      const buf = bytes.toUint8Array
        ? bytes.toUint8Array()
        : Buffer.isBuffer(bytes)
          ? bytes
          : new Uint8Array(bytes);
      const replay = decode.decodeReplay(
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      );
      const records = aggregate.mvpMatchups(replay, resolveMob, resolveJob);

      // Sanitize like uploadReplay does — defensive against shape drift.
      const payload = records.slice(0, 200).map((r) => ({
        view: Math.round(r.view),
        name: String(r.name).slice(0, 40),
        playerAid: Math.round(r.playerAid),
        playerName: String(r.playerName).slice(0, 50),
        class: String(r.class ?? "").slice(0, 30),
        totalDamage: Math.round(r.totalDamage),
        highestHit: Math.round(r.highestHit ?? 0),
        combatSpanMs: Math.round(r.combatSpanMs),
        dps: Math.round(r.dps),
      }));

      console.log(`+ ${id} → ${payload.length} records`);

      if (!DRY_RUN) {
        await docSnap.ref.update({ mvpRecords: payload });
      }
      totalWritten += 1;
    } catch (err) {
      console.error(`! ${id} — ${err.message}`);
      totalFailed += 1;
    }
  }

  cursor = snap.docs[snap.docs.length - 1];
  if (snap.size < PAGE_SIZE) break;
}

console.log(
  `\nDone. Seen: ${totalSeen}, ${DRY_RUN ? "would write" : "wrote"}: ${totalWritten}, skipped: ${totalSkipped}, failed: ${totalFailed}`,
);
process.exit(totalFailed > 0 ? 1 : 0);
