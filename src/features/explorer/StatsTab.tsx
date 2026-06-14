import {
  brushSeries,
  computeResumo,
  consumablesByItem,
  killsByPlayerAndMob,
  lootByItem,
  paramCurve,
  SP_HP,
  SP_MAXHP,
  SP_MAXSP,
  SP_SP,
} from "../../aggregate/index";
import { t } from "../../i18n";
import { fmt, formatDuration } from "../../lib/format";
import type { Replay } from "../../rrf/types";
import { BarChart, type BarRow } from "../../ui/BarChart";
import { LineChart } from "../../ui/LineChart";
import { SummaryCard, type SummaryCell } from "../../ui/SummaryCard";
import { TimelineBrush } from "../../ui/TimelineBrush";
import { useAppStore } from "../../store/useAppStore";
import { Equipment } from "./Equipment";
import { hasCritData } from "./entityNames";
import { itemDpUrl, mobDpUrl, pct, resolveItemName, resolveMobName, resolveSkillName } from "./resolvers";

const BRUSH_BUCKET_MS = 1_000;
const ITEM_BAR_LIMIT = 30;

function ResumoCard({ replay }: { replay: Replay }) {
  const db = useAppStore((s) => s.db);
  const range = useAppStore((s) => s.selectedTimeRange);
  const stats = computeResumo(replay, range);
  const skill = (id: number) => resolveSkillName(db, id);
  const mob = (id: number) => resolveMobName(db, id);

  const hh = stats.highestHit;
  let highestHitHint: string | undefined;
  if (hh) {
    const target = replay.entities.get(hh.targetAid);
    const targetName = target?.name ?? mob(target?.view ?? 0);
    highestHitHint = `${hh.skillId ? skill(hh.skillId) : t.autoAttack} → ${targetName}`;
  }

  const cells: SummaryCell[] = [
    { label: t.cellTotalDealt, value: fmt(stats.totalDealt) },
    { label: t.cellTotalTaken, value: fmt(stats.totalTaken) },
    {
      label: t.cellEffectiveDps,
      value: fmt(stats.effectiveDps),
      hint: t.cellSessionDuration + ": " + formatDuration(stats.durationMs),
    },
    { label: t.cellHits, value: fmt(stats.hitsLanded) },
    ...(hasCritData(replay)
      ? [
          {
            label: t.cellCrits,
            value: stats.hitsLanded
              ? `${fmt(stats.crits)} (${pct(stats.crits, stats.hitsLanded)}%)`
              : "0",
          } as SummaryCell,
        ]
      : []),
    {
      label: t.cellMisses,
      value: stats.hitsLanded
        ? `${fmt(stats.hitsMissed)} (${pct(stats.hitsMissed, stats.hitsLanded)}%)`
        : "0",
    },
    {
      label: t.cellHighestHit,
      value: hh ? fmt(hh.damage) : t.none,
      hint: highestHitHint,
    },
    {
      label: t.cellMostUsedSkill,
      value: stats.mostUsedSkillId ? skill(stats.mostUsedSkillId) : t.none,
      hint: stats.mostUsedSkillId
        ? `${fmt(stats.mostUsedSkillCount)} ${stats.mostUsedSkillCount === 1 ? "uso" : "usos"}`
        : undefined,
    },
    { label: t.cellKills, value: fmt(stats.kills) },
    { label: t.cellBossKills, value: fmt(stats.bossKills) },
    {
      label: t.cellTtfk,
      value: stats.timeToFirstKillMs == null ? t.none : formatDuration(stats.timeToFirstKillMs),
    },
    {
      label: t.cellAvgKillInterval,
      value: stats.avgKillIntervalMs ? formatDuration(stats.avgKillIntervalMs) : t.none,
    },
    {
      label: t.cellTopSpecies,
      value: stats.topKilledSpecies ? mob(stats.topKilledSpecies.view) : t.none,
      hint: stats.topKilledSpecies
        ? `${fmt(stats.topKilledSpecies.count)} ${stats.topKilledSpecies.count === 1 ? "abate" : "abates"}`
        : undefined,
    },
    { label: t.cellLevelsGained, value: fmt(stats.baseLevelsGained) },
    { label: t.cellJobLevelsGained, value: fmt(stats.jobLevelsGained) },
    { label: t.cellZenyDelta, value: fmt(stats.zenyDelta) },
    { label: t.cellMapsVisited, value: fmt(stats.mapsVisited) },
    { label: t.cellDeaths, value: fmt(stats.deaths) },
  ];

  return <SummaryCard title={t.statsResumoTitle} cells={cells} />;
}

