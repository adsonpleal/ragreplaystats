// Divine Pride scraper — fetches item/skill/monster/status names from the
// public web pages on divine-pride.net. We used to hit the JSON API but the
// shared API key got 403'd; the HTML pages don't need a key, ship permissive
// CORS (Access-Control-Allow-Origin: *), and carry the localized name in a
// stable <meta property="og:title"> tag. Names are cached to localStorage so
// repeat visits are instant.

import type { Replay } from "./rrf/types.js";

const SERVER = "latamRO";
const LANG = "pt-BR";
const BASE = "https://www.divine-pride.net/database";
const CONCURRENCY = 6;
// Bump this whenever the cache shape OR the gate logic changes; existing
// localStorage entries under the old key are simply ignored.
//   v1 → v2: retry null-name entries once per session (Divine Pride
//            adds new IDs over time, e.g. Dummy - Anjo / Morto-Vivo
//            arrived after the v1 cache snapshotted nulls).
//   v2 → v3: switched from JSON API to HTML scraping; old cache may
//            contain sprite-fallback names like "o44B" that the new
//            path resolves to canonical "Dummy - Pequeno" instead.
const CACHE_VERSION = 3;
const STORAGE_KEY = `dp:v${CACHE_VERSION}:${SERVER}`;

// `kind` is capitalised at the call site (Item / Monster / Skill / Buff)
// for legacy reasons — map to the lowercase URL segment. Buffs live under
// /database/efst on DP.
const KIND_PATH: Record<string, string> = {
  Item: "item",
  Monster: "monster",
  Skill: "skill",
  Buff: "efst",
};

type ItemEntry = { name: string | null };
type MonsterEntry = { name: string | null; hp: number };
type SkillEntry = { name: string | null };
type BuffEntry = { name: string | null };

type CacheShape = {
  items: Record<number, ItemEntry>;
  monsters: Record<number, MonsterEntry>;
  skills: Record<number, SkillEntry>;
  buffs: Record<number, BuffEntry>;
};

const cache: CacheShape = loadCache();
const pending = {
  items: new Map<number, Promise<void>>(),
  monsters: new Map<number, Promise<void>>(),
  skills: new Map<number, Promise<void>>(),
  buffs: new Map<number, Promise<void>>(),
};
// Tracks which previously-null entries we've already tried to refresh in
// this session. Prevents an unbounded refetch loop while still letting
// genuinely-new IDs (e.g. dummies that DP added recently) self-heal.
const retriedThisSession = {
  items: new Set<number>(),
  monsters: new Set<number>(),
  skills: new Set<number>(),
  buffs: new Set<number>(),
};

function loadCache(): CacheShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyCache();
    const parsed = JSON.parse(raw) as Partial<CacheShape>;
    return {
      items: parsed.items ?? {},
      monsters: parsed.monsters ?? {},
      skills: parsed.skills ?? {},
      buffs: parsed.buffs ?? {},
    };
  } catch {
    return emptyCache();
  }
}

function emptyCache(): CacheShape {
  return { items: {}, monsters: {}, skills: {}, buffs: {} };
}

let saveTimer: number | null = null;
function persist() {
  if (saveTimer != null) return;
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
    } catch {
      // localStorage full — clear and retry once.
      try {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
      } catch {
        // Give up; cache is in memory only.
      }
    }
  }, 500);
}

/**
 * Fetch the DP page for `<kind, id>` and return a JSON-shaped object that
 * matches what the legacy JSON API used to return. Each call site only
 * looks at `name`, `sprite`, and (for monsters) `stats.health` so we
 * project just those fields.
 */
async function fetchJson(kind: string, id: number): Promise<unknown> {
  const path = KIND_PATH[kind];
  if (!path) throw new Error(`unknown kind: ${kind}`);
  const url = `${BASE}/${path}/${id}?server=${SERVER}`;
  const res = await fetch(url, { headers: { "Accept-Language": LANG } });
  if (!res.ok) throw new Error(`${kind} ${id}: HTTP ${res.status}`);
  const html = await res.text();
  return parseDpPage(kind, html);
}

