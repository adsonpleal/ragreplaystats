#!/usr/bin/env node
// Post the newest CHANGELOG.md section to Discord after a deploy.
//
// Standard message = project name + version + the bullet points from the top
// (newest) dated section of CHANGELOG.md, as a single embed. The version is
// read from package.json (the deploy workflow only runs this when the version
// actually changed), and the changelog body is the source of truth for the
// "novidades" text — no separate data file to keep in sync.
//
// Usage:
//   DISCORD_BOT_TOKEN=xxx node tools/post-novidades.mjs   # posts
//   node tools/post-novidades.mjs --dry-run               # prints payload, no network
//
// Env:
//   DISCORD_BOT_TOKEN   (required to post) — a bot token; keep it in a GitHub
//                       Actions secret, never in the repo.
//   DISCORD_CHANNEL_ID  (optional) — defaults to the channel below.
//
// Exit codes: 0 = posted / dry-run / not-configured (no token). 1 = a token was
// given but the Discord API rejected the request (surface real misconfig).

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PROJECT_NAME = "RagnaRecap";
const SITE_URL = "https://recap.latam-tools.com.br/";
const DEFAULT_CHANNEL_ID = "1524025278471471295";
const EMBED_COLOR = 0xff6f8d; // pink, matches the app accent
const DISCORD_DESC_LIMIT = 4096;

const dryRun = process.argv.includes("--dry-run");

function readVersion() {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  return pkg.version;
}

// Parse the top-most "## <heading>" section of CHANGELOG.md into { date, logs }.
// The heading text is the date (e.g. "2026-07-07"); logs are the top-level
// "- " bullet lines of that section (markdown kept as-is — Discord renders it).
function readLatestChangelog() {
  const src = readFileSync(resolve(ROOT, "CHANGELOG.md"), "utf8");
  const lines = src.split(/\r?\n/);
  let date = "";
  const logs = [];
  let inSection = false;
  for (const line of lines) {
    const heading = line.match(/^##\s+(.*\S)\s*$/);
    if (heading) {
      if (inSection) break; // reached the next (older) section — stop
      date = heading[1];
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    const bullet = line.match(/^-\s+(.*)$/);
    if (bullet) logs.push(bullet[1].trim());
  }
  return { date, logs };
}

function buildEmbed({ version, date, logs }) {
  let description = logs.map((l) => `• ${l}`).join("\n\n");
  if (description.length > DISCORD_DESC_LIMIT) {
    description = description.slice(0, DISCORD_DESC_LIMIT - 1) + "…";
  }
  const host = SITE_URL.replace("https://", "");
  return {
    title: `${PROJECT_NAME} — v${version}`,
    url: SITE_URL,
    description,
    color: EMBED_COLOR,
    footer: { text: date ? `Publicado em ${date} • ${host}` : host },
    timestamp: new Date().toISOString(),
  };
}

async function main() {
  const version = readVersion();
  const entry = readLatestChangelog();
  if (!entry || entry.logs.length === 0) {
    console.warn("No bullet points in the latest CHANGELOG.md section — nothing to post.");
    return;
  }

  const embed = buildEmbed({ version, ...entry });
  const payload = { embeds: [embed] };

  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.warn("DISCORD_BOT_TOKEN not set — skipping Discord post (not configured).");
    return;
  }
  const channelId = process.env.DISCORD_CHANNEL_ID || DEFAULT_CHANNEL_ID;

  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    console.error(`Discord API ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  console.log(`Posted novidades for v${version} to channel ${channelId}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