function BrushCard({ replay }: { replay: Replay }) {
  const range = useAppStore((s) => s.selectedTimeRange);
  const setRange = useAppStore((s) => s.setSelectedTimeRange);
  const series = brushSeries(replay, BRUSH_BUCKET_MS);
  if (!series.ts.length) return null;
  return (
    <section className="stats-card brush-host">
      <h2 style={{ fontSize: "0.85rem", fontWeight: 400, color: "var(--muted)" }}>
        {t.statsBrushHint}
      </h2>
      <TimelineBrush data={series} range={range} onSelect={setRange} />
      <div className="brush-actions">
        {range && (
          <>
            <span>
              {t.statsRangeLabel(formatDuration(range.startMs), formatDuration(range.endMs))}
            </span>
            <button type="button" onClick={() => setRange(null)}>
              {t.statsBrushClear}
            </button>
          </>
        )}
      </div>
    </section>
  );
}

function itemBars(
  rows: Array<{ itemId: number; name: string; quantity: number; count?: number }>,
  withUses: boolean,
): BarRow[] {
  return rows.slice(0, ITEM_BAR_LIMIT).map((r) => ({
    key: r.itemId,
    label: r.itemId ? `#${r.itemId} · ${r.name}` : r.name,
    labelSegments: r.itemId
      ? [{ text: `#${r.itemId}`, href: itemDpUrl(r.itemId) }, { text: ` · ${r.name}` }]
      : undefined,
    value: r.quantity,
    display: withUses ? `${fmt(r.quantity)} (${r.count} usos)` : fmt(r.quantity),
  }));
}

function Consumables({ replay }: { replay: Replay }) {
  const db = useAppStore((s) => s.db);
  const range = useAppStore((s) => s.selectedTimeRange);
  const rows = consumablesByItem(replay, range, (id) => resolveItemName(db, id));
  return (
    <div>
      <h2 className="section-title">{t.statsConsumablesTitle}</h2>
      {rows.length ? (
        <BarChart rows={itemBars(rows, true)} />
      ) : (
        <p className="section-hint">{t.statsConsumablesEmpty}</p>
      )}
    </div>
  );
}

function Loot({ replay }: { replay: Replay }) {
  const db = useAppStore((s) => s.db);
  const range = useAppStore((s) => s.selectedTimeRange);
  const rows = lootByItem(replay, range, (id) => resolveItemName(db, id));
  return (
    <div>
      <h2 className="section-title">{t.statsLootTitle}</h2>
      {rows.length ? (
        <BarChart rows={itemBars(rows, false)} />
      ) : (
        <p className="section-hint">{t.statsLootEmpty}</p>
      )}
    </div>
  );
}

