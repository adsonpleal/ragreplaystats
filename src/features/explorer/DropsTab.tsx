import { useMemo, useState } from "react";
import type { Replay } from "rrfparser";
import { effectiveDuration } from "../../aggregate/index";
import {
  type DropFilter,
  type DropItemRow,
  type GroundDrop,
  dropTimeline,
  dropsByItem,
  filterDrops,
  groundDropsFor,
  pickBucketMs,
} from "../../aggregate/drops";
import { locale, t } from "../../i18n";
import { fmt, formatDuration } from "../../lib/format";
import { useAppStore } from "../../store/useAppStore";
import { DataTable, type Column } from "../../ui/DataTable";
import { LineChart } from "../../ui/LineChart";
import { SummaryCard, type SummaryCell } from "../../ui/SummaryCard";
import { downloadBlob, reportBaseName } from "../export/reportName";
import { csvBlob, dropEventsCsv, dropItemsCsv } from "./dropsCsv";
import { itemDpUrl, resolveItemName } from "./resolvers";

const FILTERS: ReadonlyArray<{ value: DropFilter; label: string }> = [
  { value: "all", label: t.dropsFilterAll },
  { value: "collected", label: t.dropsFilterCollected },
  { value: "uncollected", label: t.dropsFilterUncollected },
];

/** `12345` → `"0:12"` — the chart's x axis is seconds, so rows line up with it. */
function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function Intro() {
  return (
    <section className="stats-card">
      <h2>{t.dropsTitle}</h2>
      <p dangerouslySetInnerHTML={{ __html: t.dropsIntro }} />
      <p className="section-hint">{t.dropsCaveat}</p>
    </section>
  );
}

function Totals({ drops, durationMs }: { drops: readonly GroundDrop[]; durationMs: number }) {
  const units = drops.reduce((s, d) => s + d.amount, 0);
  const collected = drops.reduce((s, d) => (d.collected ? s + d.amount : s), 0);
  const stillOnGround = drops.filter((d) => d.removedAt == null).length;
  const perHour = units / (Math.max(1, durationMs) / 3_600_000);

  const cells: SummaryCell[] = [
    { label: t.dropsCellTotalDrops, value: fmt(drops.length) },
    { label: t.dropsCellTotalUnits, value: fmt(units) },
    { label: t.dropsCellCollectedUnits, value: fmt(collected) },
    { label: t.dropsCellDistinctItems, value: fmt(new Set(drops.map((d) => d.itemId)).size) },
    {
      label: t.dropsCellPerHour,
      value: perHour.toLocaleString(locale, { maximumFractionDigits: 1 }),
      hint: t.cellSessionDuration + ": " + formatDuration(durationMs),
    },
    {
      label: t.dropsCellStillOnGround,
      value: fmt(stillOnGround),
      hint: t.dropsCellStillOnGroundHint,
    },
  ];
  return <SummaryCard title={t.statsResumoTitle} cells={cells} />;
}

function Timeline({
  drops,
  durationMs,
}: {
  drops: readonly GroundDrop[];
  durationMs: number;
}) {
  const bucketMs = pickBucketMs(durationMs);
  const series = dropTimeline(drops, durationMs, bucketMs);
  if (!series.ts.length) return null;
  return (
    <div>
      <h2 className="section-title">{t.dropsChartTitle}</h2>
      <div className="stats-chart">
        <LineChart
          xs={series.ts}
          series={[
            { label: t.dropsChartDropped, values: series.dropped, paletteIndex: 0 },
            { label: t.dropsChartCollected, values: series.collected, paletteIndex: 4 },
          ]}
          height={240}
        />
      </div>
      <p className="section-hint">{t.dropsChartBucketHint(Math.round(bucketMs / 1000))}</p>
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
  {
    key: "perHour",
    label: t.dropsColPerHour,
    numeric: true,
    format: (r) => r.perHour.toLocaleString(locale, { maximumFractionDigits: 2 }),
  },
  { key: "firstMs", label: t.dropsColFirst, numeric: true, format: (r) => clock(r.firstMs) },
  { key: "lastMs", label: t.dropsColLast, numeric: true, format: (r) => clock(r.lastMs) },
];

function eventColumns(resolveItem: (id: number) => string): Column<GroundDrop>[] {
  return [
    { key: "time", label: t.dropsColTime, numeric: true, format: (d) => clock(d.time) },
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
      format: (d) => (d.removedAt == null ? t.none : clock(d.removedAt)),
      sortValue: (d) => d.removedAt ?? Number.MAX_SAFE_INTEGER,
    },
  ];
}

/**
 * Drops tab — every item the recording saw hit the floor: totals, a timeline of
 * what fell against what was picked up, the per-item table with items/hour, the
 * raw event list, and both as CSV.
 */
export function DropsTab({ replay }: { replay: Replay }) {
  const db = useAppStore((s) => s.db);
  const bytes = useAppStore((s) => s.replayBytes);
  const [filter, setFilter] = useState<DropFilter>("all");

  const resolveItem = (id: number) => resolveItemName(db, id);
  // Resolving names needs the reference DB, which lands after the first render;
  // the decode itself does not, so keep them in separate memos.
  const all = useMemo(() => groundDropsFor(bytes, replay.itemAdds), [bytes, replay.itemAdds]);
  const durationMs = effectiveDuration(replay, null);
  const shown = useMemo(() => filterDrops(all, filter), [all, filter]);
  const itemRows = dropsByItem(shown, durationMs, resolveItem);

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
      <Totals drops={all} durationMs={durationMs} />
      <Timeline drops={all} durationMs={durationMs} />
      <div className="drops-toolbar">
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
        <button type="button" className="export-btn" onClick={() => exportCsv(dropItemsCsv(itemRows), "drops-por-item")}>
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
            cols={eventColumns(resolveItem)}
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
