// Cross-replay MVP damage leaderboard. Bulk-fetches replay summaries via the
// existing `listRecentReplays` REST projection (no bytes blob) and aggregates
// the per-(player, MVP species) records denormalized at upload time.
//
// State lives in this module rather than the central `state` object — the
// leaderboard is its own page route and shares no live state with the rest
// of the app aside from "what replay to open when a row is clicked," which
// is wired via the `setupLeaderboard` callback.

import { type ReplayListItem } from "./firebase.js";
import { t, locale } from "./i18n.js";
import {
  ensureLoaded as ensureSummariesLoaded,
  getCached as getCachedSummaries,
  isFresh as isSummariesCacheFresh,
} from "./replay-summaries.js";
import { renderTable } from "./ui/table.js";

type State = {
  items: ReplayListItem[];
  loading: boolean;
  error: string | null;
  /** Currently selected MVP species (view id). Null = empty leaderboard. */
  selectedView: number | null;
  /**
   * Class filter. `null` = all classes, `""` = the "(Sem classe)" bucket
   * (rows where the aggregator couldn't resolve a job name — homunculus,
   * mercenary, or legacy docs without the class field), any non-empty
   * string = exact match against `MvpRecord.class`.
   */
  selectedClass: string | null;
};

const state: State = {
  items: [],
  loading: false,
  error: null,
  selectedView: null,
  selectedClass: null,
};

/** Filter dropdown value used to represent the unresolved-class bucket. */
const CLASS_UNKNOWN_VALUE = "__unknown__";
/** Filter dropdown value used for "all classes". */
const CLASS_ALL_VALUE = "__all__";

let openReplay: (id: string) => void = () => {};

// Combobox state — local UI state, not shared with the leaderboard logic.
// `comboQuery` is the live text the user has typed (drives the filter);
// `comboOpen` controls suggestion-panel visibility; `comboActive` is the
// keyboard-highlighted index inside the currently-filtered list.
let comboQuery = "";
let comboOpen = false;
let comboActive = 0;

export function setupLeaderboard(onOpenReplay: (id: string) => void) {
  openReplay = onOpenReplay;
  const input = document.querySelector<HTMLInputElement>(
    "#leaderboard-mvp-input",
  );
  const panel = document.querySelector<HTMLUListElement>(
    "#leaderboard-mvp-options",
  );
  if (!input || !panel) return;

  input.addEventListener("focus", () => {
    comboQuery = "";
    comboActive = 0;
    comboOpen = true;
    input.select();
    paintMvpCombobox();
  });

  input.addEventListener("input", () => {
    comboQuery = input.value;
    comboActive = 0;
    comboOpen = true;
    paintMvpCombobox();
  });

  input.addEventListener("keydown", (e) => {
    const matches = filterMvpOptions();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      comboOpen = true;
      comboActive = Math.min(matches.length - 1, comboActive + 1);
      paintMvpCombobox();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      comboActive = Math.max(0, comboActive - 1);
      paintMvpCombobox();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = matches[comboActive];
      if (pick) selectMvp(pick);
    } else if (e.key === "Escape") {
      closeCombobox();
    }
  });

  // Delay close so a click on a suggestion item is captured first — the
  // blur fires before the click handler if we close synchronously.
  input.addEventListener("blur", () => {
    window.setTimeout(closeCombobox, 120);
  });

  const classSel = document.querySelector<HTMLSelectElement>(
    "#leaderboard-class-select",
  );
  classSel?.addEventListener("change", () => {
    const v = classSel.value;
    if (v === CLASS_ALL_VALUE) state.selectedClass = null;
    else if (v === CLASS_UNKNOWN_VALUE) state.selectedClass = "";
    else state.selectedClass = v;
    paint();
  });
}

function filterMvpOptions(): MvpOption[] {
  const all = collectMvpOptions(state.items);
  const q = comboQuery.trim().toLowerCase();
  if (!q) return all;
  return all.filter((o) => o.name.toLowerCase().includes(q));
}

