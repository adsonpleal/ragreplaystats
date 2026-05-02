import type {
  DamageEvent,
  Replay,
  VanishEvent,
} from "../rrf/types.js";

// rAthena SP_* enum values we read from paramChanges.
export const SP_HP = 5;
export const SP_MAXHP = 6;
export const SP_SP = 7;
export const SP_MAXSP = 8;
export const SP_BASELEVEL = 11;
export const SP_JOBLEVEL = 12;
export const SP_ZENY = 20;

export type Range = { startMs: number; endMs: number } | null;

function inRange(t: number, range: Range): boolean {
  if (!range) return true;
  return t >= range.startMs && t <= range.endMs;
}

function effectiveDuration(replay: Replay, range: Range): number {
  if (!range) return Math.max(1, replay.sessionInfo.durationMs);
  return Math.max(1, range.endMs - range.startMs);
}

const PLAYER_KINDS = new Set(["pc", "homun", "merc"]);

export function isPlayerSource(replay: Replay, aid: number): boolean {
  const ent = replay.entities.get(aid);
  return !!ent && PLAYER_KINDS.has(ent.kind);
}

/**
 * "Targetable" = anything a player can deal damage to and have it count as
 * a monster row. We include:
 *   - kind="mob" (regular monsters, MVPs, mini-bosses)
 *   - kind="npc" (training dummies and NPCs the server marks damageable)
 *   - missing entities (target AID that was never spawned in this recording
 *     — common on practice maps like tra_fild where dummies are placed on
 *     map and the spawn packet was missed).
 * We exclude pc / homun / merc / elem / pet — those are allies, not targets.
 * We also exclude ground-skill-unit AIDs — those are AoE skill placeholders
 * (Storm Gust, Arrow Shower, etc.) that show up as damage targets but
 * aren't real monsters.
 */
const NON_TARGETABLE_KINDS = new Set(["pc", "homun", "merc", "elem", "pet"]);
function isMobTarget(replay: Replay, aid: number): boolean {
  if (replay.groundUnits.has(aid)) return false;
  const ent = replay.entities.get(aid);
  if (!ent) return true;
  return !NON_TARGETABLE_KINDS.has(ent.kind);
}

export type PlayerAgg = {
  aid: number;
  name: string;
  totalDealt: number;
  hits: number;
  crits: number;
  misses: number;
  monstersHit: number;
  kills: number;
};

export type MonsterAgg = {
  aid: number;
  view: number;
  name: string;
  isBoss: boolean;
  maxHp: number;
  totalReceived: number;
  hits: number;
  attackers: number;
  ttkMs: number | null;
};

export type SkillAgg = {
  skillId: number;
  name: string;
  count: number;
  totalDamage: number;
  avgDamage: number;
  multiHitAvg: number;
  avgCastMs: number | null;
};

export type DamageSeries = {
  /** ms-aligned bucket centers shared by all series. */
  ts: number[];
  /** One series per source AID. Values are total damage in each bucket. */
  series: Array<{ aid: number; name: string; damage: number[] }>;
};

/** Cross-replay: list of all PCs/homuns/mercs that dealt damage. */
export function playersWhoDamaged(replay: Replay): PlayerAgg[] {
  const map = new Map<number, PlayerAgg>();
  const monsters = new Map<number, Set<number>>();
  const killAttribution = new Map<number, number>();
  for (const k of replay.kills) {
    const lastHit = lastDamageTo(replay, k.aid, k.time);
    if (lastHit) killAttribution.set(lastHit.source, (killAttribution.get(lastHit.source) ?? 0) + 1);
  }

  for (const ev of replay.damage) {
    if (!isPlayerSource(replay, ev.source)) continue;
    let agg = map.get(ev.source);
    if (!agg) {
      const ent = replay.entities.get(ev.source);
      agg = {
        aid: ev.source,
        name: ent?.name || `#${ev.source}`,
        totalDealt: 0,
        hits: 0,
        crits: 0,
        misses: 0,
        monstersHit: 0,
        kills: 0,
      };
      map.set(ev.source, agg);
      monsters.set(ev.source, new Set());
    }
    agg.totalDealt += ev.damage;
    agg.hits += 1;
    if (ev.hitType === "critical") agg.crits += 1;
    if (ev.hitType === "miss") agg.misses += 1;
    if (isMobTarget(replay, ev.target)) monsters.get(ev.source)!.add(ev.target);
  }

  for (const [aid, agg] of map) {
    agg.monstersHit = monsters.get(aid)?.size ?? 0;
    agg.kills = killAttribution.get(aid) ?? 0;
  }

  return [...map.values()].sort((a, b) => b.totalDealt - a.totalDealt);
}

/**
 * Monsters damaged by a specific player, with per-monster totals.
 * Includes time-to-kill if the monster died and the player landed the last hit
 * before death.
 */
export function monstersDamagedByPlayer(
  replay: Replay,
  playerAid: number,
): MonsterAgg[] {
  const map = new Map<number, MonsterAgg>();
  const firstHitAt = new Map<number, number>();
  const lastHitAt = new Map<number, number>();

  for (const ev of replay.damage) {
    if (ev.source !== playerAid) continue;
    if (!isMobTarget(replay, ev.target)) continue;
    const ent = replay.entities.get(ev.target);
    let agg = map.get(ev.target);
    if (!agg) {
      agg = {
        aid: ev.target,
        view: ent?.view ?? 0,
        name: ent?.name || `mob#${ent?.view || ev.target}`,
        isBoss: ent?.isBoss ?? false,
        maxHp: ent?.maxHp ?? 0,
        totalReceived: 0,
        hits: 0,
        attackers: 1,
        ttkMs: null,
      };
      map.set(ev.target, agg);
    }
    agg.totalReceived += ev.damage;
    agg.hits += 1;
    if (!firstHitAt.has(ev.target)) firstHitAt.set(ev.target, ev.time);
    lastHitAt.set(ev.target, ev.time);
  }

  for (const kill of replay.kills) {
    const agg = map.get(kill.aid);
    const start = firstHitAt.get(kill.aid);
    if (!agg || start === undefined) continue;
    const lastHit = lastDamageTo(replay, kill.aid, kill.time);
    if (lastHit?.source === playerAid) {
      agg.ttkMs = Math.max(0, kill.time - start);
    }
  }

  return [...map.values()].sort((a, b) => b.totalReceived - a.totalReceived);
}