/**
 * Pull the localized name (from `<meta property="og:title">`) and — for
 * monsters — the first HP value off a DP database page. The og:title is
 * formatted "<localized prefix>: <name>" e.g. "Monstro: Dummy - Anjo";
 * we strip the prefix. HP for monsters is in the secondary-stats table
 * as `<span style="font-weight: bold;">N</span> HP`.
 */
function parseDpPage(
  kind: string,
  html: string,
): { name?: string; stats?: { health?: number } } {
  const og = html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i);
  if (!og) return {};
  const decoded = decodeHtmlEntities(og[1]);
  // Drop the localized "Monstro: " / "Item: " / "Habilidade: " / "Buff: "
  // prefix. We look for the first ": " to be tolerant of locales we
  // haven't seen.
  const sep = decoded.indexOf(": ");
  const name = (sep >= 0 ? decoded.slice(sep + 2) : decoded).trim();
  if (kind !== "Monster") return { name };
  const hp = html.match(
    /<span\s+style="font-weight:\s*bold;\s*">\s*(\d+)\s*<\/span>\s*HP\b/i,
  );
  return { name, stats: { health: hp ? Number(hp[1]) : 0 } };
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

async function fetchItem(id: number): Promise<void> {
  const cached = cache.items[id];
  if (cached) {
    if (cached.name != null) return;
    if (retriedThisSession.items.has(id)) return;
    retriedThisSession.items.add(id);
  }
  const existing = pending.items.get(id);
  if (existing) return existing;
  const p = (async () => {
    try {
      const data = (await fetchJson("Item", id)) as { name?: string };
      cache.items[id] = { name: data.name?.trim() || null };
      persist();
    } catch {
      cache.items[id] = { name: null };
    } finally {
      pending.items.delete(id);
    }
  })();
  pending.items.set(id, p);
  return p;
}

async function fetchMonster(id: number): Promise<void> {
  const cached = cache.monsters[id];
  if (cached) {
    if (cached.name != null) return;
    if (retriedThisSession.monsters.has(id)) return;
    retriedThisSession.monsters.add(id);
  }
  const existing = pending.monsters.get(id);
  if (existing) return existing;
  const p = (async () => {
    try {
      const data = (await fetchJson("Monster", id)) as {
        name?: string;
        stats?: { health?: number };
      };
      cache.monsters[id] = {
        name: data.name?.trim() || null,
        hp: data.stats?.health ?? 0,
      };
      persist();
    } catch {
      cache.monsters[id] = { name: null, hp: 0 };
    } finally {
      pending.monsters.delete(id);
    }
  })();
  pending.monsters.set(id, p);
  return p;
}

async function fetchSkill(id: number): Promise<void> {
  const cached = cache.skills[id];
  if (cached) {
    if (cached.name != null) return;
    if (retriedThisSession.skills.has(id)) return;
    retriedThisSession.skills.add(id);
  }
  const existing = pending.skills.get(id);
  if (existing) return existing;
  const p = (async () => {
    try {
      const data = (await fetchJson("Skill", id)) as { name?: string };
      cache.skills[id] = { name: data.name?.trim() || null };
      persist();
    } catch {
      cache.skills[id] = { name: null };
    } finally {
      pending.skills.delete(id);
    }
  })();
  pending.skills.set(id, p);
  return p;
}

async function fetchBuff(id: number): Promise<void> {
  const cached = cache.buffs[id];
  if (cached) {
    if (cached.name != null) return;
    if (retriedThisSession.buffs.has(id)) return;
    retriedThisSession.buffs.add(id);
  }
  const existing = pending.buffs.get(id);
  if (existing) return existing;
  const p = (async () => {
    try {
      const data = (await fetchJson("Buff", id)) as { name?: string };
      cache.buffs[id] = { name: data.name?.trim() || null };
      persist();
    } catch {
      cache.buffs[id] = { name: null };
    } finally {
      pending.buffs.delete(id);
    }
  })();
  pending.buffs.set(id, p);
  return p;
}

async function pool<T>(items: T[], fn: (it: T) => Promise<unknown>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const next = queue.shift()!;
      try {
        await fn(next);
      } catch {
        // Per-id failures are swallowed inside each fetcher.
      }
    }
  });
  await Promise.all(workers);
}

