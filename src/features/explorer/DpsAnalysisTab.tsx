import { dpsAnalysisStats } from "../../aggregate/index";
import { t } from "../../i18n";
import { fmt, formatDuration } from "../../lib/format";
import type { Replay } from "../../rrf/types";
import { DpsScatter } from "../../ui/DpsScatter";
import { SummaryCard, type SummaryCell } from "../../ui/SummaryCard";
import { useAppStore } from "../../store/useAppStore";
import { resolveSkillName } from "./resolvers";

function DpsAnalysisHelp() {
  const range = useAppStore((s) => s.dpsAnalysisRange);
  const setRange = useAppStore((s) => s.setDpsAnalysisRange);
  return (
    <section className="stats-card">
      <h2>
        {t.dpsAnalysisHelpTitle}
        {range && (
          <span className="muted small" style={{ marginLeft: "0.75rem" }}>
            {t.dpsAnalysisRangeLabel(formatDuration(range.startMs), formatDuration(range.endMs))}
          </span>
        )}
      </h2>
      <p>
        <strong>{t.dpsAnalysisHelpHowToUse}</strong> {t.dpsAnalysisHelpHowToUseBody}
      </p>
      <p>
        <strong>{t.dpsAnalysisHelpDpsCalc}</strong> {t.dpsAnalysisHelpDpsCalcBody}
      </p>
      <p>
        <strong>{t.dpsAnalysisHelpTimeMetrics}</strong> {t.dpsAnalysisHelpTimeMetricsBody}
      </p>
      <button type="button" className="share-btn" disabled={!range} onClick={() => setRange(null)}>
        {t.dpsAnalysisClearSelection}
      </button>
    </section>
  );
}

function DpsAnalysisChart({ replay }: { replay: Replay }) {
  const db = useAppStore((s) => s.db);
  const range = useAppStore((s) => s.dpsAnalysisRange);
  const setRange = useAppStore((s) => s.setDpsAnalysisRange);
  const aid = replay.sessionInfo.aid;

  const damage = replay.damage
    .filter((d) => d.source === aid)
    .map((d) => ({ time: d.time, damage: d.damage, skillId: d.skillId, skillName: resolveSkillName(db, d.skillId) }));
  // Server prepends "<playerName> : " to echoed self-chat — strip it.
  const playerPrefix = `${replay.sessionInfo.player} : `;
  const chat = replay.chats.map((c) => ({
    time: c.time,
    message: c.message.startsWith(playerPrefix) ? c.message.slice(playerPrefix.length) : c.message,
  }));

  if (!damage.length) {
    return (
      <section className="stats-card">
        <h2>{t.dpsAnalysisChartTitle}</h2>
        <p className="section-hint">{t.dpsAnalysisEmpty}</p>
      </section>
    );
  }

  return (
    <section className="stats-card">
      <h2 className="section-title">{t.dpsAnalysisChartTitle}</h2>
      <DpsScatter data={{ damage, chat }} range={range} onSelect={setRange} />
      <div className="dps-analysis-legend">
        <span className="dps-analysis-legend-dot dps-analysis-legend-dot--damage" />
        {t.dpsAnalysisDamageSeries}
        <span className="dps-analysis-legend-dot dps-analysis-legend-dot--chat" />
        {t.dpsAnalysisChatSeries}
      </div>
    </section>
  );
}

function DpsAnalysisStats({ replay }: { replay: Replay }) {
  const db = useAppStore((s) => s.db);
  const range = useAppStore((s) => s.dpsAnalysisRange);
  const aid = replay.sessionInfo.aid;
  if (!replay.damage.some((d) => d.source === aid)) return null;

  const stats = dpsAnalysisStats(replay, range, (id) => resolveSkillName(db, id));
  const cells: SummaryCell[] = [
    { label: t.cellSelectionDuration, value: formatDuration(stats.selectionDurationMs) },
    { label: t.cellEventsInWindow, value: fmt(stats.events) },
    { label: t.totalDamage, value: fmt(stats.totalDamage) },
    {
      label: t.cellCombatSpan,
      value: stats.combatSpanMs > 0 ? formatDuration(stats.combatSpanMs) : t.none,
      hint: t.cellCombatSpanHint,
    },
    { label: t.cellWindowDps, value: stats.dps > 0 ? fmt(stats.dps) : t.none },
    {
      label: t.cellMeanInterval,
      value: stats.meanIntervalMs == null ? t.none : `${Math.round(stats.meanIntervalMs)} ms`,
    },
    { label: t.cellHighestSingleHit, value: stats.highestHit > 0 ? fmt(stats.highestHit) : t.none },
    { label: t.cellAverageHit, value: stats.averageHit > 0 ? fmt(stats.averageHit) : t.none },
    {
      label: t.cellLongestGap,
      value: stats.longestGapMs > 0 ? `${Math.round(stats.longestGapMs)} ms` : t.none,
    },
    { label: t.cellDistinctSkills, value: fmt(stats.distinctSkills) },
    {
      label: t.cellTopSkillWindow,
      value: stats.topSkillName ?? t.none,
      hint: stats.topSkillId == null ? undefined : fmt(stats.topSkillDamage),
    },
  ];

  return <SummaryCard title={t.dpsAnalysisStatsTitle} cells={cells} />;
}

/** Análise de DPS tab — help card + drag-select scatter + window stats. */
export function DpsAnalysisTab({ replay }: { replay: Replay }) {
  return (
    <>
      <DpsAnalysisHelp />
      <DpsAnalysisChart replay={replay} />
      <DpsAnalysisStats replay={replay} />
    </>
  );
}