/** Monsters that took any damage. Independent of source. */
export function monstersWhoTookDamage(replay: Replay): MonsterAgg[] {
  const map = new Map<number, MonsterAgg>();
  const firstHitAt = new Map<number, number>();
  const attackerSets = new Map<number, Set<number>>();

  for (const ev of replay.damage) {
    if (!isMobTarget(replay, ev.target)) continue;
    const ent = replay.entities.get(ev.target);
    let agg = map.get(ev.target);
    if (!agg) {
      agg = {
        aid: ev.target,
        view: ent?.view ?? 0,
        name: ent?.name || `mob#${ent?.view || ev.target}`,
        isBoss: ent?.isBoss ?? false,
        maxHp: ent?.maxHp ?? 0,
        totalReceived: 0,
        hits: 0,
        attackers: 0,
        ttkMs: null,
      };
      map.set(ev.target, agg);
      attackerSets.set(ev.target, new Set());
    }
    agg.totalReceived += ev.damage;
    agg.hits += 1;
    if (isPlayerSource(replay, ev.source))
      attackerSets.get(ev.target)!.add(ev.source);
    if (!firstHitAt.has(ev.target)) firstHitAt.set(ev.target, ev.time);
  }

  for (const kill of replay.kills) {
    const agg = map.get(kill.aid);
    const start = firstHitAt.get(kill.aid);
    if (agg && start !== undefined) {
      agg.ttkMs = Math.max(0, kill.time - start);
    }
  }

  for (const [aid, agg] of map) {
    agg.attackers = attackerSets.get(aid)?.size ?? 0;
  }

  return [...map.values()].sort((a, b) => b.totalReceived - a.totalReceived);
}

/** Players that damaged a specific monster (for the by-monster drill-down). */
export function playersThatDamaged(
  replay: Replay,
  monsterAid: number,
): PlayerAgg[] {
  const map = new Map<number, PlayerAgg>();

  for (const ev of replay.damage) {
    if (ev.target !== monsterAid) continue;
    if (!isPlayerSource(replay, ev.source)) continue;
    let agg = map.get(ev.source);
    if (!agg) {
      const ent = replay.entities.get(ev.source);
      agg = {
        aid: ev.source,
        name: ent?.name || `#${ev.source}`,
        totalDealt: 0,
        hits: 0,
        crits: 0,
        misses: 0,
        monstersHit: 1,
        kills: 0,
      };
      map.set(ev.source, agg);
    }
    agg.totalDealt += ev.damage;
    agg.hits += 1;
    if (ev.hitType === "critical") agg.crits += 1;
    if (ev.hitType === "miss") agg.misses += 1;
  }

  // Award the kill to the player whose damage was closest to the kill event.
  const kill = replay.kills.find((k) => k.aid === monsterAid);
  if (kill) {
    const lastHit = lastDamageTo(replay, monsterAid, kill.time);
    if (lastHit && map.has(lastHit.source)) {
      map.get(lastHit.source)!.kills += 1;
    }
  }

  return [...map.values()].sort((a, b) => b.totalDealt - a.totalDealt);
}

/** Find the most recent damage event aimed at `targetAid` no later than `byTime`. */
function lastDamageTo(
  replay: Replay,
  targetAid: number,
  byTime: number,
): DamageEvent | null {
  let best: DamageEvent | null = null;
  for (const ev of replay.damage) {
    if (ev.target !== targetAid) continue;
    if (ev.time > byTime) continue;
    if (!best || ev.time > best.time) best = ev;
  }
  return best;
}

/** Players damaged by a specific monster (inverse of playersThatDamaged). */
export function playersDamagedByMonster(
  replay: Replay,
  monsterAid: number,
): PlayerAgg[] {
  const map = new Map<number, PlayerAgg>();

  for (const ev of replay.damage) {
    if (ev.source !== monsterAid) continue;
    if (!isPlayerSource(replay, ev.target)) continue;
    let agg = map.get(ev.target);
    if (!agg) {
      const ent = replay.entities.get(ev.target);
      agg = {
        aid: ev.target,
        name: ent?.name || `#${ev.target}`,
        totalDealt: 0,
        hits: 0,
        crits: 0,
        misses: 0,
        monstersHit: 1,
        kills: 0,
      };
      map.set(ev.target, agg);
    }
    agg.totalDealt += ev.damage;
    agg.hits += 1;
    if (ev.hitType === "critical") agg.crits += 1;
    if (ev.hitType === "miss") agg.misses += 1;
  }

  // Award the mob a "kill" against any player whose last damage event came
  // from this mob before the player's vanish.
  for (const kill of replay.kills) {
    if (!isPlayerSource(replay, kill.aid)) continue;
    const lastHit = lastDamageTo(replay, kill.aid, kill.time);
    if (lastHit?.source === monsterAid && map.has(kill.aid)) {
      map.get(kill.aid)!.kills += 1;
    }
  }

  return [...map.values()].sort((a, b) => b.totalDealt - a.totalDealt);
}

