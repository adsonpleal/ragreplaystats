import { useMemo, useState } from "react";
import type { Replay } from "rrfparser";
import { effectiveDuration } from "../../aggregate/index";
import {
  type DropFilter,
  type DropItemRow,
  type DropsSummary,
  dropTimeline,
  dropsByItem,
  dropsSummary,
  filterDrops,
} from "../../aggregate/drops";
import { type GroundDrop, groundDropsFor } from "../../aggregate/groundDrops";
import { t } from "../../i18n";
import { fmt, fmtDecimal, formatClock, formatDuration } from "../../lib/format";
import { useAppStore } from "../../store/useAppStore";
import { DataTable, type Column } from "../../ui/DataTable";
import { LineChart } from "../../ui/LineChart";
import { SummaryCard, type SummaryCell } from "../../ui/SummaryCard";
import { csvBlob } from "../export/csv";
import { downloadBlob, reportBaseName } from "../export/reportName";
import { dropEventsCsv, dropItemsCsv } from "./dropsCsv";
import { itemDpUrl, resolveItemName } from "./resolvers";

const FILTERS: ReadonlyArray<{ value: DropFilter; label: string }> = [
  { value: "all", label: t.dropsFilterAll },
  { value: "collected", label: t.dropsFilterCollected },
  { value: "uncollected", label: t.dropsFilterUncollected },
];

function Intro() {
  return (
    <section className="stats-card">
      <h2>{t.dropsTitle}</h2>
      <p dangerouslySetInnerHTML={{ __html: t.dropsIntro }} />
      <p className="section-hint">{t.dropsCaveat}</p>
    </section>
  );
}

function Totals({ summary, durationMs }: { summary: DropsSummary; durationMs: number }) {
  const cells: SummaryCell[] = [
    { label: t.dropsCellTotalDrops, value: fmt(summary.drops) },
    { label: t.dropsCellTotalUnits, value: fmt(summary.units) },
    { label: t.dropsCellCollectedUnits, value: fmt(summary.collectedUnits) },
    { label: t.dropsCellDistinctItems, value: fmt(summary.distinctItems) },
    {
      label: t.dropsCellPerHour,
      value: fmtDecimal(summary.unitsPerHour, 1),
      hint: t.cellSessionDuration + ": " + formatDuration(durationMs),
    },
    {
      label: t.dropsCellStillOnGround,
      value: fmt(summary.stillOnGround),
      hint: t.dropsCellStillOnGroundHint,
    },
  ];
  return <SummaryCard title={t.statsResumoTitle} cells={cells} />;
}

function Timeline({ drops, durationMs }: { drops: readonly GroundDrop[]; durationMs: number }) {
  // uPlot reloads and repaints whenever these arrays change identity, so they
  // must not be rebuilt on every render.
  const series = useMemo(() => dropTimeline(drops, durationMs), [drops, durationMs]);
  const lines = useMemo(
    () => [
      { label: t.dropsChartDropped, values: series.dropped, paletteIndex: 0 },
      { label: t.dropsChartCollected, values: series.collected, paletteIndex: 4 },
    ],
    [series],
  );
  if (!series.ts.length) return null;
  return (
    <div>
      <h2 className="section-title">{t.dropsChartTitle}</h2>
      <div className="stats-chart">
        <LineChart xs={series.ts} series={lines} height={240} />
      </div>
      <p className="section-hint">{t.dropsChartBucketHint(Math.round(series.bucketMs / 1000))}</p>
    </div>
  );
}

const itemCols: Column<DropItemRow>[] = [
  { key: "itemId", label: t.colId, numeric: true, href: (r) => itemDpUrl(r.itemId) },
  { key: "name", label: t.dropsColItem },
  { key: "drops", label: t.dropsColDrops, numeric: true, format: (r) => fmt(r.drops) },
  { key: "quantity", label: t.dropsColQuantity, numeric: true, format: (r) => fmt(r.quantity) },
  {
    key: "collected",
    label: t.dropsColCollectedQty,
    numeric: true,
    format: (r) => fmt(r.collected),
  },
  { key: "perHour", label: t.dropsColPerHour, numeric: true, format: (r) => fmtDecimal(r.perHour) },
  { key: "firstMs", label: t.dropsColFirst, numeric: true, format: (r) => formatClock(r.firstMs) },
  { key: "lastMs", label: t.dropsColLast, numeric: true, format: (r) => formatClock(r.lastMs) },
];

