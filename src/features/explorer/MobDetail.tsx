import {
  isPlayerSource,
  type MobSkillAgg,
  mobHpCurve,
  mobSkillBreakdown,
  type PlayerAgg,
  playersDamagedByMonster,
} from "../../aggregate/index";
import { t } from "../../i18n";
import { fmt, formatDuration } from "../../lib/format";
import type { Replay } from "../../rrf/types";
import { BarChart } from "../../ui/BarChart";
import { type Column, DataTable } from "../../ui/DataTable";
import { LineChart } from "../../ui/LineChart";
import { SummaryCard, type SummaryCell } from "../../ui/SummaryCard";
import { useAppStore } from "../../store/useAppStore";
import { ClassCell, SkillCell } from "./cells";
import { effectiveMaxHp, hasCritData, monsterName, playerClass, playerLevel } from "./entityNames";
import { mobDpUrl, pct, resolveSkillName, skillDpUrl } from "./resolvers";

/** Latest player damage on `targetAid` at/ before `byTime` (killing-blow heuristic). */
function lastDamageBeforeFromPlayer(replay: Replay, targetAid: number, byTime: number) {
  let best: { source: number; time: number } | null = null;
  for (const ev of replay.damage) {
    if (ev.target !== targetAid || ev.time > byTime) continue;
    if (!isPlayerSource(replay, ev.source)) continue;
    if (!best || ev.time > best.time) best = { source: ev.source, time: ev.time };
  }
  return best;
}

export function MonsterOverview({ replay, mobAid }: { replay: Replay; mobAid: number }) {
  const db = useAppStore((s) => s.db);
  const ent = replay.entities.get(mobAid);
  if (!ent) return null;

  let totalReceived = 0;
  let totalDealt = 0;
  const attackers = new Set<number>();
  const victims = new Set<number>();
  const victimDamage = new Map<number, number>();
  for (const d of replay.damage) {
    if (d.target === mobAid) {
      totalReceived += d.damage;
      if (isPlayerSource(replay, d.source)) attackers.add(d.source);
    }
    if (d.source === mobAid && isPlayerSource(replay, d.target)) {
      totalDealt += d.damage;
      victims.add(d.target);
      victimDamage.set(d.target, (victimDamage.get(d.target) ?? 0) + d.damage);
    }
  }

  let topVictim: { name: string; total: number } | null = null;
  for (const [aid, total] of victimDamage) {
    if (!topVictim || total > topVictim.total) {
      topVictim = { name: replay.entities.get(aid)?.name || `#${aid}`, total };
    }
  }

  const kill = replay.kills.find((k) => k.aid === mobAid && k.kind === 1);
  const killTime = kill?.time ?? null;
  const timeAliveMs =
    killTime != null
      ? Math.max(0, killTime - ent.firstSeenMs)
      : Math.max(0, replay.sessionInfo.durationMs - ent.firstSeenMs);
  const ttkMs = killTime != null ? killTime - ent.firstSeenMs : null;

  let killerName: string | null = null;
  if (killTime != null) {
    const lastHit = lastDamageBeforeFromPlayer(replay, mobAid, killTime);
    if (lastHit) killerName = replay.entities.get(lastHit.source)?.name || `#${lastHit.source}`;
  }

  const maxHp = effectiveMaxHp(db, ent.maxHp, ent.view);
  const speciesName = monsterName(replay, db, mobAid);

  const cells: SummaryCell[] = [
    {
      label: t.cellSpecies,
      value: speciesName,
      valueNode: ent.view ? (
        <>
          <a className="cell-link" href={mobDpUrl(ent.view)} target="_blank" rel="noopener noreferrer">
            #{ent.view}
          </a>{" "}
          · {speciesName}
        </>
      ) : undefined,
    },
    { label: t.colLevel, value: ent.level ? String(ent.level) : t.none },
    { label: t.cellMobMaxHp, value: maxHp > 0 ? fmt(maxHp) : t.none },
    { label: t.cellBoss, value: ent.isBoss ? t.bossMark : t.none },
    { label: t.cellTimeAlive, value: timeAliveMs ? formatDuration(timeAliveMs) : t.none },
    { label: t.cellMobTtk, value: ttkMs != null ? formatDuration(ttkMs) : t.none },
    { label: t.cellKilledBy, value: killerName ?? t.none },
    {
      label: t.cellMobDamageReceived,
      value: fmt(totalReceived),
      hint: maxHp > 0 ? `${pct(totalReceived, maxHp)}% do HP máx.` : undefined,
    },
    { label: t.cellMobAttackers, value: fmt(attackers.size) },
    { label: t.cellMobDamageDealt, value: fmt(totalDealt) },
    { label: t.cellMobVictims, value: fmt(victims.size) },
    {
      label: t.cellMobTopVictim,
      value: topVictim ? topVictim.name : t.none,
      hint: topVictim ? fmt(topVictim.total) : undefined,
    },
  ];

  return <SummaryCard title={t.mobOverviewTitle} cells={cells} />;
}

