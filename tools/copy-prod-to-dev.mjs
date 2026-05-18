#!/usr/bin/env node
// One-off: copy `replays/{id}` docs from prod into dev so the dev env has
// realistic test data (leaderboard, filters, classes, etc.). Admin SDK on
// both projects — bypasses rules. Skips docs that already exist in dev to
// preserve any local test uploads.
//
// Usage:
//   PROD_SA=/path/to/prod-service-account.json \
//   DEV_SA=/path/to/dev-service-account.json \
//     node tools/copy-prod-to-dev.mjs --dry-run
//   ... drop --dry-run to write
//   --force  : overwrite dev docs that already exist
//   --limit N: cap how many docs to copy (default: all)

import { readFile } from "node:fs/promises";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");
const limitIdx = process.argv.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? parseInt(process.argv[limitIdx + 1], 10) : Infinity;

const PROD_SA = process.env.PROD_SA;
const DEV_SA = process.env.DEV_SA;
if (!PROD_SA || !DEV_SA) {
  console.error(
    "Set PROD_SA and DEV_SA env vars to service-account JSON paths.",
  );
  process.exit(2);
}

const prodCreds = JSON.parse(await readFile(PROD_SA, "utf8"));
const devCreds = JSON.parse(await readFile(DEV_SA, "utf8"));

if (prodCreds.project_id === devCreds.project_id) {
  console.error(
    `Refusing to run: PROD and DEV credentials point at the same project (${prodCreds.project_id}).`,
  );
  process.exit(2);
}

const prodApp = initializeApp(
  { credential: cert(prodCreds), projectId: prodCreds.project_id },
  "prod",
);
const devApp = initializeApp(
  { credential: cert(devCreds), projectId: devCreds.project_id },
  "dev",
);
const prodFs = getFirestore(prodApp);
const devFs = getFirestore(devApp);

console.log(
  `From ${prodCreds.project_id} → ${devCreds.project_id}` +
    `${DRY_RUN ? " (DRY RUN)" : ""}${FORCE ? " (FORCE)" : ""}` +
    `${Number.isFinite(LIMIT) ? ` (limit ${LIMIT})` : ""}\n`,
);

const PAGE = 100;
let cursor = null;
let seen = 0;
let copied = 0;
let skipped = 0;
let failed = 0;

outer: while (true) {
  let q = prodFs.collection("replays").orderBy("__name__").limit(PAGE);
  if (cursor) q = q.startAfter(cursor);
  const snap = await q.get();
  if (snap.empty) break;

  for (const docSnap of snap.docs) {
    if (seen >= LIMIT) break outer;
    seen += 1;
    const id = docSnap.id;
    const data = docSnap.data();

    try {
      if (!FORCE) {
        const exists = await devFs.collection("replays").doc(id).get();
        if (exists.exists) {
          skipped += 1;
          process.stdout.write(`. ${id} (already in dev)\n`);
          continue;
        }
      }
      if (!DRY_RUN) {
        await devFs.collection("replays").doc(id).set(data);
      }
      copied += 1;
      console.log(`+ ${id}`);
    } catch (err) {
      failed += 1;
      console.error(`! ${id} — ${err.message}`);
    }
  }

  cursor = snap.docs[snap.docs.length - 1];
  if (snap.size < PAGE) break;
}

console.log(
  `\nDone. seen=${seen} ${DRY_RUN ? "would copy" : "copied"}=${copied} skipped=${skipped} failed=${failed}`,
);
process.exit(failed > 0 ? 1 : 0);
