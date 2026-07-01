import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { locale, t } from "../../i18n";
import { type Column, DataTable } from "../../ui/DataTable";
import { useReplaySummaries } from "../../hooks/useReplaySummaries";
import { useAppStore } from "../../store/useAppStore";
import { ensureMonsterNames } from "../../names";
import { type ComboboxItem, Combobox } from "./Combobox";
import {
  anyClasslessRecord,
  collectMvpOptions,
  collectRowsForView,
  type LeaderboardRow,
  topN,
} from "./leaderboardData";

const CLASS_ALL = "__all__";
const CLASS_UNKNOWN = "__unknown__";

function MetricTable({ rows, metric }: { rows: LeaderboardRow[]; metric: "highestHit" | "dps" }) {
  const navigate = useNavigate();
  if (!rows.length) {
    return <p className="muted small leaderboard-card-empty">{t.leaderboardEmptyForMvp}</p>;
  }
  const cols: Column<LeaderboardRow>[] = [
    { key: "rank", label: t.leaderboardColRank, numeric: true, format: (r) => String(r.rank), sortValue: (r) => r.rank },
    { key: "playerName", label: t.leaderboardColPlayer, format: (r) => r.playerName },
    {
      key: "value",
      label: metric === "highestHit" ? t.leaderboardColHighestHit : t.leaderboardColDps,
      numeric: true,
      format: (r) => (metric === "highestHit" ? r.highestHit : r.dps).toLocaleString(locale),
      sortValue: (r) => (metric === "highestHit" ? r.highestHit : r.dps),
    },
    {
      key: "recordedAt",
      label: t.leaderboardColDate,
      format: (r) => (r.recordedAt ? r.recordedAt.toLocaleDateString(locale) : "—"),
      sortValue: (r) => r.recordedAt?.getTime() ?? 0,
    },
    {
      key: "action",
      label: t.leaderboardColAction,
      render: (r) => (
        <a
          className="cell-link leaderboard-view-link"
          // Real href so Ctrl/Cmd/middle-click open in a new tab natively.
          href={`/?r=${r.replayId}`}
          onClick={(e) => {
            if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            navigate(`/?r=${r.replayId}`);
          }}
        >
          {t.leaderboardViewReplay}
        </a>
      ),
    },
  ];
  return <DataTable cols={cols} rows={rows} options={{ initialSort: { key: "rank", asc: true } }} />;
}

/** Cross-replay MVP leaderboard: top-5 by highest hit + top-5 by DPS. */
export function Leaderboard() {
  const { items, loading, error } = useReplaySummaries();
  const db = useAppStore((s) => s.db);
  const namesVersion = useAppStore((s) => s.namesVersion);
  const bumpNames = useAppStore((s) => s.bumpNames);
  const [selectedView, setSelectedView] = useState<number | null>(null);
  // null = all classes; "" = the "(Sem classe)" bucket; else an exact class.
  const [selectedClass, setSelectedClass] = useState<string | null>(null);

  // The leaderboard resolves MVP names from the live monster DB, but never
  // opens a replay (which is what normally triggers the name-map load), so
  // pull the monster map in directly and re-resolve once it lands.
  useEffect(() => {
    let cancelled = false;
    void ensureMonsterNames().then(() => {
      if (!cancelled) bumpNames();
    });
    return () => {
      cancelled = true;
    };
  }, [bumpNames]);

  // Prefer current DB names over the (possibly stale) names frozen into each
  // record at upload time. `namesVersion` bumps when the map loads → re-resolve.
  const mvpOptions = useMemo(
    () => collectMvpOptions(items, db ? (v: number) => db.resolveMob(v) : null),
    [items, db, namesVersion],
  );

  // Default-select the first MVP option once data lands.
  useEffect(() => {
    if (selectedView == null && mvpOptions.length) setSelectedView(mvpOptions[0].view);
  }, [mvpOptions, selectedView]);

  const mvpItems: ComboboxItem[] = mvpOptions.map((o) => ({ value: String(o.view), label: o.name }));

  const classItems: ComboboxItem[] = useMemo(() => {
    const its: ComboboxItem[] = [{ value: CLASS_ALL, label: t.leaderboardClassAll }];
    for (const name of db?.pcClassNames() ?? []) {
      const iconId = db?.pcClassIconId(name);
      its.push({ value: name, label: name, iconSrc: iconId != null ? `./icons/job/${iconId}.png` : undefined });
    }
    if (anyClasslessRecord(items)) its.push({ value: CLASS_UNKNOWN, label: t.leaderboardClassUnknown });
    return its;
  }, [db, items]);

  const classSelectedValue =
    selectedClass === null ? CLASS_ALL : selectedClass === "" ? CLASS_UNKNOWN : selectedClass;

  const hint = error
    ? t.leaderboardError(error)
    : loading && !items.length
      ? t.leaderboardLoading
      : !mvpOptions.length
        ? t.leaderboardEmpty
        : t.leaderboardHint;

  const allRows = selectedView != null ? collectRowsForView(items, selectedView, selectedClass) : [];
  const showTables = selectedView != null && mvpOptions.length > 0;

  return (
    <section id="leaderboard" className="leaderboard">
      <div className="leaderboard-header">
        <h2>{t.leaderboardTitle}</h2>
        {loading && <span className="recent-replays-loading-indicator" aria-hidden="true" />}
      </div>
      <p className="muted small">{hint}</p>
      <div className="leaderboard-controls">
        <label className="leaderboard-control" htmlFor="leaderboard-mvp-input">
          <span className="leaderboard-control-label">{t.leaderboardMvpLabel}</span>
          <Combobox
            id="leaderboard-mvp-input"
            items={mvpItems}
            selectedValue={selectedView == null ? null : String(selectedView)}
            onSelect={(it) => {
              const v = parseInt(it.value, 10);
              if (Number.isFinite(v)) setSelectedView(v);
            }}
          />
        </label>
        <label className="leaderboard-control" htmlFor="leaderboard-class-input">
          <span className="leaderboard-control-label">{t.leaderboardClassLabel}</span>
          <Combobox
            id="leaderboard-class-input"
            items={classItems}
            selectedValue={classSelectedValue}
            onSelect={(it) => {
              if (it.value === CLASS_ALL) setSelectedClass(null);
              else if (it.value === CLASS_UNKNOWN) setSelectedClass("");
              else setSelectedClass(it.value);
            }}
          />
        </label>
      </div>
      <div className="leaderboard-grid">
        <div className="leaderboard-card">
          <h3>{t.leaderboardTopDamage}</h3>
          {showTables && <MetricTable rows={topN(allRows, "highestHit", 5)} metric="highestHit" />}
        </div>
        <div className="leaderboard-card">
          <h3>{t.leaderboardTopDps}</h3>
          {showTables && <MetricTable rows={topN(allRows, "dps", 5)} metric="dps" />}
        </div>
      </div>
    </section>
  );
}