export type MobSkillAgg = {
  skillId: number;
  name: string;
  /** Damage events landed by this skill. */
  hits: number;
  totalDamage: number;
  avgDamage: number;
  /** Successful uses with no damage (heals, buffs, debuff applications). */
  noDamageUses: number;
  /** Cast-start packets observed (lower bound on attempted casts). */
  casts: number;
  avgCastMs: number | null;
  /** Distinct AIDs the skill landed on (damage events) or was used on. */
  distinctTargets: number;
};

/**
 * Skill breakdown grouped by (skillId) for damage / casts / uses sourced by
 * a single mob. When `targetAid` is provided, only events whose target
 * matches it are counted (used by the per-player filter in the UI).
 */
export function mobSkillBreakdown(
  replay: Replay,
  monsterAid: number,
  resolveSkill: (id: number) => string,
  targetAid?: number,
): MobSkillAgg[] {
  type Acc = {
    skillId: number;
    hits: number;
    totalDamage: number;
    noDamageUses: number;
    castCount: number;
    castMsTotal: number;
    targets: Set<number>;
  };
  const map = new Map<number, Acc>();
  const ensure = (skillId: number): Acc => {
    let acc = map.get(skillId);
    if (!acc) {
      acc = {
        skillId,
        hits: 0,
        totalDamage: 0,
        noDamageUses: 0,
        castCount: 0,
        castMsTotal: 0,
        targets: new Set(),
      };
      map.set(skillId, acc);
    }
    return acc;
  };

  for (const ev of replay.damage) {
    if (ev.source !== monsterAid) continue;
    if (targetAid != null && ev.target !== targetAid) continue;
    const acc = ensure(ev.skillId);
    acc.hits += 1;
    acc.totalDamage += ev.damage;
    acc.targets.add(ev.target);
  }

  for (const u of replay.skillUses) {
    if (u.source !== monsterAid) continue;
    if (targetAid != null && u.target !== targetAid) continue;
    const acc = ensure(u.skillId);
    acc.noDamageUses += 1;
    acc.targets.add(u.target);
  }

  // Cast packets carry no target filter — only include them when no per-target
  // filter is active, otherwise they'd inflate per-player rows for skills that
  // the player wasn't actually hit by.
  if (targetAid == null) {
    for (const c of replay.skillCasts) {
      if (c.source !== monsterAid) continue;
      const acc = ensure(c.skillId);
      acc.castCount += 1;
      if (c.castMs > 0) acc.castMsTotal += c.castMs;
    }
  }

  const result: MobSkillAgg[] = [];
  for (const acc of map.values()) {
    result.push({
      skillId: acc.skillId,
      name: resolveSkill(acc.skillId),
      hits: acc.hits,
      totalDamage: acc.totalDamage,
      avgDamage: acc.hits ? Math.round(acc.totalDamage / acc.hits) : 0,
      noDamageUses: acc.noDamageUses,
      casts: acc.castCount,
      avgCastMs: acc.castCount ? Math.round(acc.castMsTotal / acc.castCount) : null,
      distinctTargets: acc.targets.size,
    });
  }

  return result.sort((a, b) => b.totalDamage - a.totalDamage || b.hits - a.hits);
}

export type MobHpSeries = {
  ts: number[];
  hp: number[];
  maxHp: number[];
};

/**
 * HP timeline for a single mob. Primary signal is the server's mobHp packets
 * (replay.mobHp); we anchor the start at the entity's firstSeenMs with its
 * declared maxHp, and add a final 0-HP point at vanish time when it died.
 *
 * `fallbackMaxHp` lets the caller supply a Divine Pride-resolved max HP for
 * bosses where the server reports `maxHp = -1` and never sends mobHp updates.
 * Without it, the curve degenerates to a single point at kill time.
 */
export function mobHpCurve(
  replay: Replay,
  monsterAid: number,
  fallbackMaxHp = 0,
): MobHpSeries {
  const ent = replay.entities.get(monsterAid);
  const samples = replay.mobHp
    .filter((m) => m.aid === monsterAid)
    .sort((a, b) => a.time - b.time);

  const ts: number[] = [];
  const hp: number[] = [];
  const maxHp: number[] = [];

  const initialMax =
    ent?.maxHp && ent.maxHp > 0 ? ent.maxHp : fallbackMaxHp;

  // Anchor at first sighting whenever we have a max HP from any source.
  if (ent && ent.firstSeenMs >= 0 && initialMax > 0) {
    ts.push(ent.firstSeenMs);
    hp.push(initialMax);
    maxHp.push(initialMax);
  }

  let runningMax = initialMax;
  for (const s of samples) {
    if (s.maxHp > 0) runningMax = s.maxHp;
    ts.push(s.time);
    hp.push(s.hp);
    maxHp.push(runningMax || fallbackMaxHp);
  }

  // Final point at kill time when the mob died.
  const kill = replay.kills.find(
    (k) => k.aid === monsterAid && k.kind === 1,
  ) as VanishEvent | undefined;
  if (kill) {
    ts.push(kill.time);
    hp.push(0);
    maxHp.push(runningMax || fallbackMaxHp);
  }

  return { ts, hp, maxHp };
}

export type DamagePoint = { t: number; damage: number };

/**
 * Single-line damage-over-time chart. Each point is the total damage that
 * landed inside that bucket — NOT divided by bucket length, so this is
 * raw damage, not DPS.
 */
