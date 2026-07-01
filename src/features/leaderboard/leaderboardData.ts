import type { ReplayListItem } from "../../firebase";
import { locale } from "../../i18n";

export type MvpOption = { view: number; name: string };

export type LeaderboardRow = {
  rank: number;
  playerName: string;
  /** Player class — possibly empty for homun/merc or legacy docs. */
  className: string;
  highestHit: number;
  dps: number;
  replayId: string;
  recordedAt: Date | null;
};

/**
 * Distinct MVP species across all records, labelled by their best name.
 *
 * `resolveName` (the live monster DB) wins when it knows the view, because the
 * `name` frozen into each record at upload time can be a stale English / Korean
 * / `[PH]` fallback from an older name source. We fall back to the dominant
 * stored name, then `mob#<view>`.
 */
export function collectMvpOptions(
  items: ReplayListItem[],
  resolveName?: ((view: number) => string) | null,
): MvpOption[] {
  const byView = new Map<number, Map<string, number>>();
  for (const it of items) {
    for (const r of it.mvpRecords) {
      let names = byView.get(r.view);
      if (!names) {
        names = new Map();
        byView.set(r.view, names);
      }
      names.set(r.name, (names.get(r.name) ?? 0) + 1);
    }
  }
  const out: MvpOption[] = [];
  for (const [view, names] of byView) {
    let topName = resolveName ? resolveName(view) : `mob#${view}`;
    // `resolveName` returns `mob#<id>` for ids the DB doesn't know — in that
    // case prefer the dominant stored name before giving up. Skip empties and
    // `[PH] Monster Name` placeholders (an unreleased-mob stub the old source
    // served): those are never a real name, so `mob#<view>` is more honest.
    if (!topName || topName.startsWith("mob#")) {
      let best = `mob#${view}`;
      let topCount = -1;
      for (const [n, c] of names) {
        if (n && !n.startsWith("[PH]") && c > topCount) {
          best = n;
          topCount = c;
        }
      }
      topName = best;
    }
    out.push({ view, name: topName });
  }
  // Names starting with a Unicode letter sort first; brackets/hashes/digits
  // get shoved to the bottom so natural-looking MVP names dominate.
  out.sort((a, b) => {
    const aSpecial = !/^\p{L}/u.test(a.name);
    const bSpecial = !/^\p{L}/u.test(b.name);
    if (aSpecial !== bSpecial) return aSpecial ? 1 : -1;
    return a.name.localeCompare(b.name, locale);
  });
  return out;
}

/** One row per (replay, player) performance against the given MVP species. */
export function collectRowsForView(
  items: ReplayListItem[],
  view: number,
  classFilter: string | null,
): LeaderboardRow[] {
  const rows: LeaderboardRow[] = [];
  for (const it of items) {
    for (const r of it.mvpRecords) {
      if (r.view !== view) continue;
      const rc = r.class ?? "";
      if (classFilter !== null && rc !== classFilter) continue;
      rows.push({
        rank: 0,
        playerName: r.playerName,
        className: rc,
        highestHit: r.highestHit,
        dps: r.dps,
        replayId: it.id,
        recordedAt: it.recordedAt,
      });
    }
  }
  return rows;
}

export function topN(
  rows: LeaderboardRow[],
  metric: "highestHit" | "dps",
  n: number,
): LeaderboardRow[] {
  return [...rows]
    .sort((a, b) => b[metric] - a[metric])
    .slice(0, n)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

/** Whether any record has an empty class — gates the "(Sem classe)" bucket. */
export function anyClasslessRecord(items: ReplayListItem[]): boolean {
  for (const it of items) {
    for (const r of it.mvpRecords) {
      if (!r.class) return true;
    }
  }
  return false;
}
