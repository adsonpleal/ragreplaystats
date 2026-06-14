import {
  type MonsterAgg,
  monstersDamagedByPlayer,
  type PlayerAgg,
  playersWhoDamaged,
} from "../../aggregate/index";
import { t } from "../../i18n";
import { fmt } from "../../lib/format";
import type { Replay } from "../../rrf/types";
import { type Column, DataTable } from "../../ui/DataTable";
import { DpsScatter } from "../../ui/DpsScatter";
import { useAppStore } from "../../store/useAppStore";
import { primarySelectedPlayer } from "../../store/selectors";
import { ClassCell } from "./cells";
import { effectiveMaxHp, formatMonsterRow, hasCritData, playerClass, playerLevel, playerName } from "./entityNames";
import { KillsChart, SkillUsesChart } from "./ModeCharts";
import { mobDpUrl, resolveSkillName } from "./resolvers";
import { SkillTable } from "./SkillTables";

/** Drag-select matchup timelines, one per selected player, locked to a shared scale. */
function MatchupTimelines({ replay, monsterAid }: { replay: Replay; monsterAid: number }) {
  const db = useAppStore((s) => s.db);
  const selectedPlayers = useAppStore((s) => s.selectedPlayers);
  const compareRange = useAppStore((s) => s.byPlayerCompareRange);
  const setCompareRange = useAppStore((s) => s.setByPlayerCompareRange);

  // Lock all cards to the same x + y scale so the comparison is honest.
  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMax = 0;
  for (const playerAid of selectedPlayers) {
    for (const d of replay.damage) {
      if (d.source !== playerAid || d.target !== monsterAid) continue;
      if (d.time < xMin) xMin = d.time;
      if (d.time > xMax) xMax = d.time;
      if (d.damage > yMax) yMax = d.damage;
    }
    for (const u of replay.skillUses) {
      if (u.source !== playerAid || u.target !== monsterAid) continue;
      if (u.time < xMin) xMin = u.time;
      if (u.time > xMax) xMax = u.time;
    }
  }
  const xRange = xMin <= xMax ? { startMs: xMin, endMs: xMax } : null;
  const yMaxOrNull = yMax > 0 ? yMax : null;

  return (
    <>
      {[...selectedPlayers].map((playerAid) => {
        const events = replay.damage.filter((d) => d.source === playerAid && d.target === monsterAid);
        if (!events.length) return null;
        const damage = events.map((d) => ({
          time: d.time,
          damage: d.damage,
          skillId: d.skillId,
          skillName: resolveSkillName(db, d.skillId),
        }));
        // Non-damage skill uses overlay as vertical markers (reuses the chat slot).
        const markers = replay.skillUses
          .filter((u) => u.source === playerAid && u.target === monsterAid)
          .map((u) => ({ time: u.time, message: resolveSkillName(db, u.skillId) }));
        return (
          <section className="matchup-card" key={playerAid}>
            <h2 className="section-title">{t.matchupTimelineCardTitle(playerName(replay, playerAid))}</h2>
            <DpsScatter
              data={{ damage, chat: markers }}
              range={compareRange}
              onSelect={setCompareRange}
              xRangeMs={xRange}
              yMax={yMaxOrNull}
            />
          </section>
        );
      })}
    </>
  );
}

function MatchupSkillTables({ replay, monsterAid }: { replay: Replay; monsterAid: number }) {
  const selectedPlayers = useAppStore((s) => s.selectedPlayers);
  return (
    <>
      {[...selectedPlayers].map((playerAid) => {
        const events = replay.damage.filter((d) => d.source === playerAid && d.target === monsterAid);
        if (!events.length) return null;
        return (
          <SkillTable
            key={playerAid}
            replay={replay}
            events={events}
            title={t.matchupSkillsCardTitle(playerName(replay, playerAid))}
          />
        );
      })}
    </>
  );
}

