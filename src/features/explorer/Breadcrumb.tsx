import { Fragment } from "react";
import { t } from "../../i18n";
import type { Replay } from "../../rrf/types";
import { useAppStore } from "../../store/useAppStore";
import { monsterName, playerName } from "./entityNames";

type Crumb = { label: string; value: string; clear: () => void };

/** Drill-down chips for the by-player / by-monster tabs. Hidden when empty. */
export function Breadcrumb({ replay }: { replay: Replay }) {
  const mode = useAppStore((s) => s.mode);
  const db = useAppStore((s) => s.db);
  const selectedPlayers = useAppStore((s) => s.selectedPlayers);
  const selectedMonster = useAppStore((s) => s.selectedMonster);
  const setSelectedPlayers = useAppStore((s) => s.setSelectedPlayers);
  const selectMonster = useAppStore((s) => s.selectMonster);

  const crumbs: Crumb[] = [];
  if (mode === "byPlayer") {
    for (const aid of selectedPlayers) {
      crumbs.push({
        label: t.crumbPlayer,
        value: playerName(replay, aid),
        clear: () => {
          const next = new Set(selectedPlayers);
          next.delete(aid);
          setSelectedPlayers(next);
          // Removing the last player leaves nothing to drill into.
          if (next.size === 0) selectMonster(null);
        },
      });
    }
  }
  if (selectedMonster !== null) {
    crumbs.push({
      label: t.crumbMonster,
      value: monsterName(replay, db, selectedMonster),
      clear: () => selectMonster(null),
    });
  }

  if (!crumbs.length) return null;

  return (
    <nav id="breadcrumb" className="breadcrumb">
      {crumbs.map((c, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="arrow">›</span>}
          <span className="crumb">
            <span className="label">{c.label}</span>
            <span>{c.value}</span>
            <button type="button" title={t.clear} onClick={c.clear}>
              ✕
            </button>
          </span>
        </Fragment>
      ))}
    </nav>
  );
}