export function damageTimelineSingle(
  damage: DamageEvent[],
  bucketMs: number,
): DamagePoint[] {
  if (!damage.length) return [];
  const start = damage[0].time;
  const end = damage[damage.length - 1].time;
  if (end <= start) {
    return [{ t: start, damage: damage.reduce((s, e) => s + e.damage, 0) }];
  }

  const bucketCount = Math.max(1, Math.ceil((end - start) / bucketMs));
  const buckets = new Float64Array(bucketCount);
  for (const ev of damage) {
    const idx = Math.min(bucketCount - 1, Math.floor((ev.time - start) / bucketMs));
    buckets[idx] += ev.damage;
  }
  const points: DamagePoint[] = [];
  for (let i = 0; i < bucketCount; i++) {
    points.push({
      t: start + i * bucketMs + bucketMs / 2,
      damage: buckets[i],
    });
  }
  return points;
}

/**
 * Multi-series damage-over-time: one line per source AID. All series share
 * the same time axis. Values are raw damage in each bucket, not DPS.
 */
export function damageTimelineMulti(
  replay: Replay,
  events: DamageEvent[],
  bucketMs: number,
): DamageSeries {
  if (!events.length) return { ts: [], series: [] };

  const start = events[0].time;
  const end = events[events.length - 1].time;
  const span = Math.max(bucketMs, end - start);
  const bucketCount = Math.max(1, Math.ceil(span / bucketMs));

  const ts: number[] = [];
  for (let i = 0; i < bucketCount; i++) ts.push(start + i * bucketMs + bucketMs / 2);

  const seriesMap = new Map<number, Float64Array>();
  for (const ev of events) {
    let buckets = seriesMap.get(ev.source);
    if (!buckets) {
      buckets = new Float64Array(bucketCount);
      seriesMap.set(ev.source, buckets);
    }
    const idx = Math.min(bucketCount - 1, Math.floor((ev.time - start) / bucketMs));
    buckets[idx] += ev.damage;
  }

  const totals = new Map<number, number>();
  for (const [aid, buckets] of seriesMap) {
    let sum = 0;
    for (let i = 0; i < buckets.length; i++) sum += buckets[i];
    totals.set(aid, sum);
  }

  const sortedAids = [...seriesMap.keys()].sort(
    (a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0),
  );

  const series = sortedAids.map((aid) => {
    const ent = replay.entities.get(aid);
    const buckets = seriesMap.get(aid)!;
    const damage: number[] = new Array(bucketCount);
    for (let i = 0; i < bucketCount; i++) damage[i] = buckets[i];
    return {
      aid,
      name: ent?.name || `#${aid}`,
      damage,
    };
  });

  return { ts, series };
}

export type SkillByPlayerAgg = SkillAgg & {
  playerAid: number;
  playerName: string;
};

/** Skill breakdown grouped by (skill, source player). */
export function bySkillAndPlayer(
  replay: Replay,
  events: DamageEvent[],
  resolveSkill: (id: number) => string,
): SkillByPlayerAgg[] {
  type Acc = {
    key: string;
    skillId: number;
    playerAid: number;
    count: number;
    totalDamage: number;
    multiHitTotal: number;
    castCount: number;
    castMsTotal: number;
  };
  const map = new Map<string, Acc>();
  const ensure = (skillId: number, playerAid: number): Acc => {
    const key = `${skillId}::${playerAid}`;
    let acc = map.get(key);
    if (!acc) {
      acc = {
        key,
        skillId,
        playerAid,
        count: 0,
        totalDamage: 0,
        multiHitTotal: 0,
        castCount: 0,
        castMsTotal: 0,
      };
      map.set(key, acc);
    }
    return acc;
  };

  for (const ev of events) {
    const acc = ensure(ev.skillId, ev.source);
    acc.count += 1;
    acc.totalDamage += ev.damage;
    acc.multiHitTotal += ev.hits;
  }

  for (const cast of replay.skillCasts) {
    if (cast.castMs <= 0) continue;
    const key = `${cast.skillId}::${cast.source}`;
    const acc = map.get(key);
    if (!acc) continue;
    acc.castCount += 1;
    acc.castMsTotal += cast.castMs;
  }

  const result: SkillByPlayerAgg[] = [];
  for (const acc of map.values()) {
    const ent = replay.entities.get(acc.playerAid);
    result.push({
      skillId: acc.skillId,
      name: resolveSkill(acc.skillId),
      playerAid: acc.playerAid,
      playerName: ent?.name || `#${acc.playerAid}`,
      count: acc.count,
      totalDamage: acc.totalDamage,
      avgDamage: acc.count ? Math.round(acc.totalDamage / acc.count) : 0,
      multiHitAvg: acc.count ? +(acc.multiHitTotal / acc.count).toFixed(2) : 0,
      avgCastMs: acc.castCount ? Math.round(acc.castMsTotal / acc.castCount) : null,
    });
  }

  return result.sort((a, b) => b.totalDamage - a.totalDamage);
}

export type KillsByGroupAgg = {
  key: string;
  /** Killing-blow player (0 if grouping ignores player). */
  playerAid: number;
  playerName: string;
  /** Mob species / view id (0 if grouping ignores species). */
  monsterView: number;
  monsterName: string;
  count: number;
};

/**
 * Group kill events by (player, monster species). A "kill" is attributed to
 * the player whose damage event is the latest one hitting the monster before
 * its vanish=died event. Mobs that died with no preceding player damage are
 * ignored.
 *
 * Filters:
 *   - filter.sourceAid: only kills landed by this player
 *   - filter.targetView: only kills of this mob species
 *   - filter.targetAid:  only kills of this specific mob instance (rarely useful)
 *
 * Grouping behaviour:
 *   - both filters absent → bars per (player, species)
 *   - sourceAid set       → bars per species
 *   - targetView set      → bars per player
 *   - both set            → single bar
 */
