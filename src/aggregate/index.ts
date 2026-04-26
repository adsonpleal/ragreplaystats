import type { DamageEvent, Replay } from "../rrf/types.js";

const PLAYER_KINDS = new Set(["pc", "homun", "merc"]);

function isPlayerSource(replay: Replay, aid: number): boolean {
  const ent = replay.entities.get(aid);
  return !!ent && PLAYER_KINDS.has(ent.kind);
}

function isMobTarget(replay: Replay, aid: number): boolean {
  const ent = replay.entities.get(aid);
  return !!ent && ent.kind === "mob";
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
    const ent = replay.entities.get(ev.target)!;
    let agg = map.get(ev.target);
    if (!agg) {
      agg = {
        aid: ev.target,
        view: ent.view,
        name: ent.name || `mob#${ent.view || ev.target}`,
        isBoss: ent.isBoss,
        maxHp: ent.maxHp,
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
    const ent = replay.entities.get(ev.target)!;
    let agg = map.get(ev.target);
    if (!agg) {
      agg = {
        aid: ev.target,
        view: ent.view,
        name: ent.name || `mob#${ent.view || ev.target}`,
        isBoss: ent.isBoss,
        maxHp: ent.maxHp,
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
      name: acc.skillId === 0 ? "Auto-attack" : resolveSkill(acc.skillId),
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
 * Count skill uses by (player, skill). Auto-attacks are excluded — only
 * non-zero skill IDs count. Combines damage events (each skill cast that
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
    if (ev.skillId === 0) continue;
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
      name: acc.skillId === 0 ? "Auto-attack" : resolveSkill(acc.skillId),
      count: acc.count,
      totalDamage: acc.totalDamage,
      avgDamage: acc.count ? Math.round(acc.totalDamage / acc.count) : 0,
      multiHitAvg: acc.count ? +(acc.multiHitTotal / acc.count).toFixed(2) : 0,
      avgCastMs: acc.castCount ? Math.round(acc.castMsTotal / acc.castCount) : null,
    });
  }

  return result.sort((a, b) => b.totalDamage - a.totalDamage);
}
