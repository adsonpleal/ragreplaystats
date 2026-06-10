// Cross-replay MVP damage leaderboard. Bulk-fetches replay summaries via the
// existing `listRecentReplays` REST projection (no bytes blob) and aggregates
// the per-(player, MVP species) records denormalized at upload time.
//
// State lives in this module rather than the central `state` object — the
// leaderboard is its own page route and shares no live state with the rest
// of the app aside from "what replay to open when a row is clicked," which
// is wired via the `setupLeaderboard` callback.

import type { ReferenceDb } from "./db/loader.js";
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

/** Combobox value used to represent the unresolved-class bucket. */
const CLASS_UNKNOWN_VALUE = "__unknown__";
/** Combobox value used for "all classes". */
const CLASS_ALL_VALUE = "__all__";

let openReplay: (id: string) => void = () => {};
/**
 * Set after `loadReferenceDb()` resolves in main.ts. The leaderboard uses
 * `db.pcClassNames()` to populate the class filter — keeping the list
 * exhaustive (not derived from loaded records) so empty buckets are still
 * discoverable in the dropdown.
 */
let db: ReferenceDb | null = null;

export function setLeaderboardDb(next: ReferenceDb) {
  db = next;
  paint();
}

// ---------------------------------------------------------------------------
// Reusable combobox factory — both the MVP picker and the class filter are
// instances of the same widget: an input that filters a popover list as the
// user types, with keyboard nav and click-to-select. Each instance owns its
// own little state machine (query / open / active-row).
// ---------------------------------------------------------------------------

type ComboboxItem = { value: string; label: string; iconSrc?: string };

type ComboboxOptions = {
  inputSelector: string;
  listSelector: string;
  /** Re-evaluated on every render and keystroke. */
  getItems(): ComboboxItem[];
  /** Identifier of the currently-committed item, or null. */
  getSelectedValue(): string | null;
  /** Invoked when the user commits (Enter or click). */
  onSelect(item: ComboboxItem): void;
};

type Combobox = {
  setup(): void;
  paint(): void;
};

function createCombobox(opts: ComboboxOptions): Combobox {
  let query = "";
  let open = false;
  let active = 0;

  const $input = () =>
    document.querySelector<HTMLInputElement>(opts.inputSelector);
  const $list = () =>
    document.querySelector<HTMLUListElement>(opts.listSelector);

  function filtered(): ComboboxItem[] {
    const all = opts.getItems();
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((o) => o.label.toLowerCase().includes(q));
  }

  function commit(item: ComboboxItem) {
    opts.onSelect(item);
    const el = $input();
    if (el) el.value = item.label;
    close();
  }

  function close() {
    open = false;
    query = "";
    paint();
  }

  function paint() {
    const inputEl = $input();
    const listEl = $list();
    if (!inputEl || !listEl) return;
    const all = opts.getItems();
    const matches = filtered();
    if (active >= matches.length) active = Math.max(0, matches.length - 1);

    inputEl.disabled = all.length === 0;
    inputEl.setAttribute(
      "aria-expanded",
      String(open && matches.length > 0),
    );
    // Reflect the committed selection in the input when not editing.
    if (document.activeElement !== inputEl) {
      const sel = all.find((o) => o.value === opts.getSelectedValue());
      inputEl.value = sel?.label ?? "";
    }

    listEl.innerHTML = "";
    if (!open || matches.length === 0) {
      listEl.hidden = true;
      return;
    }
    listEl.hidden = false;
    matches.forEach((o, i) => {
      const li = document.createElement("li");
      li.role = "option";
      li.className =
        "leaderboard-combobox-option" + (i === active ? " is-active" : "");
      if (o.iconSrc) {
        const img = document.createElement("img");
        img.className = "class-icon";
        img.src = o.iconSrc;
        img.alt = "";
        img.loading = "lazy";
        img.addEventListener("error", () => img.remove());
        li.appendChild(img);
      }
      li.appendChild(document.createTextNode(o.label));
      if (o.value === opts.getSelectedValue())
        li.setAttribute("aria-selected", "true");
      // mousedown rather than click so we beat the input's blur handler.
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        commit(o);
      });
      listEl.appendChild(li);
    });
  }

  function setup() {
    const inputEl = $input();
    const listEl = $list();
    if (!inputEl || !listEl) return;
    inputEl.addEventListener("focus", () => {
      query = "";
      active = 0;
      open = true;
      inputEl.select();
      paint();
    });
    inputEl.addEventListener("input", () => {
      query = inputEl.value;
      active = 0;
      open = true;
      paint();
    });
    inputEl.addEventListener("keydown", (e) => {
      const matches = filtered();
      if (e.key === "ArrowDown") {
        e.preventDefault();
        open = true;
        active = Math.min(matches.length - 1, active + 1);
        paint();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        active = Math.max(0, active - 1);
        paint();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const pick = matches[active];
        if (pick) commit(pick);
      } else if (e.key === "Escape") {
        close();
      }
    });
    // Delay close so a click on a suggestion item is captured first — the
    // blur fires before the click handler if we close synchronously.
    inputEl.addEventListener("blur", () => {
      window.setTimeout(close, 120);
    });
  }

  return { setup, paint };
}