function selectMvp(o: MvpOption) {
  state.selectedView = o.view;
  const input = document.querySelector<HTMLInputElement>(
    "#leaderboard-mvp-input",
  );
  if (input) input.value = o.name;
  closeCombobox();
  paint();
}

function closeCombobox() {
  comboOpen = false;
  comboQuery = "";
  paintMvpCombobox();
}

function paintMvpCombobox() {
  const input = document.querySelector<HTMLInputElement>(
    "#leaderboard-mvp-input",
  );
  const panel = document.querySelector<HTMLUListElement>(
    "#leaderboard-mvp-options",
  );
  if (!input || !panel) return;
  const matches = filterMvpOptions();
  // Clamp the keyboard cursor in case the filter shrank the list.
  if (comboActive >= matches.length) comboActive = Math.max(0, matches.length - 1);

  input.setAttribute("aria-expanded", String(comboOpen && matches.length > 0));

  panel.innerHTML = "";
  if (!comboOpen || matches.length === 0) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  matches.forEach((o, i) => {
    const li = document.createElement("li");
    li.role = "option";
    li.className =
      "leaderboard-mvp-option" + (i === comboActive ? " is-active" : "");
    li.dataset.view = String(o.view);
    li.textContent = o.name;
    if (state.selectedView === o.view) li.setAttribute("aria-selected", "true");
    // mousedown rather than click so we beat the input's blur handler.
    li.addEventListener("mousedown", (e) => {
      e.preventDefault();
      selectMvp(o);
    });
    panel.appendChild(li);
  });
}

export async function loadLeaderboard() {
  if (state.loading) return;
  // Cache-aware: if home view (or a previous leaderboard visit) already
  // pulled fresh summaries, paint instantly with no network call.
  if (isSummariesCacheFresh()) {
    state.items = getCachedSummaries();
    state.error = null;
    if (state.selectedView == null) {
      const opts = collectMvpOptions(state.items);
      state.selectedView = opts[0]?.view ?? null;
    }
    paint();
    return;
  }
  state.loading = true;
  state.error = null;
  paint();
  try {
    state.items = await ensureSummariesLoaded();
    // Default-select the first MVP option once data lands. We pick the most
    // commonly-occurring name per view id so unicode oddities and one-off
    // server labels don't beat the canonical DB name.
    if (state.selectedView == null) {
      const opts = collectMvpOptions(state.items);
      state.selectedView = opts[0]?.view ?? null;
    }
  } catch (err) {
    console.error(err);
    state.error = (err as Error).message;
  } finally {
    state.loading = false;
    paint();
  }
}

type MvpOption = { view: number; name: string };

function collectMvpOptions(items: ReplayListItem[]): MvpOption[] {
  // Per view, count occurrences of each name to pick the dominant label.
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
    let topName = `mob#${view}`;
    let topCount = -1;
    for (const [n, c] of names) {
      if (c > topCount && n) {
        topName = n;
        topCount = c;
      }
    }
    out.push({ view, name: topName });
  }
  // Names starting with a Unicode letter sort first (regular alphabetical
  // order, locale-aware). Anything else (brackets like "[PH]", hashes,
  // digits, symbols) gets shoved to the bottom so the natural-looking MVP
  // names dominate the list.
  out.sort((a, b) => {
    const aSpecial = !/^\p{L}/u.test(a.name);
    const bSpecial = !/^\p{L}/u.test(b.name);
    if (aSpecial !== bSpecial) return aSpecial ? 1 : -1;
    return a.name.localeCompare(b.name, locale);
  });
  return out;
}

type LeaderboardRow = {
  rank: number;
  playerName: string;
  /** Player class — possibly empty for homun/merc or legacy docs. */
  className: string;
  /** Biggest single damage event (one cast / one auto-attack). */
  highestHit: number;
  dps: number;
  replayId: string;
  recordedAt: Date | null;
};

