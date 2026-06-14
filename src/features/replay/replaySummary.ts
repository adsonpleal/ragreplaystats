import { mvpMatchups } from "../../aggregate/index";
import type { ReferenceDb } from "../../db/loader";
import type { ReplaySummary } from "../../firebase";
import type { Replay } from "../../rrf/types";

/**
 * Build the denormalised summary stored alongside an uploaded replay (and used
 * to seed the leaderboard). Mob/job resolvers come from the loaded reference DB
 * when present; otherwise the `mob#<id>` / `job#<id>` placeholders are passed
 * through and the aggregator prefers server-reported names / leaves class empty.
 */
export function buildReplaySummary(
  replay: Replay,
  db: ReferenceDb | null,
): ReplaySummary {
  const totalDamage = replay.damage.reduce((s, e) => s + e.damage, 0);
  const seconds = replay.sessionInfo.durationMs / 1000;
  const avgDps = seconds > 0 ? Math.round(totalDamage / seconds) : 0;
  const resolveMob = db ? (id: number) => db.resolveMob(id) : (id: number) => `mob#${id}`;
  const resolveJob = db ? (id: number) => db.resolveJob(id) : (id: number) => `job#${id}`;
  return {
    player: replay.sessionInfo.player || "",
    map: replay.sessionInfo.map || "",
    recordedAt: replay.sessionInfo.recordedAt,
    durationMs: replay.sessionInfo.durationMs,
    totalDamage,
    avgDps,
    damageEvents: replay.damage.length,
    kills: replay.kills.length,
    entitiesSeen: replay.entities.size,
    handledPackets: replay.totals.handledPackets,
    packetCount: replay.totals.packetCount,
    mvpRecords: mvpMatchups(replay, resolveMob, resolveJob),
  };
}
