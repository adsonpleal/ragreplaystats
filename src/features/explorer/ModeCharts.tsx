import { killsByPlayerAndMob, skillUsageByPlayer } from "../../aggregate/index";
import { t } from "../../i18n";
import { fmt } from "../../lib/format";
import type { Replay } from "../../rrf/types";
import { BarChart, type BarLabelSegment, type BarRow } from "../../ui/BarChart";
import { useAppStore } from "../../store/useAppStore";
import { primarySelectedPlayer } from "../../store/selectors";
import { monsterName, playerName } from "./entityNames";
import { mobDpUrl, resolveSkillName, skillDpUrl } from "./resolvers";

const SKILL_USES_BAR_LIMIT = 30;
const KILLS_BAR_LIMIT = 30;

/** "Most-used skills" bar chart, scoped by the active player/monster selection. */
export function SkillUsesChart({ replay }: { replay: Replay }) {
  const db = useAppStore((s) => s.db);
  const selectedPlayers = useAppStore((s) => s.selectedPlayers);
  const selectedMonster = useAppStore((s) => s.selectedMonster);
  const primary = primarySelectedPlayer(selectedPlayers);

  const filter: { sourceAid?: number; targetAid?: number } = {};
  if (primary != null) filter.sourceAid = primary;
  if (selectedMonster != null) filter.targetAid = selectedMonster;

  const rows = skillUsageByPlayer(replay, filter, (id) => resolveSkillName(db, id));
  if (!rows.length) return null;

  const playerLabel = primary != null ? playerName(replay, primary) : null;
  const monsterLabel = selectedMonster != null ? monsterName(replay, db, selectedMonster) : null;

  let title: string;
  let hint: string | null = null;
  if (playerLabel && monsterLabel) title = t.skillUsesPlayerVsMonsterTitle(playerLabel, monsterLabel);
  else if (playerLabel) title = t.skillUsesPlayerTitle(playerLabel);
  else if (monsterLabel) title = t.skillUsesMonsterTitle(monsterLabel);
  else {
    title = t.skillUsesAllTitle;
    hint = t.skillUsesAllHint;
  }

  const showPlayerInLabel = playerLabel == null;
  const bars: BarRow[] = rows.slice(0, SKILL_USES_BAR_LIMIT).map((r) => {
    const idChip = r.skillId ? `#${r.skillId}` : "";
    const skillHref = r.skillId ? skillDpUrl(r.skillId) : undefined;
    const labelText = showPlayerInLabel
      ? `${r.playerName} · ${idChip ? `${idChip} · ` : ""}${r.skillName}`
      : `${idChip ? `${idChip} · ` : ""}${r.skillName}`;
    let labelSegments: BarLabelSegment[] | undefined;
    if (idChip) {
      labelSegments = showPlayerInLabel
        ? [{ text: `${r.playerName} · ` }, { text: idChip, href: skillHref }, { text: ` · ${r.skillName}` }]
        : [{ text: idChip, href: skillHref }, { text: ` · ${r.skillName}` }];
    }
    return {
      key: r.key,
      label: labelText,
      labelSegments,
      iconSrc: r.skillId ? `./icons/skill/${r.skillId}.png` : undefined,
      value: r.count,
      display: fmt(r.count),
    };
  });

  return (
    <div>
      <h2 className="section-title">{title}</h2>
      {hint && <p className="section-hint">{hint}</p>}
      <BarChart rows={bars} />
    </div>
  );
}

/** "Kills by player and monster type" bar chart, scoped by the active selection. */
export function KillsChart({ replay }: { replay: Replay }) {
  const db = useAppStore((s) => s.db);
  const selectedPlayers = useAppStore((s) => s.selectedPlayers);
  const selectedMonster = useAppStore((s) => s.selectedMonster);
  const primary = primarySelectedPlayer(selectedPlayers);

  const filter: { sourceAid?: number; targetView?: number } = {};
  if (primary != null) filter.sourceAid = primary;
  if (selectedMonster != null) {
    const ent = replay.entities.get(selectedMonster);
    if (ent?.view) filter.targetView = ent.view;
  }

  const rows = killsByPlayerAndMob(replay, filter, (id) => db?.resolveMob(id) ?? t.mobFallback(id));
  if (!rows.length) return null;

  const playerLabel = primary != null ? playerName(replay, primary) : null;
  const monsterLabel = selectedMonster != null ? monsterName(replay, db, selectedMonster) : null;

  let title: string;
  let hint: string | null = null;
  if (playerLabel && monsterLabel) title = t.killsPlayerVsMonsterTitle(playerLabel, monsterLabel);
  else if (playerLabel) title = t.killsByPlayerTitle(playerLabel);
  else if (monsterLabel) title = t.killsByMonsterTitle(monsterLabel);
  else {
    title = t.killsAllTitle;
    hint = t.killsAllHint;
  }

  const bars: BarRow[] = rows.slice(0, KILLS_BAR_LIMIT).map((r) => {
    const mobHref = r.monsterView ? mobDpUrl(r.monsterView) : undefined;
    const idChip = r.monsterView ? `#${r.monsterView}` : "";
    let label: string;
    let labelSegments: BarLabelSegment[] | undefined;
    if (playerLabel && monsterLabel) {
      label = `${r.playerName} · ${idChip}${idChip ? " " : ""}${r.monsterName}`;
      labelSegments = idChip
        ? [{ text: `${r.playerName} · ` }, { text: idChip, href: mobHref }, { text: ` · ${r.monsterName}` }]
        : [{ text: `${r.playerName} · ${r.monsterName}` }];
    } else if (playerLabel) {
      label = idChip ? `${idChip} · ${r.monsterName}` : r.monsterName;
      labelSegments = idChip
        ? [{ text: idChip, href: mobHref }, { text: ` · ${r.monsterName}` }]
        : [{ text: r.monsterName }];
    } else if (monsterLabel) {
      // Bar represents a player when the mob is fixed — no DP link.
      label = r.playerName;
    } else {
      label = idChip
        ? `${r.playerName} · ${idChip} · ${r.monsterName}`
        : `${r.playerName} · ${r.monsterName}`;
      labelSegments = idChip
        ? [{ text: `${r.playerName} · ` }, { text: idChip, href: mobHref }, { text: ` · ${r.monsterName}` }]
        : [{ text: `${r.playerName} · ${r.monsterName}` }];
    }
    return { key: r.key, label, labelSegments, value: r.count, display: fmt(r.count) };
  });

  return (
    <div>
      <h2 className="section-title">{title}</h2>
      {hint && <p className="section-hint">{hint}</p>}
      <BarChart rows={bars} />
    </div>
  );
}