function eventColumns(resolveItem: (id: number) => string): Column<GroundDrop>[] {
  return [
    { key: "time", label: t.dropsColTime, numeric: true, format: (d) => formatClock(d.time) },
    { key: "itemId", label: t.colId, numeric: true, href: (d) => itemDpUrl(d.itemId) },
    {
      key: "name",
      label: t.dropsColItem,
      format: (d) => resolveItem(d.itemId),
      sortValue: (d) => resolveItem(d.itemId),
    },
    { key: "amount", label: t.dropsColAmount, numeric: true },
    { key: "cell", label: t.dropsColCell, format: (d) => `${d.x}, ${d.y}`, sortValue: (d) => d.x },
    {
      key: "collected",
      label: t.dropsColCollected,
      format: (d) => (d.collected ? t.dropsYes : t.dropsNo),
      sortValue: (d) => (d.collected ? 1 : 0),
    },
    {
      key: "removedAt",
      label: t.dropsColRemovedAt,
      numeric: true,
      format: (d) => (d.removedAt == null ? t.none : formatClock(d.removedAt)),
      sortValue: (d) => d.removedAt ?? Number.MAX_SAFE_INTEGER,
    },
  ];
}

/**
 * Drops tab — every item the recording saw hit the floor: totals, a timeline of
 * what fell against what was picked up, the per-item table with items/hour, the
 * raw event list, and both tables as CSV.
 */
export function DropsTab({ replay }: { replay: Replay }) {
  const db = useAppStore((s) => s.db);
  const namesVersion = useAppStore((s) => s.namesVersion);
  const bytes = useAppStore((s) => s.replayBytes);
  const [filter, setFilter] = useState<DropFilter>("all");

  const resolveItem = (id: number) => resolveItemName(db, id);
  const all = groundDropsFor(bytes, replay.itemAdds);
  const durationMs = effectiveDuration(replay, null);
  const shown = filterDrops(all, filter);
  const itemRows = dropsByItem(shown, durationMs, resolveItem);
  // Rebuilt, the column array makes DataTable re-sort every event on each
  // render; it only changes when a name can resolve differently.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const eventCols = useMemo(() => eventColumns(resolveItem), [db, namesVersion]);

  const exportCsv = (text: string, suffix: string) =>
    downloadBlob(csvBlob(text), `${reportBaseName(replay)}-${suffix}.csv`);

  if (!all.length) {
    return (
      <>
        <Intro />
        <p className="section-hint">{t.dropsEmpty}</p>
      </>
    );
  }

  return (
    <>
      <Intro />
      <Totals summary={dropsSummary(all, durationMs)} durationMs={durationMs} />
      <Timeline drops={all} durationMs={durationMs} />
      <div className="filter-row">
        <label htmlFor="drops-filter">{t.dropsFilterLabel}</label>
        <select
          id="drops-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value as DropFilter)}
        >
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="export-btn"
          onClick={() => exportCsv(dropItemsCsv(itemRows), "drops-por-item")}
        >
          {t.dropsExportItems}
        </button>
        <button
          type="button"
          className="export-btn"
          onClick={() => exportCsv(dropEventsCsv(shown, resolveItem), "drops")}
        >
          {t.dropsExportEvents}
        </button>
      </div>
      {shown.length ? (
        <>
          <h2 className="section-title">{t.dropsTableTitle}</h2>
          <DataTable
            cols={itemCols}
            rows={itemRows}
            options={{ initialSort: { key: "quantity", asc: false } }}
          />
          <h2 className="section-title">{t.dropsEventsTitle}</h2>
          <DataTable
            cols={eventCols}
            rows={shown}
            options={{ initialSort: { key: "time", asc: true } }}
          />
        </>
      ) : (
        <p className="section-hint">{t.dropsEmptyInWindow}</p>
      )}
    </>
  );
}
