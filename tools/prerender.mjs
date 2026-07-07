#!/usr/bin/env node
// Post-build prerender for the SEO-relevant static routes + the social image.
//
// The app is a client-rendered SPA, so a fresh crawl (or a non-JS social
// crawler like Discord/Twitter) sees only the empty index.html shell. This
// script boots the *built* app in a headless browser, lets React + the useSeo
// hook run, and snapshots the resulting HTML for each static route into its own
// file so the served HTML already carries real content + the right <head>:
//
//   /            -> dist/index.html            (overwritten; also the SPA fallback)
//   /leaderboard -> dist/leaderboard/index.html
//   /suggestions -> dist/suggestions/index.html
//
// Firebase Hosting serves an exact file match before the `** -> /index.html`
// rewrite, so those per-route files are what crawlers get; the client router
// still takes over once the bundle boots. It also renders dist/og.png (1200x630)
// for the og:image / twitter:image tags.
//
// Runs as the last step of `npm run build`. It is intentionally NON-FATAL: any
// failure (no headless browser, launch error, timeout) logs a warning and exits
// 0, falling back to the plain SPA shell rather than breaking the deploy.
//
// Usage: node tools/prerender.mjs [--dist dir] [--og-only]
//   --og-only  regenerate just dist/og.png (skip the route snapshots)

import { createServer } from "node:http";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { resolve, join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DIST = resolve(__dirname, "..", arg("--dist", "dist"));
const OG_ONLY = process.argv.includes("--og-only");

// Route path -> output file (relative to dist).
const ROUTES = {
  "/": "index.html",
  "/leaderboard": "leaderboard/index.html",
  "/suggestions": "suggestions/index.html",
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

// Minimal static server with SPA fallback (serves index.html for unknown paths
// so the client router can render any route in the headless browser).
function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
      let filePath = join(DIST, urlPath);
      let info = await stat(filePath).catch(() => null);
      if (info?.isDirectory()) {
        filePath = join(filePath, "index.html");
        info = await stat(filePath).catch(() => null);
      }
      if (!info?.isFile()) filePath = join(DIST, "index.html"); // SPA fallback
      const body = await readFile(filePath);
      res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
      res.end(body);
    } catch (err) {
      res.writeHead(500);
      res.end(String(err));
    }
  });
  return new Promise((res) => server.listen(0, "127.0.0.1", () => res(server)));
}

// og:image template — brand card at exactly 1200x630, system fonts (no external
// font fetch to keep the screenshot deterministic offline). Matches the app's
// dark theme (--bg #161616 / --accent #ff7a55) rather than the favicon pink.
const OG_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0}
  .card{position:relative;overflow:hidden;width:1200px;height:630px;box-sizing:border-box;
    display:flex;flex-direction:column;justify-content:center;gap:30px;padding:84px;
    font-family:'Segoe UI',system-ui,Roboto,Helvetica,Arial,sans-serif;color:#eaeaea;
    background:#161616}
  /* soft coral glow + a faint border to lift the card off a dark timeline */
  .card::before{content:"";position:absolute;top:-260px;right:-200px;width:760px;height:760px;
    border-radius:50%;background:radial-gradient(circle,rgba(255,122,85,.42) 0%,rgba(255,122,85,0) 70%)}
  .card::after{content:"";position:absolute;inset:0;border:1px solid #2f2f2f}
  .brand{position:relative;display:flex;align-items:center;gap:30px}
  .logo{width:132px;height:132px;border-radius:50%;color:#161616;font-weight:800;font-size:82px;
    display:flex;align-items:center;justify-content:center;
    background:linear-gradient(135deg,#ff9165,#ff7a55);box-shadow:0 10px 40px rgba(255,122,85,.35)}
  .name{font-size:88px;font-weight:800;letter-spacing:-1px}
  .name b{color:#ff7a55;font-weight:800}
  .tag{position:relative;font-size:42px;font-weight:600;line-height:1.28;max-width:1000px;color:#dcdcdc}
  .tag b{color:#fff;font-weight:700}
  .foot{position:relative;font-size:30px;font-weight:700;color:#ff7a55;letter-spacing:.2px}
</style></head><body>
  <div class="card">
    <div class="brand"><div class="logo">R</div><div class="name">Ragna<b>Recap</b></div></div>
    <div class="tag">Análise de replays <b>.rrf</b> do Ragnarok Online — DPS, abates, equipamentos e timeline, direto no navegador.</div>
    <div class="foot">recap.latam-tools.com.br</div>
  </div>
</body></html>`;

async function main() {
  // Sanity: the build must have run first.
  if (!(await stat(join(DIST, "index.html")).catch(() => null))) {
    console.warn(`[prerender] ${join(DIST, "index.html")} missing — did the build run? Skipping.`);
    return;
  }

  let puppeteer;
  try {
    ({ default: puppeteer } = await import("puppeteer"));
  } catch {
    console.warn("[prerender] puppeteer not installed — skipping prerender + og image.");
    return;
  }

  // The route snapshots need the static server; the og image doesn't.
  const server = OG_ONLY ? null : await startServer();
  const base = server ? `http://127.0.0.1:${server.address().port}` : "";
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    // --- og:image -------------------------------------------------------
    const ogPage = await browser.newPage();
    await ogPage.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
    await ogPage.setContent(OG_HTML, { waitUntil: "networkidle0" });
    await ogPage.screenshot({ path: join(DIST, "og.png"), type: "png" });
    await ogPage.close();
    console.log("[prerender] wrote og.png");

    // --- route snapshots ------------------------------------------------
    for (const [route, out] of OG_ONLY ? [] : Object.entries(ROUTES)) {
      const page = await browser.newPage();
      try {
        await page.goto(base + route, { waitUntil: "networkidle2", timeout: 20000 });
        // Let the client render + useSeo apply the per-route <head>.
        await page.waitForFunction(
          () => document.getElementById("root")?.childElementCount > 0 && !!document.title,
          { timeout: 10000 },
        );
        await new Promise((r) => setTimeout(r, 400));
        const html = "<!doctype html>\n" + (await page.content()).replace(/^<!doctype html>/i, "");
        const dest = join(DIST, out);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, html, "utf8");
        console.log(`[prerender] ${route} -> ${out}`);
      } catch (err) {
        console.warn(`[prerender] ${route} failed: ${err.message} (leaving SPA shell)`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    server?.close();
  }
}

main().catch((err) => {
  console.warn(`[prerender] skipped due to error: ${err?.message ?? err}`);
  // Non-fatal: never break the build/deploy over prerendering.
  process.exit(0);
});