export function MobHpCurve({ replay, mobAid }: { replay: Replay; mobAid: number }) {
  const db = useAppStore((s) => s.db);
  const ent = replay.entities.get(mobAid);
  // Only show if the server reported HP at some point — otherwise the curve is a
  // misleading straight line from "full" to 0.
  const hasServerSamples = replay.mobHp.some((m) => m.aid === mobAid);
  const serverMaxHp = ent && ent.maxHp > 0 ? ent.maxHp : 0;
  if (!hasServerSamples && serverMaxHp <= 0) return null;

  const fallbackMax = ent ? effectiveMaxHp(db, ent.maxHp, ent.view) : 0;
  const series = mobHpCurve(replay, mobAid, fallbackMax);
  if (!series.ts.length) return null;
  const maxValues = series.maxHp.map((m) => (m > 0 ? m : fallbackMax));

  return (
    <div>
      <h2 className="section-title">{t.hpCurveTitle}</h2>
      <div className="stats-chart">
        <LineChart
          xs={series.ts}
          series={[
            { label: t.hpSeriesLabel, values: series.hp, paletteIndex: 6 },
            { label: t.hpMaxSeriesLabel, values: maxValues, paletteIndex: 7 },
          ]}
          height={220}
        />
      </div>
    </div>
  );
}

export function MobVictims({
  replay,
  mobAid,
  monsterLabel,
}: {
  replay: Replay;
  mobAid: number;
  monsterLabel: string;
}) {
  const db = useAppStore((s) => s.db);
  const victims = playersDamagedByMonster(replay, mobAid);
  if (!victims.length) {
    return (
      <section className="stats-card">
        <h2 className="section-title">{t.mobVictimsTitle(monsterLabel)}</h2>
        <p className="section-hint">{t.mobNeverAttackedHint}</p>
      </section>
    );
  }

  const crit = hasCritData(replay);
  const cols: Column<PlayerAgg>[] = [
    { key: "name", label: t.colPlayer },
    {
      key: "class",
      label: t.colClass,
      render: (r) => <ClassCell replay={replay} db={db} aid={r.aid} />,
      sortValue: (r) => playerClass(replay, db, r.aid),
    },
    {
      key: "level",
      label: t.colLevel,
      numeric: true,
      format: (r) => (playerLevel(replay, r.aid) ? String(playerLevel(replay, r.aid)) : t.none),
      sortValue: (r) => playerLevel(replay, r.aid),
    },
    { key: "totalDealt", label: t.colDamageTaken, numeric: true, format: (r) => fmt(r.totalDealt) },
    { key: "hits", label: t.colHits, numeric: true, format: (r) => fmt(r.hits) },
    ...(crit
      ? [{ key: "crits", label: t.colCrits, numeric: true, format: (r: PlayerAgg) => fmt(r.crits) } as Column<PlayerAgg>]
      : []),
    { key: "misses", label: t.colMisses, numeric: true, format: (r) => fmt(r.misses) },
    { key: "kills", label: t.colKillingBlow, numeric: true, format: (r) => fmt(r.kills) },
  ];

  return (
    <div>
      <h2 className="section-title">{t.mobVictimsTitle(monsterLabel)}</h2>
      <DataTable cols={cols} rows={victims} options={{ initialSort: { key: "totalDealt", asc: false } }} />
      <h2 className="section-title" style={{ marginTop: "1rem" }}>
        {t.mobVictimsBarTitle(monsterLabel)}
      </h2>
      <BarChart
        rows={victims.map((v) => ({ key: v.aid, label: v.name, value: v.totalDealt, display: fmt(v.totalDealt) }))}
      />
    </div>
  );
}

