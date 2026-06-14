import type { ReferenceDb } from "../../db/loader";
import { t } from "../../i18n";

export const itemDpUrl = (id: number) => `https://www.divine-pride.net/database/item/${id}`;
export const mobDpUrl = (view: number) => `https://www.divine-pride.net/database/monster/${view}`;
export const skillDpUrl = (id: number) => `https://www.divine-pride.net/database/skill/${id}`;

/** Skill id → name (auto-attack for 0, `skill#id` fallback until DP loads). */
export const resolveSkillName = (db: ReferenceDb | null, id: number) =>
  id === 0 ? t.autoAttack : db?.resolveSkill(id) ?? t.skillFallback(id);

export const resolveMobName = (db: ReferenceDb | null, id: number) =>
  db?.resolveMob(id) ?? t.mobFallback(id);

export const resolveItemName = (db: ReferenceDb | null, id: number) =>
  db?.resolveItem(id) ?? t.itemFallback(id);

export const pct = (n: number, total: number) =>
  total <= 0 ? 0 : Math.round((n / total) * 100);
