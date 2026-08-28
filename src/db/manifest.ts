// Resolves a logical reference-DB filename ("item.json") to the content-hashed
// one actually deployed ("item-1a2b3c4d.json"), via /db-manifest.json.
//
// Written by tools/hash-db.mjs at build time. In `vite dev` there is no manifest
// — public/db/ is served raw — so a missing/failed fetch falls back to the
// logical name and everything keeps working unhashed.
//
// PATHS ARE ABSOLUTE ON PURPOSE. These used to be relative ("./db/item.json")
// because vite is configured with `base: "./"`. That is a latent bug on any route
// reached with a trailing slash: "./db/item.json" from /leaderboard/ resolves to
// /leaderboard/db/item.json, which 404s into the SPA fallback, so `res.json()`
// throws on HTML and every name silently degrades to "item#123". Firebase Hosting
// masked it with `trailingSlash: false`; Cloudflare Workers assets have no such
// setting, so the migration would have exposed it. The app is only ever served
// from the domain root, so an absolute path is correct and cannot drift.

const MANIFEST_URL = "/db-manifest.json";

const DB_BASE = "/db";

let manifestP: Promise<Record<string, string>> | null = null;

function loadManifest(): Promise<Record<string, string>> {
  if (!manifestP) {
    manifestP = fetch(MANIFEST_URL)
      .then((res) => (res.ok ? res.json() : {}))
      .catch(() => ({}))
      .then((manifest: Record<string, string>) => {
        // The empty-manifest fallback is a DEV affordance: `vite dev` serves
        // public/db/ unhashed and has no manifest to serve. In a production
        // build the files have been RENAMED, so falling back to the logical name
        // requests a path that no longer exists — which the SPA fallback answers
        // with index.html and HTTP 200. The `res.ok` check downstream passes,
        // `res.json()` throws on HTML, and every name in the app silently
        // degrades to `item#123`.
        //
        // _headers calls this "the most correctness-critical file in the
        // deployment"; without this warning it could only ever fail invisibly.
        if (!import.meta.env.DEV && !Object.keys(manifest).length) {
          console.error(
            `[db] ${MANIFEST_URL} missing or empty in a production build — ` +
              "reference names will not resolve.",
          );
        }
        return manifest;
      });
  }
  return manifestP;
}

/** Absolute URL for a reference-DB file, hashed when a manifest is deployed. */
export async function dbUrl(fileName: string): Promise<string> {
  const manifest = await loadManifest();
  return `${DB_BASE}/${manifest[fileName] ?? fileName}`;
}