export function killsByPlayerAndMob(
  replay: Replay,
  filter: { sourceAid?: number; targetView?: number; targetAid?: number },
  resolveMob: (id: number) => string,
): KillsByGroupAgg[] {
  const map = new Map<string, KillsByGroupAgg>();
  const groupByPlayer = filter.sourceAid == null;
  const groupByMonster = filter.targetView == null && filter.targetAid == null;

  for (const k of replay.kills) {
    const ent = replay.entities.get(k.aid);
    if (!ent || ent.kind !== "mob") continue;
    if (filter.targetAid != null && k.aid !== filter.targetAid) continue;
    if (filter.targetView != null && ent.view !== filter.targetView) continue;

    // Killing blow = latest player damage event on this mob before vanish.
    let lastHit: DamageEvent | null = null;
    for (const d of replay.damage) {
      if (d.target !== k.aid) continue;
      if (d.time > k.time) continue;
      if (!isPlayerSource(replay, d.source)) continue;
      if (!lastHit || d.time > lastHit.time) lastHit = d;
    }
    if (!lastHit) continue;
    if (filter.sourceAid != null && lastHit.source !== filter.sourceAid) continue;

    const killerAid = groupByPlayer ? lastHit.source : 0;
    const monsterView = groupByMonster ? ent.view : 0;
    const key = `${killerAid}::${monsterView}`;

    let agg = map.get(key);
    if (!agg) {
      const killerEnt = replay.entities.get(lastHit.source);
      // Prefer the canonical species name from the DB. The per-instance
      // server label (e.g. "3I8B") is fallback only.
      const dbName = ent.view ? resolveMob(ent.view) : "";
      const mobName =
        dbName && !dbName.startsWith("mob#")
          ? dbName
          : ent.name || `mob#${ent.view || k.aid}`;
      agg = {
        key,
        playerAid: lastHit.source,
        playerName: killerEnt?.name || `#${lastHit.source}`,
        monsterView: ent.view,
        monsterName: mobName,
        count: 0,
      };
      map.set(key, agg);
    }
    agg.count += 1;
  }

  return [...map.values()].sort((a, b) => b.count - a.count);
}

export type SkillUsageAgg = {
  key: string;
  playerAid: number;
  playerName: string;
  skillId: number;
  skillName: string;
  count: number;
};

/**
 * Count skill uses by (player, skill). Auto-attacks are included as
 * skillId = 0; the caller's resolver should map that to a localized
 * "Ataque básico" label. Combines damage events (each skill cast that
 * landed) and non-damage skill uses (buffs / heals).
 *
 * `filter.sourceAid` restricts to a single player; `filter.targetAid`
 * restricts to a single monster (only damage events are filterable by
 * target — non-damage skill uses are kept regardless of target).
 */
export function skillUsageByPlayer(
  replay: Replay,
  filter: { sourceAid?: number; targetAid?: number },
  resolveSkill: (id: number) => string,
): SkillUsageAgg[] {
  const map = new Map<string, SkillUsageAgg>();
  const ensure = (sourceAid: number, skillId: number): SkillUsageAgg => {
    const key = `${sourceAid}::${skillId}`;
    let agg = map.get(key);
    if (!agg) {
      const ent = replay.entities.get(sourceAid);
      agg = {
        key,
        playerAid: sourceAid,
        playerName: ent?.name || `#${sourceAid}`,
        skillId,
        skillName: resolveSkill(skillId),
        count: 0,
      };
      map.set(key, agg);
    }
    return agg;
  };

  for (const ev of replay.damage) {
    if (filter.sourceAid != null && ev.source !== filter.sourceAid) continue;
    if (filter.targetAid != null && ev.target !== filter.targetAid) continue;
    if (!isPlayerSource(replay, ev.source)) continue;
    ensure(ev.source, ev.skillId).count += 1;
  }

  for (const u of replay.skillUses) {
    if (filter.sourceAid != null && u.source !== filter.sourceAid) continue;
    if (filter.targetAid != null && u.target !== filter.targetAid) continue;
    if (!isPlayerSource(replay, u.source)) continue;
    ensure(u.source, u.skillId).count += 1;
  }

  return [...map.values()].sort((a, b) => b.count - a.count);
}

/** Skill breakdown over an arbitrary set of damage events. */
export function bySkill(
  events: DamageEvent[],
  skillCasts: Replay["skillCasts"],
  resolveSkill: (id: number) => string,
): SkillAgg[] {
  type Acc = {
    skillId: number;
    count: number;
    totalDamage: number;
    multiHitTotal: number;
    castCount: number;
    castMsTotal: number;
  };
  const map = new Map<number, Acc>();
  const ensure = (id: number): Acc => {
    let acc = map.get(id);
    if (!acc) {
      acc = {
        skillId: id,
        count: 0,
        totalDamage: 0,
        multiHitTotal: 0,
        castCount: 0,
        castMsTotal: 0,
      };
      map.set(id, acc);
    }
    return acc;
  };

  for (const ev of events) {
    const acc = ensure(ev.skillId);
    acc.count += 1;
    acc.totalDamage += ev.damage;
    acc.multiHitTotal += ev.hits;
  }

  for (const cast of skillCasts) {
    if (cast.castMs > 0 && map.has(cast.skillId)) {
      const acc = ensure(cast.skillId);
      acc.castCount += 1;
      acc.castMsTotal += cast.castMs;
    }
  }

  const result: SkillAgg[] = [];
  for (const acc of map.values()) {
    result.push({
      skillId: acc.skillId,
      name: resolveSkill(acc.skillId),
      count: acc.count,
      totalDamage: acc.totalDamage,
      avgDamage: acc.count ? Math.round(acc.totalDamage / acc.count) : 0,
      multiHitAvg: acc.count ? +(acc.multiHitTotal / acc.count).toFixed(2) : 0,
      avgCastMs: acc.castCount ? Math.round(acc.castMsTotal / acc.castCount) : null,
    });
  }

  return result.sort((a, b) => b.totalDamage - a.totalDamage);
}

