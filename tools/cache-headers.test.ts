// Guards public/_headers against the two failure modes that make Cloudflare's
// _headers format dangerous. Cloudflare applies EVERY matching rule and
// comma-joins repeated headers, with no override mechanism — so a single
// overlapping pattern silently corrupts the policy for every file it touches.
//
// Ported from the sibling project latam-ro-calc (tools/cache-headers.spec.ts),
// which learned this the hard way.

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";

const ROOT = resolve(__dirname, "..");
const HEADERS_FILE = join(ROOT, "public", "_headers");
const DIST = join(ROOT, "dist");

type Rule = { pattern: string; headers: string[] };

function parseHeaders(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "");
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) {
      rules.push({ pattern: line.trim(), headers: [] });
    } else if (rules.length) {
      rules[rules.length - 1].headers.push(line.trim());
    }
  }
  return rules;
}

/**
 * Cloudflare's `*` is greedy, crosses path segments, and matches the empty
 * string — which is why `/assets/*` also matches the bare directory `/assets/`.
 * A `:name` placeholder matches exactly one NON-EMPTY segment. Both behaviours
 * verified against `wrangler dev`; the checks below depend on the distinction.
 */
function toRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "[^/]+")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function walk(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else out.push("/" + relative(base, full).split(/[\\/]/).join("/"));
  }
  return out;
}

const rules = parseHeaders(readFileSync(HEADERS_FILE, "utf8"));

describe("public/_redirects", () => {
  // This exists because the redirect was lost silently in the move off Firebase.
  // It lived in firebase.json's `hosting` block; removing that block took it with
  // it, and nothing failed — /suggestions just fell through to the SPA fallback,
  // which answers 200 with index.html, so the router's catch-all rendered the
  // home page. An old link looked like it worked while landing somewhere else.
  const redirects = readFileSync(join(ROOT, "public", "_redirects"), "utf8");

  it("still 301s the retired /suggestions path to the tracker", () => {
    const rule = redirects
      .split(/\r?\n/)
      .find((l) => l.trim().startsWith("/suggestions"));
    expect(rule, "/suggestions redirect is missing").toBeDefined();
    expect(rule).toContain("issues.latam-tools.com.br");
    expect(rule).toContain("301");
  });

  it("ships to the build root", () => {
    const files = walk(DIST);
    if (!files.length) return;
    expect(files).toContain("/_redirects");
  });
});

describe("public/_headers", () => {
  it("declares at least one rule", () => {
    expect(rules.length).toBeGreaterThan(0);
  });

  it("has no catch-all — it would poison every other rule", () => {
    // `/*` next to an immutable rule emits both headers comma-joined, and the
    // most conservative one wins for every hashed bundle on the site.
    expect(rules.map((r) => r.pattern)).not.toContain("/*");
  });

  it("never gives the SPA shell a lifetime", () => {
    // The shell must inherit Cloudflare's `max-age=0, must-revalidate` default.
    // Naming it here is how a deploy gets stuck behind stale HTML — the exact
    // Firebase bug this migration retires (`/` was served with max-age=3600
    // because the `/**/*.@(html|json)` rule needed a literal extension).
    for (const r of rules) {
      expect(toRegExp(r.pattern).test("/")).toBe(false);
      expect(toRegExp(r.pattern).test("/index.html")).toBe(false);
    }
  });

  it("never marks a bare directory URL immutable", () => {
    // `/assets/` is answered by the SPA fallback with index.html. If a pattern
    // matched it, the shell would be served `immutable` and could pin itself in
    // a visitor's cache for a year. A `*` glob matches it; `:file` does not.
    for (const dir of ["/assets/", "/db/", "/fonts/"]) {
      for (const m of rules.filter((r) => toRegExp(r.pattern).test(dir))) {
        expect(
          m.headers.join(" "),
          `${dir} matched ${m.pattern} with an immutable policy`,
        ).not.toMatch(/immutable/);
      }
    }
  });

  it("keeps the db manifest out of the immutable /db/ rule", () => {
    // If the manifest were immutable the app would pin itself to one build's
    // hashed db files forever.
    const manifest = rules.filter((r) => toRegExp(r.pattern).test("/db-manifest.json"));
    expect(manifest).toHaveLength(1);
    expect(manifest[0].headers.join(" ")).toMatch(/no-cache/);
  });

  it("has mutually exclusive patterns across a real build", () => {
    const files = walk(DIST);
    if (!files.length) {
      // `npm run build` hasn't run in this working tree. The static checks above
      // still ran; this one needs real filenames to be meaningful.
      return;
    }
    const overlaps: string[] = [];
    for (const file of files) {
      const matched = rules.filter((r) => toRegExp(r.pattern).test(file));
      if (matched.length > 1) {
        overlaps.push(`${file} matched ${matched.map((m) => m.pattern).join(" + ")}`);
      }
    }
    expect(overlaps).toEqual([]);
  });

  it("marks every content-hashed build output immutable", () => {
    const files = walk(DIST);
    if (!files.length) return;
    // Vite's hashed bundles and hash-db.mjs's outputs are the files whose URL
    // changes per build, so they are exactly the ones safe to cache forever.
    const hashed = files.filter((f) => /-[0-9a-zA-Z_-]{8,}\.(js|css|json)$/.test(f));
    for (const file of hashed) {
      if (file === "/db-manifest.json") continue;
      const matched = rules.filter((r) => toRegExp(r.pattern).test(file));
      expect(
        matched.some((m) => m.headers.join(" ").includes("immutable")),
        `${file} is content-hashed but not immutable`,
      ).toBe(true);
    }
  });
});
