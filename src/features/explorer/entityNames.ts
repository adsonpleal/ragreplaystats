import type { MonsterAgg } from "../../aggregate/index";
import type { ReferenceDb } from "../../db/loader";
import { t } from "../../i18n";
import type { Replay } from "../../rrf/types";

/** Best monster name: DP species name → server-reported instance name → fallback. */
export function monsterName(replay: Replay, db: ReferenceDb | null, aid: number): string {
  const ent = replay.entities.get(aid);
  if (ent && db && ent.view) {
    const fromDb = db.resolveMob(ent.view);
    if (!fromDb.startsWith("mob#")) return fromDb;
  }
  if (!ent) return t.unknownTargetName;
  if (ent.name) return ent.name;
  return t.mobFallback(ent.view || aid);
}

export function playerName(replay: Replay, aid: number): string {
  const ent = replay.entities.get(aid);
  return ent?.name || `#${aid}`;
}

/**
 * Strip RO name decoration to the visible display name:
 *   - `\x1C…\x1C` segments — internal instance/hidden codes ("\x1CYTDpCA\x1C")
 *   - other control chars, and `^RRGGBB` caret colour codes
 *   - the `name#unique` suffix the client hides (so "Kafra#alde01" → "Kafra";
 *     a name that starts with `#` collapses to empty = a hidden NPC)
 */
function cleanNpcName(raw: string): string {
  let s = raw.replace(/\x1c[^\x1c]*\x1c/g, "").replace(/[\x00-\x1f]/g, "");
  const hash = s.indexOf("#");
  if (hash >= 0) s = s.slice(0, hash);
  return s.replace(/\^[0-9a-fA-F]{6}/g, "").trim();
}

/**
 * Best NPC name for the map viewer's hover. NPCs are NOT monsters, so their
 * `view` must not go through `resolveMob` (id spaces overlap → wrong names).
 * Prefer the cleaned display name; for a hidden/effect NPC with no display name
 * (`#eff_…`, `\x1C…\x1C`) fall back to the DB sprite name only when the view is a
 * real species (a boss-mirage NPC → "Miragem de Amdarais"); otherwise "" so the
 * caller shows no tooltip.
 */
export function npcName(replay: Replay, db: ReferenceDb | null, aid: number): string {
  const ent = replay.entities.get(aid);
  if (!ent) return "";
  const cleaned = cleanNpcName(ent.name || "");
  if (cleaned) return cleaned;
  if (db && ent.view) {
    const fromDb = db.resolveMob(ent.view);
    if (!fromDb.startsWith("mob#")) return fromDb;
  }
  return "";
}

export function playerClass(replay: Replay, db: ReferenceDb | null, aid: number): string {
  const ent = replay.entities.get(aid);
  if (!ent || !ent.view) return t.none;
  if (db) {
    const fromDb = db.resolveJob(ent.view);
    if (!fromDb.startsWith("job#")) return fromDb;
  }
  return t.none;
}

export function playerLevel(replay: Replay, aid: number): number {
  return replay.entities.get(aid)?.level ?? 0;
}

export function effectiveMaxHp(db: ReferenceDb | null, rawMaxHp: number, view: number): number {
  if (rawMaxHp > 0) return rawMaxHp;
  return db?.resolveMobHp(view) ?? 0;
}

/** Monster name + boss star, for the by-player/by-monster tables. */
export function formatMonsterRow(replay: Replay, db: ReferenceDb | null, row: MonsterAgg): string {
  const display = monsterName(replay, db, row.aid);
  return row.isBoss ? `${display}  ${t.bossMark}` : display;
}

/**
 * Whether the recording carries any crit information. Some servers never tag
 * damage as DMG_CRITICAL / DMG_MULTI_HIT_CRITICAL, so a "Críticos" column full
 * of zeros would mislead — callers hide the column entirely instead. Cached per
 * replay (the damage list is immutable once decoded).
 */
const critDataCache = new WeakMap<Replay, boolean>();
export function hasCritData(replay: Replay): boolean {
  const cached = critDataCache.get(replay);
  if (cached !== undefined) return cached;
  let result = false;
  for (const d of replay.damage) {
    if (d.rawAction === 10 || d.rawAction === 13) {
      result = true;
      break;
    }
  }
  critDataCache.set(replay, result);
  return result;
}