// ----------------------------------------------------------------------------
// Estatísticas tab — player-centric aggregators.
// ----------------------------------------------------------------------------

export type ResumoStats = {
  totalDealt: number;
  totalTaken: number;
  effectiveDps: number;
  hitsLanded: number;
  hitsMissed: number;
  crits: number;
  highestHit: { damage: number; skillId: number; targetAid: number; time: number } | null;
  mostUsedSkillId: number;
  mostUsedSkillCount: number;
  kills: number;
  bossKills: number;
  timeToFirstKillMs: number | null;
  avgKillIntervalMs: number;
  topKilledSpecies: { view: number; count: number } | null;
  baseLevelsGained: number;
  jobLevelsGained: number;
  zenyDelta: number;
  mapsVisited: number;
  durationMs: number;
  deaths: number;
};

export function computeResumo(replay: Replay, range: Range): ResumoStats {
  const playerAid = replay.sessionInfo.aid;
  const durationMs = effectiveDuration(replay, range);

  let totalDealt = 0;
  let totalTaken = 0;
  let firstHit = Number.POSITIVE_INFINITY;
  let lastHit = Number.NEGATIVE_INFINITY;
  let hitsLanded = 0;
  let hitsMissed = 0;
  let crits = 0;
  const skillCounts = new Map<number, number>();
  let highest: ResumoStats["highestHit"] = null;

  for (const ev of replay.damage) {
    if (!inRange(ev.time, range)) continue;
    if (ev.source === playerAid) {
      totalDealt += ev.damage;
      hitsLanded += 1;
      if (ev.hitType === "miss") hitsMissed += 1;
      if (ev.hitType === "critical") crits += 1;
      firstHit = Math.min(firstHit, ev.time);
      lastHit = Math.max(lastHit, ev.time);
      if (ev.skillId) {
        skillCounts.set(ev.skillId, (skillCounts.get(ev.skillId) ?? 0) + 1);
      }
      if (!highest || ev.damage > highest.damage) {
        highest = {
          damage: ev.damage,
          skillId: ev.skillId,
          targetAid: ev.target,
          time: ev.time,
        };
      }
    }
    if (ev.target === playerAid) totalTaken += ev.damage;
  }

  let mostUsedSkillId = 0;
  let mostUsedSkillCount = 0;
  for (const [id, count] of skillCounts) {
    if (count > mostUsedSkillCount) {
      mostUsedSkillId = id;
      mostUsedSkillCount = count;
    }
  }

  const fightSec =
    firstHit !== Number.POSITIVE_INFINITY && lastHit > firstHit
      ? (lastHit - firstHit) / 1000
      : 0;
  const effectiveDps = fightSec > 0 ? Math.round(totalDealt / fightSec) : 0;

  const playerKills = killsByPlayer(replay, playerAid, range);
  const speciesCounts = new Map<number, number>();
  let bossKills = 0;
  let firstKillTime: number | null = null;
  let lastKillTime: number | null = null;
  for (const k of playerKills) {
    const ent = replay.entities.get(k.aid);
    if (ent?.isBoss) bossKills += 1;
    if (ent?.view) {
      speciesCounts.set(ent.view, (speciesCounts.get(ent.view) ?? 0) + 1);
    }
    if (firstKillTime === null) firstKillTime = k.time;
    lastKillTime = k.time;
  }
  let topSpecies: { view: number; count: number } | null = null;
  for (const [view, count] of speciesCounts) {
    if (!topSpecies || count > topSpecies.count) topSpecies = { view, count };
  }
  const avgKillIntervalMs =
    playerKills.length > 1 && firstKillTime !== null && lastKillTime !== null
      ? Math.round((lastKillTime - firstKillTime) / (playerKills.length - 1))
      : 0;

  const baseLevelsGained = paramDelta(replay, SP_BASELEVEL, range);
  const jobLevelsGained = paramDelta(replay, SP_JOBLEVEL, range);
  const zenyDelta = paramDelta(replay, SP_ZENY, range);
  // Count DISTINCT map names. The 0x0091 packet fires on every map-server
  // transition (warps, instance resets, fly-wings to the same map), so a
  // raw event count overstates the number of unique maps visited.
  const distinctMaps = new Set<string>();
  if (replay.sessionInfo.map) distinctMaps.add(replay.sessionInfo.map);
  for (const m of replay.mapChanges) {
    if (!inRange(m.time, range)) continue;
    if (m.map) distinctMaps.add(m.map);
  }
  const mapsVisited = distinctMaps.size || 1;

  const deaths = replay.kills.filter(
    (k) => k.aid === playerAid && inRange(k.time, range),
  ).length;

  return {
    totalDealt,
    totalTaken,
    effectiveDps,
    hitsLanded,
    hitsMissed,
    crits,
    highestHit: highest,
    mostUsedSkillId,
    mostUsedSkillCount,
    kills: playerKills.length,
    bossKills,
    timeToFirstKillMs: firstKillTime,
    avgKillIntervalMs,
    topKilledSpecies: topSpecies,
    baseLevelsGained,
    jobLevelsGained,
    zenyDelta,
    mapsVisited,
    durationMs,
    deaths,
  };
}

