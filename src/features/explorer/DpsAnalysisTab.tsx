import { useMemo } from "react";
import { dpsAnalysisStats } from "../../aggregate/index";
import { t } from "../../i18n";
import { fmt, formatClock, formatDuration } from "../../lib/format";
import type { Replay } from "rrfparser";
import { DpsScatter } from "../../ui/DpsScatter";
import { SummaryCard, type SummaryCell } from "../../ui/SummaryCard";
import { fitSpan, zoomAt, ZOOM_STEP_BUTTON, type TimelineSpan } from "../../ui/timelineZoom";
import { type DragRange, useAppStore } from "../../store/useAppStore";
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
        <strong>{t.dpsAnalysisHelpZoom}</strong> {t.dpsAnalysisHelpZoomBody}
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

/**
 * Zoom controls under the timeline. They exist next to the wheel gesture
 * because the wheel is both undiscoverable and absent on a touch screen —
 * "Ampliar na seleção" is the only way in for anyone on a phone.
 */
function DpsZoomControls({
  full,
  range,
  zoom,
  setZoom,
}: {
  full: TimelineSpan;
  range: DragRange;
  zoom: DragRange;
  setZoom: (range: DragRange) => void;
}) {
  return (
    <div className="brush-actions">
      <button type="button" onClick={() => setZoom(zoomAt(zoom, full, 1 / ZOOM_STEP_BUTTON))}>
        {t.dpsAnalysisZoomIn}
      </button>
      <button
        type="button"
        disabled={!zoom}
        onClick={() => setZoom(zoomAt(zoom, full, ZOOM_STEP_BUTTON))}
      >
        {t.dpsAnalysisZoomOut}
      </button>
      <button type="button" disabled={!range} onClick={() => range && setZoom(fitSpan(range, full))}>
        {t.dpsAnalysisZoomToSelection}
      </button>
      <button type="button" disabled={!zoom} onClick={() => setZoom(null)}>
        {t.dpsAnalysisZoomReset}
      </button>
      <span>
        {zoom
          ? t.dpsAnalysisZoomLabel(formatClock(zoom.startMs), formatClock(zoom.endMs))
          : t.dpsAnalysisZoomFullLabel}
      </span>
    </div>
  );
}

function DpsAnalysisChart({ replay }: { replay: Replay }) {
  const db = useAppStore((s) => s.db);
  const range = useAppStore((s) => s.dpsAnalysisRange);
  const setRange = useAppStore((s) => s.setDpsAnalysisRange);
  const zoom = useAppStore((s) => s.dpsAnalysisZoom);
  const setZoom = useAppStore((s) => s.setDpsAnalysisZoom);
  const aid = replay.sessionInfo.aid;

  // A wheel notch re-renders this, so the series and the span they cover are
  // derived once per replay instead of once per zoom step.
  const { damage, chat, full } = useMemo(() => {
    const damage = replay.damage
      .filter((d) => d.source === aid)
      .map((d) => ({
        time: d.time,
        damage: d.damage,
        skillId: d.skillId,
        skillName: resolveSkillName(db, d.skillId),
      }));
    // Server prepends "<playerName> : " to echoed self-chat — strip it.
    const playerPrefix = `${replay.sessionInfo.player} : `;
    const chat = replay.chats.map((c) => ({
      time: c.time,
      message: c.message.startsWith(playerPrefix)
        ? c.message.slice(playerPrefix.length)
        : c.message,
    }));
    // What the chart can show, which is also what the zoom clamps to: the first
    // and last event drawn, damage or chat.
    let startMs = Infinity;
    let endMs = -Infinity;
    for (const d of damage) {
      if (d.time < startMs) startMs = d.time;
      if (d.time > endMs) endMs = d.time;
    }
    for (const c of chat) {
      if (c.time < startMs) startMs = c.time;
      if (c.time > endMs) endMs = c.time;
    }
    return { damage, chat, full: { startMs, endMs } };
  }, [replay, db, aid]);

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
      <DpsScatter
        data={{ damage, chat }}
        range={range}
        onSelect={setRange}
        xRangeMs={zoom}
        fullRangeMs={full}
        onXRangeChange={setZoom}
      />
      <DpsZoomControls full={full} range={range} zoom={zoom} setZoom={setZoom} />
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