export function MobSkills({
  replay,
  mobAid,
  monsterLabel,
}: {
  replay: Replay;
  mobAid: number;
  monsterLabel: string;
}) {
  const db = useAppStore((s) => s.db);
  const selectedTarget = useAppStore((s) => s.selectedMobSkillTarget);
  const setTarget = useAppStore((s) => s.setSelectedMobSkillTarget);

  const victims = playersDamagedByMonster(replay, mobAid);
  const validTargetAids = new Set(victims.map((v) => v.aid));
  // Ignore a stale filter (e.g. target isn't a victim of this mob).
  const effectiveTarget =
    selectedTarget != null && validTargetAids.has(selectedTarget) ? selectedTarget : null;

  const rows = mobSkillBreakdown(replay, mobAid, (id) => resolveSkillName(db, id), effectiveTarget ?? undefined);

  if (!rows.length && !victims.length) {
    return (
      <section className="stats-card">
        <h2 className="section-title">{t.mobSkillsTitle(monsterLabel)}</h2>
        <p className="section-hint">{t.mobNoSkillsHint}</p>
      </section>
    );
  }

  const cols: Column<MobSkillAgg>[] = [
    {
      key: "skillId",
      label: t.colId,
      format: (r) => (r.skillId ? String(r.skillId) : t.none),
      href: (r) => (r.skillId ? skillDpUrl(r.skillId) : null),
    },
    {
      key: "name",
      label: t.colSkill,
      render: (r) => <SkillCell skillId={r.skillId} name={r.name} />,
      sortValue: (r) => r.name,
    },
    { key: "hits", label: t.colHits, numeric: true, format: (r) => fmt(r.hits) },
    { key: "totalDamage", label: t.colTotalDamage, numeric: true, format: (r) => fmt(r.totalDamage) },
    { key: "avgDamage", label: t.colAvgDamage, numeric: true, format: (r) => fmt(r.avgDamage) },
    { key: "noDamageUses", label: t.colNoDamageUses, numeric: true, format: (r) => fmt(r.noDamageUses) },
    { key: "distinctTargets", label: t.colDistinctTargets, numeric: true, format: (r) => fmt(r.distinctTargets) },
    {
      key: "avgCastMs",
      label: t.colAvgCast,
      numeric: true,
      format: (r) => (r.avgCastMs == null ? t.none : `${r.avgCastMs} ms`),
      sortValue: (r) => r.avgCastMs ?? -1,
    },
  ];

  return (
    <div>
      <h2 className="section-title">{t.mobSkillsTitle(monsterLabel)}</h2>
      <p className="section-hint">{t.mobSkillsHint}</p>
      <div className="mob-skills-filter">
        <label htmlFor="mob-skills-target">{t.mobSkillsFilterLabel}</label>
        <select
          id="mob-skills-target"
          value={effectiveTarget ?? ""}
          onChange={(e) => setTarget(e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">{t.mobSkillsFilterAll}</option>
          {victims.map((v) => (
            <option key={v.aid} value={v.aid}>
              {v.name}
            </option>
          ))}
        </select>
      </div>
      {rows.length ? (
        <DataTable cols={cols} rows={rows} options={{ initialSort: { key: "totalDamage", asc: false } }} />
      ) : (
        <p className="section-hint">{t.mobSkillsNoneForTarget}</p>
      )}
    </div>
  );
}
