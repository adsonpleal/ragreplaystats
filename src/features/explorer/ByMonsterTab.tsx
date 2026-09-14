import {
  damageTimelineMulti,
  isAllySource,
  type MonsterAgg,
  monstersWhoTookDamage,
  type PlayerAgg,
  playersThatDamaged,
} from "../../aggregate/index";
import { t } from "../../i18n";
import { fmt } from "../../lib/format";
import type { DamageEvent, Replay } from "rrfparser";
import { BarChart } from "../../ui/BarChart";
import { DamageChart } from "../../ui/DamageChart";
import { type Column, DataTable } from "../../ui/DataTable";
import { useAppStore } from "../../store/useAppStore";
import { usePhaseStarts } from "../../store/selectors";
import { ClassCell } from "./cells";
import {
  effectiveMaxHp,
  formatMonsterRow,
  hasCritData,
  isSummonAid,
  monsterName,
  playerClass,
  playerLevel,
  playerName,
} from "./entityNames";
import { MobHpCurve, MobSkills, MobVictims, MonsterOverview } from "./MobDetail";
import { GroupPhasesToggle } from "./GroupPhasesToggle";
import { KillsChart, SkillUsesChart } from "./ModeCharts";
import { mobDpUrl } from "./resolvers";
import { SkillByPlayerTable } from "./SkillTables";
import { SummonsTable } from "./SummonsTable";

/** Damage-timeline bucket size scaled to the combat span. */
function pickBucketMs(events: DamageEvent[]): number {
  if (!events.length) return 1000;
  const span = events[events.length - 1].time - events[0].time;
  if (span <= 30_000) return 1_000;
  if (span <= 120_000) return 2_000;
  if (span <= 600_000) return 5_000;
  if (span <= 1_800_000) return 15_000;
  return 30_000;
}

function MonsterDetail({ replay, mobAid }: { replay: Replay; mobAid: number }) {
  const db = useAppStore((s) => s.db);
  const crit = hasCritData(replay);
  const monsterLabel = monsterName(replay, db, mobAid);
  const phaseStarts = usePhaseStarts(mobAid);

  const events = replay.damage.filter((d) => d.target === mobAid);
  const playerEvents = events.filter((d) => isAllySource(replay, d.source));
  const allies = playersThatDamaged(replay, mobAid);
  const players = allies.filter((p) => !isSummonAid(replay, p.aid));
  const summons = allies.filter((p) => isSummonAid(replay, p.aid));

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
    { key: "kills", label: t.colKillingBlow, numeric: true, format: (r) => fmt(r.kills) },
  ];

  return (
    <>
      <MonsterOverview replay={replay} mobAid={mobAid} />
      <div>
        <h2 className="section-title">{t.playersWhoDamaged(monsterLabel)}</h2>
        <DataTable cols={playerCols} rows={players} options={{ initialSort: { key: "totalDealt", asc: false } }} />
      </div>
      {summons.length > 0 && (
        <div>
          <h2 className="section-title">{t.summonsWhoDamaged(monsterLabel)}</h2>
          <SummonsTable replay={replay} rows={summons} killsLabel={t.colKillingBlow} showMonstersHit={false} />
        </div>
      )}
      {events.length > 0 && (
        <div>
          <h2 className="section-title">{t.damageByPlayerTitle}</h2>
          <p className="section-hint">{t.damageByPlayerHint(monsterLabel)}</p>
          <BarChart
            rows={allies.map((p) => ({
              key: p.aid,
              label: playerName(replay, p.aid),
              value: p.totalDealt,
              display: fmt(p.totalDealt),
            }))}
          />
        </div>
      )}
      <div>
        <h2 className="section-title">{t.damageOverTimeMultiTitle}</h2>
        <DamageChart
          multi={damageTimelineMulti(replay, playerEvents, pickBucketMs(playerEvents))}
          phaseStartsMs={phaseStarts}
        />
      </div>
      <MobHpCurve replay={replay} mobAid={mobAid} />
    </>
  );
}

export function ByMonsterTab({ replay }: { replay: Replay }) {
  const db = useAppStore((s) => s.db);
  const selectedMonster = useAppStore((s) => s.selectedMonster);
  const selectMonster = useAppStore((s) => s.selectMonster);

  const monsters = monstersWhoTookDamage(replay);
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
    { key: "totalReceived", label: t.colDamageTaken, numeric: true, format: (r) => fmt(r.totalReceived) },
    { key: "hits", label: t.colHits, numeric: true, format: (r) => fmt(r.hits) },
    { key: "attackers", label: t.colAttackers, numeric: true, format: (r) => fmt(r.attackers) },
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

  const monsterLabel = selectedMonster != null ? monsterName(replay, db, selectedMonster) : "";

  return (
    <>
      <div>
        <div className="section-title-row">
          <h2 className="section-title">{t.monstersHeading}</h2>
          <GroupPhasesToggle />
        </div>
        <p className="section-hint">{t.monstersHint}</p>
        <DataTable
          cols={monsterCols}
          rows={monsters}
          options={{
            initialSort: { key: "totalReceived", asc: false },
            onRowClick: (row) => selectMonster(row.aid),
            isSelected: (row) => row.aid === selectedMonster,
          }}
        />
      </div>

      {selectedMonster != null && <MonsterDetail replay={replay} mobAid={selectedMonster} />}

      <KillsChart replay={replay} />

      {selectedMonster != null && (
        <>
          <SkillByPlayerTable
            replay={replay}
            events={replay.damage.filter((d) => d.target === selectedMonster && isAllySource(replay, d.source))}
            title={t.skillsAgainstMonster}
          />
          <MobVictims replay={replay} mobAid={selectedMonster} monsterLabel={monsterLabel} />
          <MobSkills replay={replay} mobAid={selectedMonster} monsterLabel={monsterLabel} />
        </>
      )}

      <SkillUsesChart replay={replay} />
    </>
  );
}
