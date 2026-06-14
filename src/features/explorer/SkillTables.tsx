import { bySkill, bySkillAndPlayer } from "../../aggregate/index";
import { t } from "../../i18n";
import { fmt } from "../../lib/format";
import type { DamageEvent, Replay } from "../../rrf/types";
import { type Column, DataTable } from "../../ui/DataTable";
import { useAppStore } from "../../store/useAppStore";
import { ClassCell, SkillCell } from "./cells";
import { playerClass } from "./entityNames";
import { resolveSkillName, skillDpUrl } from "./resolvers";

type SkillRow = ReturnType<typeof bySkill>[number];
type SkillByPlayerRow = ReturnType<typeof bySkillAndPlayer>[number];

/** Per-skill breakdown for a set of damage events (one card per matchup). */
export function SkillTable({
  replay,
  events,
  title,
}: {
  replay: Replay;
  events: DamageEvent[];
  title: string;
}) {
  const db = useAppStore((s) => s.db);
  if (!events.length) return null;
  const rows = bySkill(events, replay.skillCasts, (id) => resolveSkillName(db, id));
  const cols: Column<SkillRow>[] = [
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
    { key: "count", label: t.colHits, numeric: true, format: (r) => fmt(r.count) },
    { key: "totalDamage", label: t.colTotalDamage, numeric: true, format: (r) => fmt(r.totalDamage) },
    { key: "avgDamage", label: t.colAvgDamage, numeric: true, format: (r) => fmt(r.avgDamage) },
    { key: "multiHitAvg", label: t.colMultiHit, numeric: true, format: (r) => r.multiHitAvg.toFixed(2) },
    {
      key: "avgCastMs",
      label: t.colAvgCast,
      numeric: true,
      format: (r) => (r.avgCastMs == null ? t.none : `${r.avgCastMs} ms`),
      sortValue: (r) => r.avgCastMs ?? -1,
    },
  ];
  return (
    <section className="matchup-card">
      <h2 className="section-title">{title}</h2>
      <DataTable cols={cols} rows={rows} options={{ initialSort: { key: "totalDamage", asc: false } }} />
    </section>
  );
}

/** Per-skill-and-player breakdown (by-monster tab "skills against this mob"). */
export function SkillByPlayerTable({
  replay,
  events,
  title,
}: {
  replay: Replay;
  events: DamageEvent[];
  title: string;
}) {
  const db = useAppStore((s) => s.db);
  if (!events.length) return null;
  const rows = bySkillAndPlayer(replay, events, (id) => resolveSkillName(db, id));
  const cols: Column<SkillByPlayerRow>[] = [
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
    { key: "playerName", label: t.colPlayer },
    {
      key: "class",
      label: t.colClass,
      render: (r) => <ClassCell replay={replay} db={db} aid={r.playerAid} />,
      sortValue: (r) => playerClass(replay, db, r.playerAid),
    },
    { key: "count", label: t.colHits, numeric: true, format: (r) => fmt(r.count) },
    { key: "totalDamage", label: t.colTotalDamage, numeric: true, format: (r) => fmt(r.totalDamage) },
    { key: "avgDamage", label: t.colAvgDamage, numeric: true, format: (r) => fmt(r.avgDamage) },
    { key: "multiHitAvg", label: t.colMultiHit, numeric: true, format: (r) => r.multiHitAvg.toFixed(2) },
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
      <h2 className="section-title">{title}</h2>
      <DataTable cols={cols} rows={rows} options={{ initialSort: { key: "totalDamage", asc: false } }} />
    </div>
  );
}