// ---------------------------------------------------------------------------
// Picker instances — wire the generic combobox to the leaderboard's two
// filters. The data closures pull from `state` lazily so the comboboxes
// re-render whatever the latest data set looks like on every paint pass.
// ---------------------------------------------------------------------------

const mvpCombobox = createCombobox({
  inputSelector: "#leaderboard-mvp-input",
  listSelector: "#leaderboard-mvp-options",
  getItems: () =>
    collectMvpOptions(state.items).map((o) => ({
      value: String(o.view),
      label: o.name,
    })),
  getSelectedValue: () =>
    state.selectedView == null ? null : String(state.selectedView),
  onSelect: (item) => {
    const v = parseInt(item.value, 10);
    if (Number.isFinite(v)) state.selectedView = v;
    paint();
  },
});

const classCombobox = createCombobox({
  inputSelector: "#leaderboard-class-input",
  listSelector: "#leaderboard-class-options",
  getItems: () => {
    const items: ComboboxItem[] = [
      { value: CLASS_ALL_VALUE, label: t.leaderboardClassAll },
    ];
    for (const name of db?.pcClassNames() ?? []) {
      const iconId = db?.pcClassIconId(name);
      items.push({
        value: name,
        label: name,
        iconSrc: iconId != null ? `./icons/job/${iconId}.png` : undefined,
      });
    }
    // "(Sem classe)" only when there's something to fall into that bucket.
    if (anyClasslessRecord()) {
      items.push({
        value: CLASS_UNKNOWN_VALUE,
        label: t.leaderboardClassUnknown,
      });
    }
    return items;
  },
  getSelectedValue: () =>
    state.selectedClass === null
      ? CLASS_ALL_VALUE
      : state.selectedClass === ""
        ? CLASS_UNKNOWN_VALUE
        : state.selectedClass,
  onSelect: (item) => {
    if (item.value === CLASS_ALL_VALUE) state.selectedClass = null;
    else if (item.value === CLASS_UNKNOWN_VALUE) state.selectedClass = "";
    else state.selectedClass = item.value;
    paint();
  },
});

export function setupLeaderboard(onOpenReplay: (id: string) => void) {
  openReplay = onOpenReplay;
  mvpCombobox.setup();
  classCombobox.setup();
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

/**
 * Whether any record in the loaded set has an empty `class` — that's the
 * signal to surface the "(Sem classe)" bucket. Independent of which MVP is
 * selected, since the class list itself is now exhaustive.
 */
function anyClasslessRecord(): boolean {
  for (const it of state.items) {
    for (const r of it.mvpRecords) {
      if (!r.class) return true;
    }
  }
  return false;
}

function paint() {
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

  // Comboboxes pull from `state` via their closures — paint just refreshes
  // their visual state and reflects the current selection in each input.
  mvpCombobox.paint();
  classCombobox.paint();

  const damageHost = document.querySelector<HTMLElement>(
    "#leaderboard-damage-table",
  );
  const dpsHost = document.querySelector<HTMLElement>(
    "#leaderboard-dps-table",
  );
  if (!damageHost || !dpsHost) return;

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