/**
 * Walks the replay to collect every unique id we'd display, then fetches them
 * in parallel. Resolves once all responses have either populated the cache or
 * been recorded as nulls. Cached ids are skipped so repeat replays are fast.
 */
export async function prefetchReplay(replay: Replay): Promise<void> {
  const items = new Set<number>();
  for (const e of replay.itemDeletes) if (e.itemId) items.add(e.itemId);
  for (const e of replay.itemAdds) if (e.itemId) items.add(e.itemId);
  for (const inv of replay.initialInventory.values()) {
    if (inv.itemId) items.add(inv.itemId);
    for (const cardId of inv.cards) if (cardId) items.add(cardId);
  }

  const monsters = new Set<number>();
  for (const ent of replay.entities.values()) {
    // Latam training dummies arrive as kind="npc" (objType 0x6) but their
    // `view` is a real monster id in the DP database (21064–21066, 21075,
    // 21076). Without this, "Por monstro" falls back to "mob#21075".
    if (
      (ent.kind === "mob" || ent.kind === "pc" || ent.kind === "npc") &&
      ent.view
    ) {
      monsters.add(ent.view);
    }
  }

  const skills = new Set<number>();
  for (const d of replay.damage) if (d.skillId) skills.add(d.skillId);
  for (const u of replay.skillUses) if (u.skillId) skills.add(u.skillId);
  for (const c of replay.skillCasts) if (c.skillId) skills.add(c.skillId);

  const buffs = new Set<number>();
  for (const s of replay.statusEvents) if (s.statusId) buffs.add(s.statusId);

  await Promise.all([
    pool([...items], fetchItem),
    pool([...monsters], fetchMonster),
    pool([...skills], fetchSkill),
    pool([...buffs], fetchBuff),
  ]);

  await fillDummyGaps();
}

/**
 * Some training dummies' spawn packets are missed when the player starts the
 * recording already in their view, leaving us with `view=0` for those AIDs.
 * The chat-label heuristic (see `inferredDummyNames`) gives us a name like
 * "Dummy - Anjo" that exactly matches a DP monster name, so we recover the
 * id by reverse name lookup. For that to work, the missing id has to be in
 * the cache — fill any gaps in the observed range of "Dummy - " ids.
 */
async function fillDummyGaps(): Promise<void> {
  const dummyIds: number[] = [];
  for (const [id, entry] of Object.entries(cache.monsters)) {
    if (entry.name && /^Dummy[\s-]/i.test(entry.name)) {
      dummyIds.push(Number(id));
    }
  }
  if (dummyIds.length < 2) return;
  dummyIds.sort((a, b) => a - b);
  const min = dummyIds[0];
  const max = dummyIds[dummyIds.length - 1];
  // Cap the speculative span — refuse to fill if the cluster is loose.
  if (max - min > 50) return;
  const toFetch: number[] = [];
  for (let i = min; i <= max; i++) {
    if (!cache.monsters[i]) toFetch.push(i);
  }
  if (toFetch.length) await pool(toFetch, fetchMonster);
}

/**
 * Reverse name → DP monster id lookup. Used to recover the view id of a
 * dummy that the player chat-labeled but whose spawn packet was missed.
 * Case-sensitive, exact match — DP names are server-localized and the chat
 * label is the player typing the same string they read off the dummy.
 */
export function findMonsterIdByName(name: string): number | null {
  for (const [id, entry] of Object.entries(cache.monsters)) {
    if (entry.name === name) return Number(id);
  }
  return null;
}

export function getItemName(id: number): string | null {
  return cache.items[id]?.name ?? null;
}

export function getMonsterName(id: number): string | null {
  return cache.monsters[id]?.name ?? null;
}

export function getMonsterHp(id: number): number {
  return cache.monsters[id]?.hp ?? 0;
}

export function getSkillName(id: number): string | null {
  return cache.skills[id]?.name ?? null;
}

export function getBuffName(id: number): string | null {
  return cache.buffs[id]?.name ?? null;
}