/**
 * Each row is one (replay, player) performance against the MVP. Note that
 * we don't dedupe by player identity across replays — two uploads of "Bob"
 * are two independent rows, and one player who renamed across recordings
 * would split into two. Acceptable for v1: this is "top performances," not
 * "top unique players." Revisit if/when uploader-side identity arrives.
 *
 * When `classFilter` is non-null, only rows whose `r.class` matches it are
 * included. Empty string matches the "(Sem classe)" bucket.
 */
function collectRowsForView(
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

function topN(
  rows: LeaderboardRow[],
  metric: "highestHit" | "dps",
  n: number,
): LeaderboardRow[] {
  const sorted = [...rows].sort((a, b) => b[metric] - a[metric]).slice(0, n);
  return sorted.map((r, i) => ({ ...r, rank: i + 1 }));
}

function paint() {
  // Hint + spinner. The hint is just informational text; we use the empty
  // option list (rather than items.length) as the "really nothing here"
  // signal because legacy docs without `mvpRecords` aren't worth flagging.
  const hintEl = document.querySelector<HTMLElement>("#leaderboard-hint");
  const spinnerEl = document.querySelector<HTMLElement>(
    "#leaderboard-loading-indicator",
  );
  if (spinnerEl) spinnerEl.hidden = !state.loading;

  const options = collectMvpOptions(state.items);

  if (hintEl) {
    if (state.error) hintEl.textContent = t.leaderboardError(state.error);
    else if (state.loading && !state.items.length)
      hintEl.textContent = t.leaderboardLoading;
    else if (!options.length) hintEl.textContent = t.leaderboardEmpty;
    else hintEl.textContent = t.leaderboardHint;
  }

  // Keep the combobox input in sync with the selected MVP. We only touch
  // the value when the user isn't actively editing — otherwise typing into
  // the input would overwrite mid-keystroke.
  const input = document.querySelector<HTMLInputElement>(
    "#leaderboard-mvp-input",
  );
  if (input) {
    input.disabled = !options.length;
    if (document.activeElement !== input) {
      const picked = options.find((o) => o.view === state.selectedView);
      input.value = picked?.name ?? "";
    }
  }
  paintMvpCombobox();

  const damageHost = document.querySelector<HTMLElement>(
    "#leaderboard-damage-table",
  );
  const dpsHost = document.querySelector<HTMLElement>(
    "#leaderboard-dps-table",
  );
  if (!damageHost || !dpsHost) return;

  // Populate the class filter dropdown from the rows visible under the
  // currently-selected MVP. Doing it per-MVP keeps the dropdown small and
  // honest — only classes that actually have a leaderboard entry for *this*
  // MVP appear. The previously-selected class is preserved if it's still
  // present; otherwise the filter resets to "all".
  paintClassFilter();

  if (!options.length || state.selectedView == null) {
    damageHost.innerHTML = "";
    dpsHost.innerHTML = "";
    return;
  }

  const all = collectRowsForView(
    state.items,
    state.selectedView,
    state.selectedClass,
  );
  paintMetricTable(damageHost, "highestHit", topN(all, "highestHit", 5));
  paintMetricTable(dpsHost, "dps", topN(all, "dps", 5));
}

function collectClassesForView(view: number): {
  classes: string[];
  hasUnknown: boolean;
} {
  const set = new Set<string>();
  let hasUnknown = false;
  for (const it of state.items) {
    for (const r of it.mvpRecords) {
      if (r.view !== view) continue;
      const c = r.class ?? "";
      if (c) set.add(c);
      else hasUnknown = true;
    }
  }
  return {
    classes: Array.from(set).sort((a, b) => a.localeCompare(b, locale)),
    hasUnknown,
  };
}

function paintClassFilter() {
  const sel = document.querySelector<HTMLSelectElement>(
    "#leaderboard-class-select",
  );
  if (!sel) return;
  const view = state.selectedView;
  const { classes, hasUnknown } =
    view == null ? { classes: [], hasUnknown: false } : collectClassesForView(view);

  // Always rebuild — the option set changes whenever the MVP changes. Cache
  // the user's currently-selected value first, then restore it if it's
  // still in the new list.
  const wanted =
    state.selectedClass === null
      ? CLASS_ALL_VALUE
      : state.selectedClass === ""
        ? CLASS_UNKNOWN_VALUE
        : state.selectedClass;

  sel.innerHTML = "";
  const all = document.createElement("option");
  all.value = CLASS_ALL_VALUE;
  all.textContent = t.leaderboardClassAll;
  sel.appendChild(all);
  for (const c of classes) {
    const o = document.createElement("option");
    o.value = c;
    o.textContent = c;
    sel.appendChild(o);
  }
  if (hasUnknown) {
    const o = document.createElement("option");
    o.value = CLASS_UNKNOWN_VALUE;
    o.textContent = t.leaderboardClassUnknown;
    sel.appendChild(o);
  }

  // If the previously-selected class doesn't exist under the new MVP, snap
  // back to "all" so the user isn't staring at an empty top-5.
  const valid = new Set<string>([
    CLASS_ALL_VALUE,
    ...classes,
    ...(hasUnknown ? [CLASS_UNKNOWN_VALUE] : []),
  ]);
  if (!valid.has(wanted)) {
    sel.value = CLASS_ALL_VALUE;
    state.selectedClass = null;
  } else {
    sel.value = wanted;
  }
  sel.disabled = classes.length === 0 && !hasUnknown;
}

function paintMetricTable(
  host: HTMLElement,
  metric: "highestHit" | "dps",
  rows: LeaderboardRow[],
) {
  if (rows.length === 0) {
    host.innerHTML = "";
    const p = document.createElement("p");
    p.className = "muted small leaderboard-card-empty";
    p.textContent = t.leaderboardEmptyForMvp;
    host.appendChild(p);
    return;
  }
  renderTable<LeaderboardRow>(
    host,
    [
      {
        key: "rank",
        label: t.leaderboardColRank,
        numeric: true,
        format: (r) => String(r.rank),
        sortValue: (r) => r.rank,
      },
      {
        key: "playerName",
        label: t.leaderboardColPlayer,
        format: (r) => r.playerName,
      },
      {
        key: "value",
        label:
          metric === "highestHit"
            ? t.leaderboardColHighestHit
            : t.leaderboardColDps,
        numeric: true,
        format: (r) =>
          (metric === "highestHit" ? r.highestHit : r.dps).toLocaleString(
            locale,
          ),
        sortValue: (r) => (metric === "highestHit" ? r.highestHit : r.dps),
      },
      {
        key: "recordedAt",
        label: t.leaderboardColDate,
        format: (r) =>
          r.recordedAt ? r.recordedAt.toLocaleDateString(locale) : "—",
        sortValue: (r) => r.recordedAt?.getTime() ?? 0,
      },
      {
        key: "action",
        label: t.leaderboardColAction,
        render: (r, td) => {
          const a = document.createElement("a");
          a.className = "cell-link leaderboard-view-link";
          const url = new URL(location.href);
          url.searchParams.set("r", r.replayId);
          // Anchor href is set to the deep-link so Ctrl/Cmd-click and
          // middle-click open the replay in a new tab natively.
          a.href = "/" + url.search;
          a.textContent = t.leaderboardViewReplay;
          a.addEventListener("click", (e) => {
            // Plain left-click → soft in-app navigation.
            if (
              e.button !== 0 ||
              e.ctrlKey ||
              e.metaKey ||
              e.shiftKey ||
              e.altKey
            )
              return;
            e.preventDefault();
            openReplay(r.replayId);
          });
          td.appendChild(a);
        },
      },
    ],
    rows,
    { initialSort: { key: "rank", asc: true } },
  );
}
