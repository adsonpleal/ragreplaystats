// Divine Pride API client — fetches item/skill/monster/status names on demand
// for the Latam server. Read-only, public-safe key (any rotation just requires
// regenerating it on divine-pride.net). Names are cached to localStorage so
// repeat visits are instant.

import type { Replay } from "./rrf/types.js";

const API_KEY = "c14759f86890170a6fe7fa11182170ca";
const SERVER = "latamRO";
const LANG = "pt-BR";
const BASE = "https://www.divine-pride.net/api/database";
const CONCURRENCY = 6;
// Bump this whenever the cache shape OR the gate logic changes; existing
// localStorage entries under the old key are simply ignored.
//   v1 → v2: retry null-name entries once per session (Divine Pride
//            adds new IDs over time, e.g. Dummy - Anjo / Morto-Vivo
//            arrived after the v1 cache snapshotted nulls).
const CACHE_VERSION = 2;
const STORAGE_KEY = `dp:v${CACHE_VERSION}:${SERVER}`;

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

async function fetchJson(kind: string, id: number): Promise<unknown> {
  const url = `${BASE}/${kind}/${id}?apiKey=${API_KEY}&server=${SERVER}`;
  const res = await fetch(url, { headers: { "Accept-Language": LANG } });
  if (!res.ok) throw new Error(`${kind} ${id}: HTTP ${res.status}`);
  return res.json();
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
        sprite?: string;
        stats?: { health?: number };
      };
      cache.monsters[id] = {
        name: (data.name?.trim() || data.sprite?.trim()) || null,
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
    if (ent.kind === "mob" && ent.view) monsters.add(ent.view);
    if (ent.kind === "pc" && ent.view) monsters.add(ent.view);
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