function killsByPlayer(
  replay: Replay,
  playerAid: number,
  range: Range,
): VanishEvent[] {
  const out: VanishEvent[] = [];
  for (const k of replay.kills) {
    if (!inRange(k.time, range)) continue;
    const ent = replay.entities.get(k.aid);
    if (!ent || ent.kind !== "mob") continue;
    let lastHit: DamageEvent | null = null;
    for (const d of replay.damage) {
      if (d.target !== k.aid || d.time > k.time) continue;
      if (!isPlayerSource(replay, d.source)) continue;
      if (!lastHit || d.time > lastHit.time) lastHit = d;
    }
    if (lastHit?.source === playerAid) out.push(k);
  }
  return out;
}

function paramDelta(replay: Replay, type: number, range: Range): number {
  const events = replay.paramChanges.filter(
    (p) => p.type === type && inRange(p.time, range),
  );
  if (events.length < 2) return 0;
  return Number(events[events.length - 1].value - events[0].value);
}

export type ParamCurve = {
  ts: number[];
  values: number[];
};

export function paramCurve(replay: Replay, type: number, range: Range): ParamCurve {
  const events = replay.paramChanges
    .filter((p) => p.type === type && inRange(p.time, range))
    .sort((a, b) => a.time - b.time);
  return {
    ts: events.map((p) => p.time),
    values: events.map((p) => Number(p.value)),
  };
}

export type ItemUsageRow = {
  itemId: number;
  name: string;
  count: number;
  quantity: number;
  reasonBreakdown: Record<number, number>;
};

/**
 * Reasons that count as "the player consumed this item": potions / scrolls
 * (1), arrows or other skill-driven uses (2), consumed in production (4),
 * consumed in special action (5). Reason 0 is dropped/sold/traded; 3 is
 * refine-fail destruction; 6/7 are storage/cart moves. None of those mean
 * the item was used.
 */
const CONSUME_REASONS = new Set([1, 2, 4, 5]);

export function consumablesByItem(
  replay: Replay,
  range: Range,
  resolveItem: (id: number) => string,
): ItemUsageRow[] {
  // Group by (itemId, slot) so unidentified events get one row per slot.
  // That way the user sees "[Item desconhecido — slot 65]" instead of all
  // unresolved deletes collapsing into one anonymous row.
  const map = new Map<string, ItemUsageRow & { slot: number }>();
  for (const ev of replay.itemDeletes) {
    if (!inRange(ev.time, range)) continue;
    if (!CONSUME_REASONS.has(ev.reason)) continue;
    const id = ev.itemId;
    const key = id ? `id:${id}` : `slot:${ev.slot}`;
    let row = map.get(key);
    if (!row) {
      row = {
        itemId: id,
        slot: ev.slot,
        name: id
          ? resolveItem(id)
          : `[Item desconhecido — slot ${ev.slot}]`,
        count: 0,
        quantity: 0,
        reasonBreakdown: {},
      };
      map.set(key, row);
    }
    row.count += 1;
    row.quantity += ev.amount;
    row.reasonBreakdown[ev.reason] =
      (row.reasonBreakdown[ev.reason] ?? 0) + ev.amount;
  }
  return [...map.values()]
    .sort((a, b) => b.quantity - a.quantity)
    .map(({ slot: _slot, ...rest }) => rest);
}

export function lootByItem(
  replay: Replay,
  range: Range,
  resolveItem: (id: number) => string,
): ItemUsageRow[] {
  const map = new Map<number, ItemUsageRow>();
  for (const ev of replay.itemAdds) {
    if (!inRange(ev.time, range)) continue;
    const id = ev.itemId;
    let row = map.get(id);
    if (!row) {
      row = {
        itemId: id,
        name: id ? resolveItem(id) : "—",
        count: 0,
        quantity: 0,
        reasonBreakdown: {},
      };
      map.set(id, row);
    }
    row.count += 1;
    row.quantity += ev.amount;
  }
  return [...map.values()].sort((a, b) => b.quantity - a.quantity);
}

export type KillsBucketSeries = {
  ts: number[];
  series: Array<{ view: number; name: string; kills: number[] }>;
};

export function killsPerMinuteByView(
  replay: Replay,
  range: Range,
  bucketMs: number,
  resolveMob: (id: number) => string,
): KillsBucketSeries {
  const filtered = replay.kills.filter((k) => {
    if (!inRange(k.time, range)) return false;
    const ent = replay.entities.get(k.aid);
    return !!ent && ent.kind === "mob";
  });
  if (!filtered.length) return { ts: [], series: [] };

  const start = filtered[0].time;
  const end = filtered[filtered.length - 1].time;
  const span = Math.max(bucketMs, end - start);
  const bucketCount = Math.max(1, Math.ceil(span / bucketMs));

  const ts: number[] = [];
  for (let i = 0; i < bucketCount; i++) ts.push(start + i * bucketMs + bucketMs / 2);

  const buckets = new Map<number, Float64Array>();
  for (const k of filtered) {
    const ent = replay.entities.get(k.aid)!;
    let row = buckets.get(ent.view);
    if (!row) {
      row = new Float64Array(bucketCount);
      buckets.set(ent.view, row);
    }
    const idx = Math.min(bucketCount - 1, Math.floor((k.time - start) / bucketMs));
    row[idx] += 1;
  }

  const totals = new Map<number, number>();
  for (const [view, arr] of buckets) {
    let s = 0;
    for (let i = 0; i < arr.length; i++) s += arr[i];
    totals.set(view, s);
  }
  const sortedViews = [...buckets.keys()].sort(
    (a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0),
  );

  const series = sortedViews.map((view) => {
    const arr = buckets.get(view)!;
    return {
      view,
      name: resolveMob(view),
      kills: Array.from(arr),
    };
  });

  return { ts, series };
}

export type BrushSeries = {
  ts: number[];
  damage: number[];
  killTs: number[];
  killViews: number[];
  spanStart: number;
  spanEnd: number;
};