function HpSpChart({ replay }: { replay: Replay }) {
  const range = useAppStore((s) => s.selectedTimeRange);
  const hp = paramCurve(replay, SP_HP, range);
  const sp = paramCurve(replay, SP_SP, range);
  const maxHp = paramCurve(replay, SP_MAXHP, range);
  const maxSp = paramCurve(replay, SP_MAXSP, range);
  if (!hp.ts.length && !sp.ts.length) return null;

  const allTs = new Set<number>([...hp.ts, ...sp.ts, ...maxHp.ts, ...maxSp.ts]);
  const sortedTs = [...allTs].sort((a, b) => a - b);
  const sample = (curve: { ts: number[]; values: number[] }, at: number) => {
    let v = 0;
    for (let i = 0; i < curve.ts.length; i++) {
      if (curve.ts[i] > at) break;
      v = curve.values[i];
    }
    return v;
  };

  return (
    <div>
      <h2 className="section-title">{t.statsHpSpChartTitle}</h2>
      <div className="stats-chart">
        <LineChart
          xs={sortedTs}
          series={[
            { label: "HP", values: sortedTs.map((x) => sample(hp, x)), paletteIndex: 6 },
            { label: "HP máx.", values: sortedTs.map((x) => sample(maxHp, x)), paletteIndex: 7 },
            { label: "SP", values: sortedTs.map((x) => sample(sp, x)), paletteIndex: 1 },
            { label: "SP máx.", values: sortedTs.map((x) => sample(maxSp, x)), paletteIndex: 2 },
          ]}
          height={240}
        />
      </div>
    </div>
  );
}

function KillsByTypeChart({ replay }: { replay: Replay }) {
  const db = useAppStore((s) => s.db);
  const range = useAppStore((s) => s.selectedTimeRange);
  const mob = (id: number) => resolveMobName(db, id);

  let bars: BarRow[] | null = null;

  if (range) {
    // killsByPlayerAndMob doesn't accept a time filter, so re-aggregate the
    // player's killing blows within the brushed window by walking the events.
    const filtered = new Map<number, { name: string; count: number }>();
    for (const k of replay.kills) {
      if (k.time < range.startMs || k.time > range.endMs) continue;
      const ent = replay.entities.get(k.aid);
      if (!ent || ent.kind !== "mob") continue;
      let lastHit: number | null = null;
      let lastSrc = 0;
      for (const d of replay.damage) {
        if (d.target !== k.aid || d.time > k.time) continue;
        const src = replay.entities.get(d.source);
        if (!src || (src.kind !== "pc" && src.kind !== "homun" && src.kind !== "merc")) continue;
        if (lastHit == null || d.time > lastHit) {
          lastHit = d.time;
          lastSrc = d.source;
        }
      }
      if (lastSrc !== replay.sessionInfo.aid) continue;
      const cur = filtered.get(ent.view) ?? { name: mob(ent.view), count: 0 };
      cur.count += 1;
      filtered.set(ent.view, cur);
    }
    if (!filtered.size) return null;
    bars = [...filtered.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([view, v]) => ({
        key: view,
        label: view ? `#${view} · ${v.name}` : v.name,
        labelSegments: view
          ? [{ text: `#${view}`, href: mobDpUrl(view) }, { text: ` · ${v.name}` }]
          : undefined,
        value: v.count,
        display: fmt(v.count),
      }));
  } else {
    const rows = killsByPlayerAndMob(replay, { sourceAid: replay.sessionInfo.aid }, mob);
    if (!rows.length) return null;
    bars = rows.map((r) => ({
      key: r.monsterView,
      label: r.monsterView ? `#${r.monsterView} · ${r.monsterName}` : r.monsterName,
      labelSegments: r.monsterView
        ? [{ text: `#${r.monsterView}`, href: mobDpUrl(r.monsterView) }, { text: ` · ${r.monsterName}` }]
        : undefined,
      value: r.count,
      display: fmt(r.count),
    }));
  }

  return (
    <div>
      <h2 className="section-title">{t.statsKillsChartTitle}</h2>
      <BarChart rows={bars} />
    </div>
  );
}

/** Estatísticas tab — equipment + session resumo + brush + item/HP charts. */
export function StatsTab({ replay }: { replay: Replay }) {
  return (
    <>
      <Equipment replay={replay} />
      <ResumoCard replay={replay} />
      <BrushCard replay={replay} />
      <Consumables replay={replay} />
      <Loot replay={replay} />
      <HpSpChart replay={replay} />
      <KillsByTypeChart replay={replay} />
    </>
  );
}
