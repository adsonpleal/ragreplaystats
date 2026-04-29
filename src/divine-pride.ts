// Divine Pride name resolver — backed by static JSON files we ship under
// public/db/ (generated offline by tools/scrape-dp.mjs). On first lookup
// we fetch each kind's file, parse it into an in-memory Map, then serve
// every subsequent lookup from memory. The browser's HTTP cache makes
// repeat visits free.
//
// DP keeps duplicate / unlisted monster entries (e.g. id 1438 = "Khalitzburg"
// that doesn't appear on /database/monster?Page=N alongside the canonical
// 1132). For those, we lazy-fetch the per-id HTML page once per session
// when a replay references the unlisted view id.

import type { Replay } from "./rrf/types.js";

type ItemEntry = { name: string };
type MonsterEntry = { name: string; hp: number; level: number };
type SkillEntry = { name: string };

// vite is configured with `base: "./"`, so relative URLs resolve against
// the current page (works the same on dev http://localhost:5173/ and on
// GitHub Pages https://…/ragreplaystats/). Files live in public/db/ and
// ship as-is to the deploy root.
const DB_BASE = "./db";

let items: Map<number, ItemEntry> | null = null;
let monsters: Map<number, MonsterEntry> | null = null;
let skills: Map<number, SkillEntry> | null = null;

let itemsP: Promise<void> | null = null;
let monstersP: Promise<void> | null = null;
let skillsP: Promise<void> | null = null;

async function loadKind<T>(
  fileName: string,
): Promise<Map<number, T>> {
  try {
    const res = await fetch(`${DB_BASE}/${fileName}`);
    if (!res.ok) return new Map();
    const data = (await res.json()) as Record<string, T>;
    const map = new Map<number, T>();
    for (const [id, entry] of Object.entries(data)) {
      map.set(Number(id), entry);
    }
    return map;
  } catch {
    return new Map();
  }
}

function loadItems(): Promise<void> {
  if (items) return Promise.resolve();
  if (!itemsP) itemsP = loadKind<ItemEntry>("dp-item.json").then((m) => { items = m; });
  return itemsP;
}
function loadMonsters(): Promise<void> {
  if (monsters) return Promise.resolve();
  if (!monstersP) monstersP = loadKind<MonsterEntry>("dp-monster.json").then((m) => { monsters = m; });
  return monstersP;
}
function loadSkills(): Promise<void> {
  if (skills) return Promise.resolve();
  if (!skillsP) skillsP = loadKind<SkillEntry>("dp-skill.json").then((m) => { skills = m; });
  return skillsP;
}

/**
 * Loads every kind's static JSON in parallel, then fills in any monster
 * view ids referenced by the replay that aren't in the bundled listing
 * via per-id DP fetches. Cheap on repeat — already-loaded kinds and
 * already-fetched ids short-circuit immediately.
 */
export async function prefetchReplay(replay: Replay): Promise<void> {
  await Promise.all([loadItems(), loadMonsters(), loadSkills()]);
  await fillMonsterMisses(replay);
}

const FALLBACK_CONCURRENCY = 4;
const monsterFallback = new Map<number, Promise<void>>();

async function fillMonsterMisses(replay: Replay): Promise<void> {
  if (!monsters) return;
  const missing = new Set<number>();
  for (const ent of replay.entities.values()) {
    if (ent.kind !== "mob" && ent.kind !== "npc") continue;
    if (!ent.view || ent.view <= 0) continue;
    if (monsters.has(ent.view)) continue;
    missing.add(ent.view);
  }
  if (missing.size === 0) return;
  const queue = [...missing];
  const workers = Array.from({ length: FALLBACK_CONCURRENCY }, async () => {
    while (queue.length) {
      const id = queue.shift()!;
      await fetchMonsterFallback(id);
    }
  });
  await Promise.all(workers);
}

async function fetchMonsterFallback(id: number): Promise<void> {
  if (!monsters || monsters.has(id)) return;
  let p = monsterFallback.get(id);
  if (p) return p;
  p = (async () => {
    try {
      const res = await fetch(`https://www.divine-pride.net/database/monster/${id}`, {
        headers: { "Accept-Language": "pt-BR,pt;q=0.9" },
      });
      if (!res.ok) return;
      const html = await res.text();
      const og = html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i);
      if (!og) return;
      const decoded = decodeHtmlEntities(og[1]);
      // Strip the localized "Monstro: " / "Monster: " prefix.
      const sep = decoded.indexOf(": ");
      const name = (sep >= 0 ? decoded.slice(sep + 2) : decoded).trim();
      if (!name) return;
      // First HP value on the page wins. Layout is
      //   <span style="font-weight: bold;"> 23.986 </span> HP
      // with pt-BR thousand separators (`.` → strip).
      const hpMatch = html.match(
        /<span\s+style="font-weight:\s*bold;\s*">\s*([\d.]+)\s*<\/span>\s*HP\b/i,
      );
      const hp = hpMatch ? parseLocaleInt(hpMatch[1]) : 0;
      monsters?.set(id, { name, hp, level: 0 });
    } catch {
      // Network or parse error → leave id unresolved; the UI keeps `mob#X`.
    }
  })();
  monsterFallback.set(id, p);
  return p;
}

function parseLocaleInt(s: string): number {
  return parseInt(s.replace(/\./g, ""), 10) || 0;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/**
 * Reverse name → DP monster id lookup. Used to recover the view id of a
 * dummy that the player chat-labeled but whose spawn packet was missed.
 * Sync — assumes prefetchReplay has already resolved (which is the case
 * at every call site).
 */
export function findMonsterIdByName(name: string): number | null {
  if (!monsters) return null;
  for (const [id, entry] of monsters) {
    if (entry.name === name) return id;
  }
  return null;
}

export function getItemName(id: number): string | null {
  return items?.get(id)?.name ?? null;
}

export function getMonsterName(id: number): string | null {
  return monsters?.get(id)?.name ?? null;
}

export function getMonsterHp(id: number): number {
  return monsters?.get(id)?.hp ?? 0;
}

export function getSkillName(id: number): string | null {
  return skills?.get(id)?.name ?? null;
}