export function brushSeries(replay: Replay, bucketMs: number): BrushSeries {
  const empty: BrushSeries = {
    ts: [],
    damage: [],
    killTs: [],
    killViews: [],
    spanStart: 0,
    spanEnd: 0,
  };
  if (!replay.damage.length && !replay.kills.length) return empty;

  const startCandidates: number[] = [];
  const endCandidates: number[] = [];
  if (replay.damage.length) {
    startCandidates.push(replay.damage[0].time);
    endCandidates.push(replay.damage[replay.damage.length - 1].time);
  }
  if (replay.kills.length) {
    startCandidates.push(replay.kills[0].time);
    endCandidates.push(replay.kills[replay.kills.length - 1].time);
  }
  const start = Math.min(...startCandidates);
  const end = Math.max(...endCandidates);
  const span = Math.max(bucketMs, end - start);
  const bucketCount = Math.max(1, Math.ceil(span / bucketMs));

  const ts: number[] = [];
  for (let i = 0; i < bucketCount; i++) ts.push(start + i * bucketMs + bucketMs / 2);

  const damage = new Array<number>(bucketCount).fill(0);
  for (const ev of replay.damage) {
    const idx = Math.min(bucketCount - 1, Math.floor((ev.time - start) / bucketMs));
    damage[idx] += ev.damage;
  }

  const killTs: number[] = [];
  const killViews: number[] = [];
  for (const k of replay.kills) {
    const ent = replay.entities.get(k.aid);
    if (!ent || ent.kind !== "mob") continue;
    killTs.push(k.time);
    killViews.push(ent.view);
  }

  return { ts, damage, killTs, killViews, spanStart: start, spanEnd: end };
}

export type DpsAnalysisStats = {
  /** Width of the user's drag-selection rectangle (or full session). */
  selectionDurationMs: number;
  /** Damage events from the session player whose time falls in [startMs, endMs]. */
  events: number;
  totalDamage: number;
  firstDamageMs: number | null;
  lastDamageMs: number | null;
  /** lastDamageMs - firstDamageMs. 0 with 0 or 1 events. */
  combatSpanMs: number;
  /** totalDamage / (combatSpanMs / 1000). 0 when combatSpanMs is 0. */
  dps: number;
  /** combatSpanMs / (events - 1). null with <2 events. */
  meanIntervalMs: number | null;
  /** Largest gap between two consecutive damage events inside the window. */
  longestGapMs: number;
  highestHit: number;
  averageHit: number;
  distinctSkills: number;
  topSkillId: number | null;
  topSkillName: string | null;
  topSkillDamage: number;
};

/**
 * Per-window aggregation for the "Análise de DPS" tab. Filters
 * `replay.damage` to events sourced by the session player and falling inside
 * `range` (or the whole session when null). DPS is computed using the first
 * and last damage events INSIDE the window — not the selection rectangle's
 * edges — to keep the metric meaningful when the user drags loosely.
 */
export function dpsAnalysisStats(
  replay: Replay,
  range: Range,
  resolveSkill: (id: number) => string,
): DpsAnalysisStats {
  const aid = replay.sessionInfo.aid;
  const events: DamageEvent[] = [];
  for (const d of replay.damage) {
    if (d.source !== aid) continue;
    if (!inRange(d.time, range)) continue;
    events.push(d);
  }
  events.sort((a, b) => a.time - b.time);

  const selectionDurationMs = range
    ? Math.max(0, range.endMs - range.startMs)
    : replay.sessionInfo.durationMs;

  if (!events.length) {
    return {
      selectionDurationMs,
      events: 0,
      totalDamage: 0,
      firstDamageMs: null,
      lastDamageMs: null,
      combatSpanMs: 0,
      dps: 0,
      meanIntervalMs: null,
      longestGapMs: 0,
      highestHit: 0,
      averageHit: 0,
      distinctSkills: 0,
      topSkillId: null,
      topSkillName: null,
      topSkillDamage: 0,
    };
  }

  let totalDamage = 0;
  let highestHit = 0;
  let longestGapMs = 0;
  const skillTotals = new Map<number, number>();
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    totalDamage += ev.damage;
    if (ev.damage > highestHit) highestHit = ev.damage;
    skillTotals.set(ev.skillId, (skillTotals.get(ev.skillId) ?? 0) + ev.damage);
    if (i > 0) {
      const gap = ev.time - events[i - 1].time;
      if (gap > longestGapMs) longestGapMs = gap;
    }
  }

  const firstDamageMs = events[0].time;
  const lastDamageMs = events[events.length - 1].time;
  const combatSpanMs = Math.max(0, lastDamageMs - firstDamageMs);
  const dps = combatSpanMs > 0 ? totalDamage / (combatSpanMs / 1000) : 0;
  const meanIntervalMs =
    events.length >= 2 ? combatSpanMs / (events.length - 1) : null;

  let topSkillId: number | null = null;
  let topSkillDamage = 0;
  for (const [id, dmg] of skillTotals) {
    if (dmg > topSkillDamage) {
      topSkillDamage = dmg;
      topSkillId = id;
    }
  }
  const topSkillName = topSkillId === null ? null : resolveSkill(topSkillId);

  return {
    selectionDurationMs,
    events: events.length,
    totalDamage,
    firstDamageMs,
    lastDamageMs,
    combatSpanMs,
    dps: Math.round(dps),
    meanIntervalMs,
    longestGapMs,
    highestHit,
    averageHit: Math.round(totalDamage / events.length),
    distinctSkills: skillTotals.size,
    topSkillId,
    topSkillName,
    topSkillDamage,
  };
}
