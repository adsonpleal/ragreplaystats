import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { ReplayListItem } from "../../firebase";
import { locale, t } from "../../i18n";
import { fmt, formatDuration } from "../../lib/format";
import { useReplaySummaries } from "../../hooks/useReplaySummaries";

const RECENT_PAGE_SIZE = 10;

function RecentRow({ item, onOpen }: { item: ReplayListItem; onOpen: () => void }) {
  const cells: Array<{ label: string; value: string }> = [
    { label: t.player, value: item.player || t.none },
    { label: t.map, value: item.map || t.none },
    {
      label: t.recordedAt,
      value: item.recordedAt ? item.recordedAt.toLocaleString(locale) : t.none,
    },
    {
      label: t.duration,
      value:
        item.durationMs != null && item.durationMs > 0
          ? formatDuration(item.durationMs)
          : t.none,
    },
    { label: t.totalDamage, value: item.totalDamage != null ? fmt(item.totalDamage) : t.none },
    { label: t.kills, value: item.kills != null ? fmt(item.kills) : t.none },
    {
      label: t.colUploadedAt,
      value: item.uploadedAt ? item.uploadedAt.toLocaleString(locale) : t.none,
    },
  ];
  return (
    <button type="button" className="recent-replays-row" onClick={onOpen}>
      {cells.map((c, i) => (
        <div key={i}>
          <span className="recent-replays-cell-label">{c.label}</span>
          <span className="recent-replays-cell-value">{c.value}</span>
        </div>
      ))}
    </button>
  );
}

export function RecentReplays() {
  const { items, loading, error } = useReplaySummaries();
  const [, setSearchParams] = useSearchParams();
  const [playerFilter, setPlayerFilter] = useState("");
  const [mapFilter, setMapFilter] = useState("");
  const [pageIndex, setPageIndex] = useState(0);

  const hasAnyFilter = !!playerFilter.trim() || !!mapFilter.trim();

  const filtered = useMemo(() => {
    const p = playerFilter.trim().toLowerCase();
    const m = mapFilter.trim().toLowerCase();
    if (!p && !m) return items;
    return items.filter((it) => {
      if (p && !(it.player ?? "").toLowerCase().includes(p)) return false;
      if (m && !(it.map ?? "").toLowerCase().includes(m)) return false;
      return true;
    });
  }, [items, playerFilter, mapFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / RECENT_PAGE_SIZE));
  const safePage = Math.min(pageIndex, pageCount - 1);
  const page = filtered.slice(safePage * RECENT_PAGE_SIZE, safePage * RECENT_PAGE_SIZE + RECENT_PAGE_SIZE);

  let hint: string;
  if (error) hint = t.recentReplaysError(error);
  else if (!items.length && loading) hint = t.recentReplaysLoading;
  else if (!filtered.length) hint = hasAnyFilter ? t.recentReplaysNoMatch : t.recentReplaysEmpty;
  else hint = t.recentReplaysHint;

  const openReplay = (id: string) =>
    setSearchParams((prev) => {
      prev.set("r", id);
      return prev;
    });

  const showPagination =
    !error && !loading && (filtered.length > 0 || safePage > 0);

  return (
    <section id="recent-replays" className="recent-replays">
      <div className="recent-replays-header">
        <h2 id="recent-replays-title">{t.recentReplaysTitle}</h2>
        {loading && (
          <span className="recent-replays-loading-indicator" aria-hidden="true" />
        )}
      </div>
      <p className="muted small" id="recent-replays-hint">
        {hint}
      </p>
      <div className="recent-replays-filters">
        <label className="recent-replays-filter">
          <span className="recent-replays-filter-label">{t.recentReplaysFilterPlayer}</span>
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={playerFilter}
            onChange={(e) => {
              setPlayerFilter(e.target.value);
              setPageIndex(0);
            }}
          />
        </label>
        <label className="recent-replays-filter">
          <span className="recent-replays-filter-label">{t.recentReplaysFilterMap}</span>
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={mapFilter}
            onChange={(e) => {
              setMapFilter(e.target.value);
              setPageIndex(0);
            }}
          />
        </label>
        <button
          type="button"
          className="recent-replays-filter-clear"
          disabled={!hasAnyFilter}
          onClick={() => {
            setPlayerFilter("");
            setMapFilter("");
            setPageIndex(0);
          }}
        >
          {t.recentReplaysFilterClear}
        </button>
      </div>
      {!loading && !error && (
        <div id="recent-replays-list">
          {page.map((item) => (
            <RecentRow key={item.id} item={item} onOpen={() => openReplay(item.id)} />
          ))}
        </div>
      )}
      {showPagination && (
        <div className="recent-replays-pagination">
          <button
            type="button"
            disabled={safePage === 0}
            onClick={() => setPageIndex((i) => Math.max(0, i - 1))}
          >
            {t.paginationPrev}
          </button>
          <span className="recent-replays-page-indicator">
            {t.paginationPageOf(safePage + 1)}
          </span>
          <button
            type="button"
            disabled={safePage >= pageCount - 1}
            onClick={() => setPageIndex((i) => i + 1)}
          >
            {t.paginationNext}
          </button>
        </div>
      )}
    </section>
  );
}
