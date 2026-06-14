import { locale, t } from "../../i18n";
import { fmt, formatDuration } from "../../lib/format";
import type { Replay } from "../../rrf/types";

/** The "Sessão" stat card shown above the explorer for the loaded replay. */
export function SessionSummary({ replay }: { replay: Replay }) {
  const totalDmg = replay.damage.reduce((s, e) => s + e.damage, 0);
  const seconds = replay.sessionInfo.durationMs / 1000;
  const dps = seconds > 0 ? totalDmg / seconds : 0;

  return (
    <section id="summary">
      <h2>{t.sessionTitle}</h2>
      <div className="summary-grid">
        <div>
          <span>{t.player}</span>
          <span>{replay.sessionInfo.player || t.none}</span>
        </div>
        <div>
          <span>{t.map}</span>
          <span>{replay.sessionInfo.map || t.none}</span>
        </div>
        <div>
          <span>{t.recordedAt}</span>
          <span>{replay.sessionInfo.recordedAt.toLocaleString(locale)}</span>
        </div>
        <div>
          <span>{t.duration}</span>
          <span>{formatDuration(replay.sessionInfo.durationMs)}</span>
        </div>
        <div>
          <span>{t.totalDamage}</span>
          <span>{fmt(totalDmg)}</span>
        </div>
        <div>
          <span>{t.avgDps}</span>
          <span>{fmt(Math.round(dps))}</span>
        </div>
        <div>
          <span>{t.damageEvents}</span>
          <span>{fmt(replay.damage.length)}</span>
        </div>
        <div>
          <span>{t.kills}</span>
          <span>{fmt(replay.kills.length)}</span>
        </div>
        <div>
          <span>{t.entitiesSeen}</span>
          <span>{fmt(replay.entities.size)}</span>
        </div>
        <div>
          <span>{t.packetsParsed}</span>
          <span>
            {fmt(replay.totals.handledPackets)} / {fmt(replay.totals.packetCount)}
          </span>
        </div>
      </div>
    </section>
  );
}
