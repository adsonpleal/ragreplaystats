// Divine Pride name resolver — backed by static JSON files we ship under
// public/db/ (generated offline by tools/scrape-dp.mjs). On first lookup
// we fetch each kind's file, parse it into an in-memory Map, then serve
// every subsequent lookup from memory. The browser's HTTP cache makes
// repeat visits free.
//
// No runtime DP queries: the offline scraper is responsible for filling
// in any unlisted view ids (via its Firestore harvest pass), so the
// browser never talks to divine-pride.net.

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
 * Loads every kind's static JSON in parallel. Resolves once all three are
 * in memory (or have failed and been recorded as empty maps). Cheap on
 * repeat — already-loaded kinds short-circuit immediately.
 */
export async function prefetchReplay(_replay: Replay): Promise<void> {
  await Promise.all([loadItems(), loadMonsters(), loadSkills()]);
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