export function ByPlayerTab({ replay }: { replay: Replay }) {
  const db = useAppStore((s) => s.db);
  const selectedPlayers = useAppStore((s) => s.selectedPlayers);
  const selectedMonster = useAppStore((s) => s.selectedMonster);
  const togglePlayer = useAppStore((s) => s.togglePlayer);
  const selectMonster = useAppStore((s) => s.selectMonster);
  const setCompareRange = useAppStore((s) => s.setByPlayerCompareRange);
  const primary = primarySelectedPlayer(selectedPlayers);
  const crit = hasCritData(replay);

  const players = playersWhoDamaged(replay);
  const playerCols: Column<PlayerAgg>[] = [
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
    { key: "totalDealt", label: t.colDamageDealt, numeric: true, format: (r) => fmt(r.totalDealt) },
    { key: "hits", label: t.colHits, numeric: true, format: (r) => fmt(r.hits) },
    ...(crit
      ? [{ key: "crits", label: t.colCrits, numeric: true, format: (r: PlayerAgg) => fmt(r.crits) } as Column<PlayerAgg>]
      : []),
    { key: "misses", label: t.colMisses, numeric: true, format: (r) => fmt(r.misses) },
    { key: "monstersHit", label: t.colMonstersHit, numeric: true, format: (r) => fmt(r.monstersHit) },
    { key: "kills", label: t.colKills, numeric: true, format: (r) => fmt(r.kills) },
  ];

  const monsters = primary != null ? monstersDamagedByPlayer(replay, primary) : [];
  const monsterCols: Column<MonsterAgg>[] = [
    {
      key: "view",
      label: t.colMobId,
      format: (r) => (r.view ? String(r.view) : t.none),
      href: (r) => (r.view ? mobDpUrl(r.view) : null),
    },
    {
      key: "name",
      label: t.colMonster,
      format: (r) => formatMonsterRow(replay, db, r),
      sortValue: (r) => formatMonsterRow(replay, db, r),
    },
    { key: "totalReceived", label: t.colDamage, numeric: true, format: (r) => fmt(r.totalReceived) },
    { key: "hits", label: t.colHits, numeric: true, format: (r) => fmt(r.hits) },
    {
      key: "maxHp",
      label: t.colMaxHp,
      numeric: true,
      format: (r) => (effectiveMaxHp(db, r.maxHp, r.view) > 0 ? fmt(effectiveMaxHp(db, r.maxHp, r.view)) : t.none),
      sortValue: (r) => effectiveMaxHp(db, r.maxHp, r.view),
    },
    {
      key: "ttkMs",
      label: t.colTtk,
      numeric: true,
      format: (r) => (r.ttkMs == null ? t.none : `${(r.ttkMs / 1000).toFixed(1)} s`),
      sortValue: (r) => r.ttkMs ?? Number.POSITIVE_INFINITY,
    },
  ];

  return (
    <>
      <div>
        <h2 className="section-title">{t.playersHeading}</h2>
        <p className="section-hint">{t.playersHint}</p>
        <DataTable
          cols={playerCols}
          rows={players}
          options={{
            initialSort: { key: "totalDealt", asc: false },
            onRowClick: (row) => togglePlayer(row.aid),
            isSelected: (row) => selectedPlayers.has(row.aid),
          }}
        />
      </div>

      {primary != null && (
        <div>
          <h2 className="section-title">{t.monstersDamagedBy(playerName(replay, primary))}</h2>
          <p className="section-hint">{t.monstersDamagedByHint}</p>
          <DataTable
            cols={monsterCols}
            rows={monsters}
            options={{
              initialSort: { key: "totalReceived", asc: false },
              onRowClick: (row) => {
                if (selectedMonster !== row.aid) setCompareRange(null);
                selectMonster(row.aid);
              },
              isSelected: (row) => row.aid === selectedMonster,
            }}
          />
        </div>
      )}

      {primary != null && selectedMonster != null && (
        <MatchupTimelines replay={replay} monsterAid={selectedMonster} />
      )}

      <KillsChart replay={replay} />

      {primary != null && selectedMonster != null && (
        <MatchupSkillTables replay={replay} monsterAid={selectedMonster} />
      )}

      <SkillUsesChart replay={replay} />
    </>
  );
}
