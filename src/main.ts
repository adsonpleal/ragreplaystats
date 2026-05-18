import {
  brushSeries,
  bySkill,
  bySkillAndPlayer,
  computeResumo,
  consumablesByItem,
  damageTimelineMulti,
  dpsAnalysisStats,
  isPlayerSource,
  killsByPlayerAndMob,
  lootByItem,
  mobHpCurve,
  type MobSkillAgg,
  mobSkillBreakdown,
  monstersDamagedByPlayer,
  monstersWhoTookDamage,
  mvpMatchups,
  paramCurve,
  playersDamagedByMonster,
  SP_HP,
  SP_MAXHP,
  SP_SP,
  SP_MAXSP,
  type MonsterAgg,
  type PlayerAgg,
  playersThatDamaged,
  playersWhoDamaged,
  type Range,
  skillUsageByPlayer,
} from "./aggregate/index.js";
import { loadReferenceDb, type ReferenceDb } from "./db/loader.js";
import { prefetchReplay } from "./divine-pride.js";
import {
  createSuggestion,
  fetchReplay,
  listSuggestions,
  type ReplayListItem,
  type ReplaySummary,
  type Suggestion,
  SUGGESTION_MAX_LENGTH,
  uploadReplay,
  voteSuggestion,
} from "./firebase.js";
import { t, locale } from "./i18n.js";
import { decodeReplay } from "./rrf/decode.js";
import type { DamageEvent, Replay } from "./rrf/types.js";
import { renderBarChart } from "./ui/bar-chart.js";
import { renderDamageMulti } from "./ui/dps-chart.js";
import { renderLineChart } from "./ui/line-chart.js";
import { renderSummaryCard, type SummaryCell } from "./ui/stats-summary.js";
import { renderTable } from "./ui/table.js";
import { renderTimelineBrush } from "./ui/timeline-brush.js";
import { renderDpsScatter } from "./ui/dps-scatter.js";
import { loadLeaderboard, setupLeaderboard } from "./leaderboard.js";
import {
  ensureLoaded as ensureSummariesLoaded,
  getCached as getCachedSummaries,
  invalidate as invalidateSummariesCache,
  isFresh as isSummariesCacheFresh,
} from "./replay-summaries.js";

type Mode = "byPlayer" | "byMonster" | "stats" | "dpsAnalysis";

/**
 * Top-level page. The default ("home") renders the dropzone + recent replays
 * (or the loaded replay's analysis if one is present). "suggestions" is the
 * feedback board. "leaderboard" is the cross-replay MVP rankings page.
 */
type Route = "home" | "suggestions" | "leaderboard";

type State = {
  route: Route;
  replay: Replay | null;
  db: ReferenceDb | null;
  mode: Mode;
  /**
   * Multi-select capable. Plain click on a player table row replaces the
   * set with that single AID; ⌘/Ctrl-click toggles. The "primary" selected
   * player (used to scope the secondary monster table + breadcrumb) is the
   * first inserted member — `Set` preserves insertion order, so don't
   * recreate the set on toggle-add.
   */
  selectedPlayers: Set<number>;
  selectedMonster: number | null;
  /** Brush selection. null = full session. */
  selectedTimeRange: Range;
  /** Set once a replay has been uploaded or fetched — used to render the share link. */
  shareId: string | null;
  /** Raw .rrf bytes for the currently-loaded replay (powers the download button). */
  replayBytes: Uint8Array | null;
  /** Suggested filename when downloading — comes from the drop or the Firestore doc. */
  replayFileName: string | null;
  /**
   * True when the current bytes were fetched from a shared URL (not the
   * user's local drop). Gates the "Download replay" button — if the user
   * loaded their own file, they already have it and download is pointless.
   */
  openedFromUrl: boolean;
  /**
   * Per-victim filter for the "Habilidades de <mob>" card. Reset when the
   * selected monster changes.
   */
  selectedMobSkillTarget: number | null;
  /** Drag-selected window for the DPS Analysis tab. null = full session. */
  dpsAnalysisRange: { startMs: number; endMs: number } | null;
  /**
   * Shared drag-select range for the per-player matchup timelines on the
   * "Por jogador" tab — drag on one card and the same window highlights
   * on every other selected player's card so you can eyeball the same
   * fight slice across players. Reset when monster or tab changes.
   */
  byPlayerCompareRange: { startMs: number; endMs: number } | null;
  /**
   * Recent-replays list state. The full set is bulk-fetched once via REST
   * with the bytes blob projected out, so the player/map filters can do
   * case-insensitive substring matching client-side without round-tripping.
   * Pagination is then a slice over the filtered set.
   */
  recent: {
    items: ReplayListItem[];
    pageIndex: number;
    loading: boolean;
    error: string | null;
    /** Active filter (case-insensitive substring). Empty = no filter. */
    playerFilter: string;
    mapFilter: string;
  };
  /** Suggestions board state, also part of the home view. */
  suggestions: {
    items: Suggestion[];
    loading: boolean;
    error: string | null;
    posting: boolean;
    statusMsg: string | null;
  };
};

const state: State = {
  route: routeFromLocation(),
  replay: null,
  db: null,
  mode: "byPlayer",
  selectedPlayers: new Set(),
  selectedMonster: null,
  selectedTimeRange: null,
  shareId: null,
  replayBytes: null,
  replayFileName: null,
  openedFromUrl: false,
  selectedMobSkillTarget: null,
  dpsAnalysisRange: null,
  byPlayerCompareRange: null,
  recent: {
    items: [],
    pageIndex: 0,
    loading: false,
    error: null,
    playerFilter: "",
    mapFilter: "",
  },
  suggestions: {
    items: [],
    loading: false,
    error: null,
    posting: false,
    statusMsg: null,
  },
};

const RECENT_PAGE_SIZE = 10;

/**
 * "Primary" selected player = the first one inserted into the set, by
 * `Set` iteration order. Drives the secondary monster table, breadcrumb,
 * and any per-player pane that hasn't been multiplied yet.
 */
function primarySelectedPlayer(): number | null {
  const it = state.selectedPlayers.values().next();
  return it.done ? null : it.value;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector<T>(sel)!;

function routeFromLocation(): Route {
  const path = location.pathname.replace(/\/+$/, "").toLowerCase();
  if (path === "/suggestions") return "suggestions";
  if (path === "/leaderboard") return "leaderboard";
  return "home";
}

function init() {
  paintStaticStrings();
  setupDropZone();
  setupModeToggle();
  setupHomeLink();
  setupSuggestionsNav();
  setupSuggestionsForm();
  setupRecentReplayFilters();
  setupLeaderboardNav();
  setupLeaderboard(openLeaderboardReplay);
  window.addEventListener("popstate", () => {
    state.route = routeFromLocation();
    applyRoute();
  });
  void loadReferenceDb().then((db) => {
    state.db = db;
    if (state.replay) rerender();
  });
  applyRoute();
}

function setupSuggestionsNav() {
  const link = document.querySelector<HTMLAnchorElement>("#suggestions-nav");
  if (!link) return;
  link.addEventListener("click", (e) => {
    e.preventDefault();
    navigateTo("suggestions");
  });
}

function setupLeaderboardNav() {
  const link = document.querySelector<HTMLAnchorElement>("#leaderboard-nav");
  if (!link) return;
  link.addEventListener("click", (e) => {
    e.preventDefault();
    navigateTo("leaderboard");
  });
}

/**
 * Callback the leaderboard module invokes when a "Ver replay" link is
 * left-clicked: switch back to the home route with ?r=<id> and let the
 * normal home flow load the replay. Ctrl/Cmd-click is handled natively by
 * the anchor's href and never reaches this callback.
 */
function openLeaderboardReplay(id: string) {
  const url = new URL(location.href);
  url.searchParams.set("r", id);
  url.searchParams.delete("tab");
  history.pushState(null, "", "/" + url.search);
  state.route = "home";
  applyRoute();
}

function navigateTo(route: Route) {
  if (state.route === route) return;
  state.route = route;
  const path =
    route === "suggestions"
      ? "/suggestions"
      : route === "leaderboard"
        ? "/leaderboard"
        : "/";
  const url = new URL(location.href);
  // Leaving the home route: strip replay-related params so a /leaderboard
  // or /suggestions URL is clean and doesn't try to reopen a shared replay
  // on refresh.
  if (route !== "home") {
    url.searchParams.delete("r");
    url.searchParams.delete("tab");
  }
  history.pushState(null, "", path + (url.search || ""));
  applyRoute();
}

/**
 * Show/hide top-level sections to match `state.route`. Called on init, on
 * navigation, and on popstate. Each route owns the visibility of every
 * section it cares about — there's no per-section toggle scattered around.
 */
function applyRoute() {
  const suggestionsNav = document.querySelector<HTMLElement>("#suggestions-nav");
  const leaderboardNav = document.querySelector<HTMLElement>("#leaderboard-nav");
  if (suggestionsNav) suggestionsNav.hidden = state.route === "suggestions";
  if (leaderboardNav) leaderboardNav.hidden = state.route === "leaderboard";

  if (state.route === "suggestions") {
    $("#seo-intro").hidden = true;
    $("#drop-zone").hidden = true;
    $("#recent-replays").hidden = true;
    $("#leaderboard").hidden = true;
    $("#summary").hidden = true;
    $("#explorer").hidden = true;
    $("#share-controls").hidden = true;
    void loadSuggestions();
    return;
  }

  if (state.route === "leaderboard") {
    $("#seo-intro").hidden = true;
    $("#drop-zone").hidden = true;
    $("#recent-replays").hidden = true;
    $("#suggestions").hidden = true;
    $("#summary").hidden = true;
    $("#explorer").hidden = true;
    $("#share-controls").hidden = true;
    $("#leaderboard").hidden = false;
    void loadLeaderboard();
    return;
  }

  // Home route.
  $("#seo-intro").hidden = false;
  $("#drop-zone").hidden = false;
  $("#suggestions").hidden = true;
  $("#leaderboard").hidden = true;

  const hasR = new URLSearchParams(location.search).get("r");
  if (hasR) {
    // If a different replay is already loaded (e.g. user is jumping between
    // replays from the leaderboard), the URL change isn't enough — the old
    // replay's state is still in memory. Reset and fetch the new one.
    if (state.replay && state.shareId === hasR) {
      rerender();
    } else {
      state.replay = null;
      state.shareId = null;
      state.replayBytes = null;
      state.replayFileName = null;
      state.openedFromUrl = false;
      state.selectedPlayers.clear();
      state.selectedMonster = null;
      state.selectedTimeRange = null;
      state.selectedMobSkillTarget = null;
      state.dpsAnalysisRange = null;
      state.byPlayerCompareRange = null;
      void loadFromUrl();
    }
    return;
  }
  if (state.replay) {
    rerender();
    return;
  }
  // Plain home — no replay loaded, no ?r=.
  $("#summary").hidden = true;
  $("#explorer").hidden = true;
  void loadRecentReplays();
}

function setupHomeLink() {
  const link = document.querySelector<HTMLAnchorElement>("#home-link");
  if (!link) return;
  link.addEventListener("click", (e) => {
    // Soft navigation: route back to home, clear any replay state, re-show
    // the recent-uploads list — no full reload.
    e.preventDefault();
    const onHome = state.route === "home";
    if (
      onHome &&
      !state.replay &&
      !new URLSearchParams(location.search).get("r")
    ) {
      return;
    }
    const url = new URL(location.href);
    url.searchParams.delete("r");
    url.searchParams.delete("tab");
    history.pushState(null, "", "/" + (url.search || ""));
    state.route = "home";
    state.replay = null;
    state.shareId = null;
    state.replayBytes = null;
    state.replayFileName = null;
    state.openedFromUrl = false;
    state.selectedPlayers.clear();
    state.selectedMonster = null;
    state.selectedTimeRange = null;
    state.selectedMobSkillTarget = null;
    state.dpsAnalysisRange = null;
    state.byPlayerCompareRange = null;
    $("#share-controls").innerHTML = "";
    $("#drop-status").textContent = "";
    // Reset pagination + filters so the user sees page 1 of the freshest list.
    state.recent.pageIndex = 0;
    state.recent.items = [];
    state.recent.playerFilter = "";
    state.recent.mapFilter = "";
    state.recent.error = null;
    applyRoute();
  });
}

async function loadFromUrl() {
  const id = new URLSearchParams(location.search).get("r");
  if (!id) return;
  const status = $("#drop-status");
  status.textContent = t.fetching(id);
  try {
    const fetched = await fetchReplay(id);
    if (!fetched) {
      status.textContent = t.notFound(id);
      return;
    }
    parseAndRender(fetched.bytes.buffer, fetched.fileName, id);
  } catch (err) {
    console.error(err);
    status.textContent = t.fetchError((err as Error).message);
  }
}

function renderShareControls() {
  const host = $("#share-controls");
  host.innerHTML = "";
  if (!state.replay) {
    host.hidden = true;
    return;
  }
  host.hidden = false;

  // Only worth showing when the bytes came from a shared URL — if the user
  // dropped a local file they already have it on disk.
  if (state.replayBytes && state.openedFromUrl) {
    const dl = document.createElement("button");
    dl.type = "button";
    dl.className = "share-btn";
    dl.textContent = t.downloadReplay;
    dl.addEventListener("click", () => downloadReplayBytes());
    host.appendChild(dl);
  }

  if (state.shareId) {
    const url = new URL(location.href);
    url.searchParams.set("r", state.shareId);
    const link = url.toString();

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "share-btn";
    btn.textContent = t.copyLink;
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(link);
        btn.textContent = t.linkCopied;
        setTimeout(() => (btn.textContent = t.copyLink), 1500);
      } catch {
        // Fallback: select the link text so the user can copy manually.
        window.prompt(t.copyLink, link);
      }
    });
    host.appendChild(btn);

    const linkEl = document.createElement("code");
    linkEl.className = "share-link";
    linkEl.textContent = link;
    host.appendChild(linkEl);
  }
}

function downloadReplayBytes() {
  if (!state.replayBytes) return;
  const fileName = state.replayFileName?.endsWith(".rrf")
    ? state.replayFileName
    : `${state.replayFileName ?? "replay"}.rrf`;
  // Copy into a fresh ArrayBuffer so the Blob owns its memory independently.
  const blob = new Blob([state.replayBytes.slice().buffer], {
    type: "application/octet-stream",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function parseAndRender(
  buf: ArrayBuffer | ArrayBufferLike,
  fileName: string,
  shareId: string | null,
) {
  const status = $("#drop-status");
  const t0 = performance.now();
  const replay = decodeReplay(buf as ArrayBuffer);
  const ms = (performance.now() - t0).toFixed(0);
  state.replay = replay;
  state.selectedPlayers.clear();
  state.selectedMonster = null;
  state.selectedTimeRange = null;
  state.selectedMobSkillTarget = null;
  state.dpsAnalysisRange = null;
  state.byPlayerCompareRange = null;
  state.shareId = shareId;
  state.openedFromUrl = shareId != null;
  // Keep a copy of the raw bytes so the user can re-download the replay
  // (only surfaced when the bytes came from a shared URL — see
  // `renderShareControls`).
  state.replayBytes = new Uint8Array(buf as ArrayBuffer).slice();
  state.replayFileName = fileName;
  // Honour ?tab=... if it was on the URL when the replay loaded.
  const urlTab = readTabFromUrl();
  if (urlTab) setMode(urlTab);
  status.textContent = t.decoded(
    replay.totals.handledPackets,
    replay.totals.packetCount,
    ms,
    fileName,
  );
  rerender();
  renderShareControls();

  // Load DP name databases in the background; re-render when ready so
  // any `mob#1234` / `skill#999` fallbacks become real names.
  void prefetchReplay(replay).then(() => {
    if (state.replay !== replay) return;
    rerender();
  });
}

function paintStaticStrings() {
  $("#tagline").textContent = t.appTagline;
  $("#drop-prompt").innerHTML =
    `${t.dropPrompt} <label class="link" for="file-input">${t.browse}</label>.`;
  $("#drop-share-label").textContent = t.dropShareLabel;
  $("#drop-share-hint").textContent = t.dropShareHint;
  $("#recent-replays-filter-player-label").textContent =
    t.recentReplaysFilterPlayer;
  $("#recent-replays-filter-map-label").textContent = t.recentReplaysFilterMap;
  $("#recent-replays-filter-clear").textContent = t.recentReplaysFilterClear;
  $("#suggestions-nav").textContent = t.suggestionsNav;
  $("#leaderboard-nav").textContent = t.leaderboardNav;
  $("#leaderboard-title").textContent = t.leaderboardTitle;
  $("#leaderboard-mvp-label").textContent = t.leaderboardMvpLabel;
  $("#leaderboard-class-label").textContent = t.leaderboardClassLabel;
  $("#leaderboard-damage-title").textContent = t.leaderboardTopDamage;
  $("#leaderboard-dps-title").textContent = t.leaderboardTopDps;
  $("#suggestions-title").textContent = t.suggestionsTitle;
  $<HTMLInputElement>("#suggestions-input").placeholder = t.suggestionsPlaceholder;
  $("#suggestions-submit").textContent = t.suggestionsSubmit;
  document
    .querySelectorAll<HTMLButtonElement>(".mode-btn")
    .forEach((btn) => {
      switch (btn.dataset.mode) {
        case "byPlayer":
          btn.textContent = t.modeByPlayer;
          break;
        case "byMonster":
          btn.textContent = t.modeByMonster;
          break;
        case "stats":
          btn.textContent = t.modeStats;
          break;
        case "dpsAnalysis":
          btn.textContent = t.modeDpsAnalysis;
          break;
      }
    });
}

function setupDropZone() {
  const zone = $("#drop-zone");
  const input = $<HTMLInputElement>("#file-input");
  const status = $("#drop-status");

  const handleFile = async (file: File) => {
    status.textContent = t.parsing(file.name, (file.size / 1024).toFixed(1));
    // Drop any stale ?r=… so a refresh doesn't reload the previous shared
    // replay (also relevant when the user is viewing locally without upload).
    const url = new URL(location.href);
    if (url.searchParams.has("r")) {
      url.searchParams.delete("r");
      history.replaceState(null, "", url.toString());
    }
    try {
      const buf = await file.arrayBuffer();
      parseAndRender(buf, file.name, null);
      // Default is view-only — the parsed replay stays in this browser. The
      // user opts in to public sharing via the toggle, which then uploads
      // bytes + summary to Firestore.
      const shareEl = document.querySelector<HTMLInputElement>(
        "#drop-share-checkbox",
      );
      if (shareEl?.checked) {
        const summary = state.replay
          ? buildReplaySummary(state.replay)
          : undefined;
        void uploadAndShare(buf, file.name, summary);
      }
    } catch (err) {
      console.error(err);
      status.textContent = t.parseError((err as Error).message);
    }
  };

  async function uploadAndShare(
    buf: ArrayBuffer,
    fileName: string,
    summary: ReplaySummary | undefined,
  ) {
    const status = $("#drop-status");
    const prev = status.textContent;
    status.textContent = (prev ? prev + " · " : "") + t.uploading;
    try {
      const id = await uploadReplay(new Uint8Array(buf), fileName, summary);
      state.shareId = id;
      // The shared summaries cache no longer reflects reality — drop it so
      // a return visit to home/leaderboard refetches and the new replay
      // shows up immediately.
      invalidateSummariesCache();
      const url = new URL(location.href);
      url.searchParams.set("r", id);
      history.replaceState(null, "", url.toString());
      status.textContent = t.shareReady(url.toString());
      renderShareControls();
    } catch (err) {
      console.error(err);
      status.textContent = t.uploadError((err as Error).message);
    }
  }

  input.addEventListener("change", () => {
    const f = input.files?.[0];
    if (f) void handleFile(f);
  });

  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("is-over");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("is-over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("is-over");
    const f = e.dataTransfer?.files?.[0];
    if (f) void handleFile(f);
  });
}

function setupModeToggle() {
  document.querySelectorAll<HTMLButtonElement>(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode as Mode;
      if (state.mode === mode) return;
      setMode(mode);
      rerender();
    });
  });
}

const VALID_MODES: ReadonlySet<Mode> = new Set([
  "byPlayer",
  "byMonster",
  "stats",
  "dpsAnalysis",
]);

/**
 * Apply a new mode + reflect it in the URL via `?tab=`. Selection state
 * is reset like the original toggle behaviour. The active-button class is
 * re-applied here so the URL-driven path uses the same code.
 */
function setMode(mode: Mode) {
  state.mode = mode;
  state.selectedPlayers.clear();
  state.selectedMonster = null;
  state.byPlayerCompareRange = null;
  document
    .querySelectorAll<HTMLButtonElement>(".mode-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  syncTabToUrl(mode);
}

function syncTabToUrl(mode: Mode) {
  const url = new URL(location.href);
  if (mode === "byPlayer") {
    // Default tab — keep URL clean.
    url.searchParams.delete("tab");
  } else {
    url.searchParams.set("tab", mode);
  }
  const next = url.pathname + (url.search || "");
  if (next !== location.pathname + location.search) {
    history.replaceState(null, "", next);
  }
}

function readTabFromUrl(): Mode | null {
  const raw = new URLSearchParams(location.search).get("tab");
  if (!raw) return null;
  return VALID_MODES.has(raw as Mode) ? (raw as Mode) : null;
}

function rerender() {
  const r = state.replay;
  if (!r) return;

  $("#summary").hidden = false;
  $("#explorer").hidden = false;
  $("#recent-replays").hidden = true;
  renderSummary(r);
  renderBreadcrumb();

  if (state.mode === "byPlayer") {
    renderByPlayerMode(r);
    renderSkillUsesChart(r);
    renderKillsChart(r);
  } else if (state.mode === "byMonster") {
    renderByMonsterMode(r);
    renderSkillUsesChart(r);
    renderKillsChart(r);
  } else if (state.mode === "stats") {
    renderStatsMode(r);
  } else {
    renderDpsAnalysisMode(r);
  }
}

const SKILL_USES_BAR_LIMIT = 30;
const KILLS_BAR_LIMIT = 30;
const ITEM_BAR_LIMIT = 30;
const BRUSH_BUCKET_MS = 1_000;

function clearStatsOnlyPanes() {
  $("#brush-pane").innerHTML = "";
  $("#equipment-pane").innerHTML = "";
}

function clearByModeOnlyPanes() {
  $("#skill-uses-pane").innerHTML = "";
  $("#kills-pane").innerHTML = "";
}

function clearByMonsterOnlyPanes() {
  $("#monster-overview-pane").innerHTML = "";
  $("#hp-curve-pane").innerHTML = "";
  $("#mob-victims-pane").innerHTML = "";
  $("#mob-skills-pane").innerHTML = "";
}

function clearDpsAnalysisOnlyPanes() {
  $("#dps-analysis-help-pane").innerHTML = "";
  $("#dps-analysis-chart-pane").innerHTML = "";
  $("#dps-analysis-stats-pane").innerHTML = "";
}

function renderStatsMode(replay: Replay) {
  clearByModeOnlyPanes();
  clearByMonsterOnlyPanes();
  clearDpsAnalysisOnlyPanes();
  $("#skill-pane").innerHTML = "";
  // Hide the breadcrumb — stats mode is always for the local player.
  $("#breadcrumb").hidden = true;

  renderResumoCard(replay);
  renderBrush(replay);
  renderEquipment(replay);
  renderConsumables(replay);
  renderLoot(replay);
  renderHpSpChart(replay);
  renderKillsByTypeChart(replay);
}

function renderResumoCard(replay: Replay) {
  const stats = computeResumo(replay, state.selectedTimeRange);
  const skillResolver = (id: number) =>
    id === 0 ? t.autoAttack : state.db?.resolveSkill(id) ?? t.skillFallback(id);
  const mobResolver = (id: number) =>
    state.db?.resolveMob(id) ?? t.mobFallback(id);

  const cells: SummaryCell[] = [
    { label: t.cellTotalDealt, value: fmt(stats.totalDealt) },
    { label: t.cellTotalTaken, value: fmt(stats.totalTaken) },
    {
      label: t.cellEffectiveDps,
      value: fmt(stats.effectiveDps),
      hint: t.cellSessionDuration + ": " + formatDuration(stats.durationMs),
    },
    {
      label: t.cellHits,
      value: fmt(stats.hitsLanded),
    },
    ...(hasCritData(replay)
      ? [
          {
            label: t.cellCrits,
            value: stats.hitsLanded
              ? `${fmt(stats.crits)} (${pct(stats.crits, stats.hitsLanded)}%)`
              : "0",
          } as SummaryCell,
        ]
      : []),
    {
      label: t.cellMisses,
      value: stats.hitsLanded
        ? `${fmt(stats.hitsMissed)} (${pct(stats.hitsMissed, stats.hitsLanded)}%)`
        : "0",
    },
    {
      label: t.cellHighestHit,
      value: stats.highestHit ? fmt(stats.highestHit.damage) : t.none,
      hint: stats.highestHit
        ? (stats.highestHit.skillId
            ? skillResolver(stats.highestHit.skillId)
            : t.autoAttack) +
          " → " +
          (replay.entities.get(stats.highestHit.targetAid)?.name ?? mobResolver(replay.entities.get(stats.highestHit.targetAid)?.view ?? 0))
        : undefined,
    },
    {
      label: t.cellMostUsedSkill,
      value: stats.mostUsedSkillId ? skillResolver(stats.mostUsedSkillId) : t.none,
      hint: stats.mostUsedSkillId
        ? `${fmt(stats.mostUsedSkillCount)} ${stats.mostUsedSkillCount === 1 ? "uso" : "usos"}`
        : undefined,
    },
    { label: t.cellKills, value: fmt(stats.kills) },
    { label: t.cellBossKills, value: fmt(stats.bossKills) },
    {
      label: t.cellTtfk,
      value: stats.timeToFirstKillMs == null ? t.none : formatDuration(stats.timeToFirstKillMs),
    },
    {
      label: t.cellAvgKillInterval,
      value: stats.avgKillIntervalMs ? formatDuration(stats.avgKillIntervalMs) : t.none,
    },
    {
      label: t.cellTopSpecies,
      value: stats.topKilledSpecies
        ? mobResolver(stats.topKilledSpecies.view)
        : t.none,
      hint: stats.topKilledSpecies
        ? `${fmt(stats.topKilledSpecies.count)} ${stats.topKilledSpecies.count === 1 ? "abate" : "abates"}`
        : undefined,
    },
    { label: t.cellLevelsGained, value: fmt(stats.baseLevelsGained) },
    { label: t.cellJobLevelsGained, value: fmt(stats.jobLevelsGained) },
    { label: t.cellZenyDelta, value: fmt(stats.zenyDelta) },
    { label: t.cellMapsVisited, value: fmt(stats.mapsVisited) },
    { label: t.cellDeaths, value: fmt(stats.deaths) },
  ];

  renderSummaryCard($("#primary-pane"), t.statsResumoTitle, cells);
}

function renderBrush(replay: Replay) {
  const host = $("#brush-pane");
  host.innerHTML = "";
  const series = brushSeries(replay, BRUSH_BUCKET_MS);
  if (!series.ts.length) return;

  const wrap = document.createElement("section");
  wrap.className = "stats-card brush-host";
  const h2 = document.createElement("h2");
  h2.textContent = t.statsBrushHint;
  h2.style.fontSize = "0.85rem";
  h2.style.fontWeight = "400";
  h2.style.color = "var(--muted)";
  wrap.appendChild(h2);

  const chartHost = document.createElement("div");
  chartHost.id = "brush-chart";
  wrap.appendChild(chartHost);

  const actions = document.createElement("div");
  actions.className = "brush-actions";
  if (state.selectedTimeRange) {
    const label = document.createElement("span");
    label.textContent = t.statsRangeLabel(
      formatDuration(state.selectedTimeRange.startMs),
      formatDuration(state.selectedTimeRange.endMs),
    );
    actions.appendChild(label);
    const clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = t.statsBrushClear;
    clear.addEventListener("click", () => {
      state.selectedTimeRange = null;
      rerender();
    });
    actions.appendChild(clear);
  }
  wrap.appendChild(actions);
  host.appendChild(wrap);

  renderTimelineBrush(chartHost, series, {
    initialRange: state.selectedTimeRange,
    onSelect: (range) => {
      // Skip if range is identical to current — happens after the ready
      // hook restores the selection rect, which fires setSelect again.
      const cur = state.selectedTimeRange;
      if (
        (cur === null && range === null) ||
        (cur && range && cur.startMs === range.startMs && cur.endMs === range.endMs)
      ) {
        return;
      }
      state.selectedTimeRange = range;
      rerender();
    },
  });
}

function renderConsumables(replay: Replay) {
  const host = $("#secondary-pane");
  const itemResolver = (id: number) =>
    state.db?.resolveItem(id) ?? t.itemFallback(id);
  const rows = consumablesByItem(replay, state.selectedTimeRange, itemResolver);
  if (!rows.length) {
    host.innerHTML = `<h2 class="section-title">${t.statsConsumablesTitle}</h2><p class="section-hint">${t.statsConsumablesEmpty}</p>`;
    return;
  }
  host.innerHTML = `<h2 class="section-title">${t.statsConsumablesTitle}</h2>
    <div id="consumables-bars"></div>`;
  renderBarChart(
    $("#consumables-bars"),
    rows.slice(0, ITEM_BAR_LIMIT).map((r) => ({
      key: r.itemId,
      label: r.itemId ? `#${r.itemId} · ${r.name}` : r.name,
      labelSegments: r.itemId
        ? [
            { text: `#${r.itemId}`, href: itemDpUrl(r.itemId) },
            { text: ` · ${r.name}` },
          ]
        : undefined,
      value: r.quantity,
      display: `${fmt(r.quantity)} (${r.count} usos)`,
    })),
  );
}

function renderLoot(replay: Replay) {
  const host = $("#bar-pane");
  const itemResolver = (id: number) =>
    state.db?.resolveItem(id) ?? t.itemFallback(id);
  const rows = lootByItem(replay, state.selectedTimeRange, itemResolver);
  if (!rows.length) {
    host.innerHTML = `<h2 class="section-title">${t.statsLootTitle}</h2><p class="section-hint">${t.statsLootEmpty}</p>`;
    return;
  }
  host.innerHTML = `<h2 class="section-title">${t.statsLootTitle}</h2>
    <div id="loot-bars"></div>`;
  renderBarChart(
    $("#loot-bars"),
    rows.slice(0, ITEM_BAR_LIMIT).map((r) => ({
      key: r.itemId,
      label: r.itemId ? `#${r.itemId} · ${r.name}` : r.name,
      labelSegments: r.itemId
        ? [
            { text: `#${r.itemId}`, href: itemDpUrl(r.itemId) },
            { text: ` · ${r.name}` },
          ]
        : undefined,
      value: r.quantity,
      display: fmt(r.quantity),
    })),
  );
}

function itemDpUrl(id: number): string {
  return `https://www.divine-pride.net/database/item/${id}`;
}

function mobDpUrl(view: number): string {
  return `https://www.divine-pride.net/database/monster/${view}`;
}

function skillDpUrl(id: number): string {
  return `https://www.divine-pride.net/database/skill/${id}`;
}

function renderHpSpChart(replay: Replay) {
  const host = $("#chart-pane");
  const range = state.selectedTimeRange;
  const hp = paramCurve(replay, SP_HP, range);
  const sp = paramCurve(replay, SP_SP, range);
  const maxHp = paramCurve(replay, SP_MAXHP, range);
  const maxSp = paramCurve(replay, SP_MAXSP, range);

  if (!hp.ts.length && !sp.ts.length) {
    host.innerHTML = "";
    return;
  }

  // Merge the time axes by sampling step values at every distinct timestamp.
  const allTs = new Set<number>([...hp.ts, ...sp.ts, ...maxHp.ts, ...maxSp.ts]);
  const sortedTs = [...allTs].sort((a, b) => a - b);
  const sample = (curve: { ts: number[]; values: number[] }, t: number) => {
    let v = 0;
    for (let i = 0; i < curve.ts.length; i++) {
      if (curve.ts[i] > t) break;
      v = curve.values[i];
    }
    return v;
  };

  host.innerHTML = `<h2 class="section-title">${t.statsHpSpChartTitle}</h2>
    <div id="hpsp-chart" class="stats-chart"></div>`;
  renderLineChart(
    $("#hpsp-chart"),
    sortedTs,
    [
      { label: "HP", values: sortedTs.map((t) => sample(hp, t)), paletteIndex: 6 },
      { label: "HP máx.", values: sortedTs.map((t) => sample(maxHp, t)), paletteIndex: 7 },
      { label: "SP", values: sortedTs.map((t) => sample(sp, t)), paletteIndex: 1 },
      { label: "SP máx.", values: sortedTs.map((t) => sample(maxSp, t)), paletteIndex: 2 },
    ],
    { height: 240 },
  );
}

function renderKillsByTypeChart(replay: Replay) {
  const host = $("#kills-pane");
  const mobResolver = (id: number) =>
    state.db?.resolveMob(id) ?? t.mobFallback(id);
  // Stats mode is always the local player's perspective.
  const rows = killsByPlayerAndMob(
    replay,
    {
      sourceAid: replay.sessionInfo.aid,
      // Range filtering on kills happens via `replay.kills` time, not via
      // a separate target filter — we re-aggregate from the full replay
      // each render and discard out-of-window kills below.
    },
    mobResolver,
  );
  const range = state.selectedTimeRange;
  // Re-filter against the brush range. killsByPlayerAndMob doesn't accept a
  // time filter directly, so we redo aggregation by walking replay.kills.
  if (range) {
    const filtered = new Map<number, { name: string; count: number }>();
    for (const k of replay.kills) {
      if (k.time < range.startMs || k.time > range.endMs) continue;
      const ent = replay.entities.get(k.aid);
      if (!ent || ent.kind !== "mob") continue;
      // Was it the player's killing blow? Re-use the heuristic from the
      // aggregator: latest player damage on this mob before vanish.
      let lastHit: number | null = null;
      let lastSrc = 0;
      for (const d of replay.damage) {
        if (d.target !== k.aid || d.time > k.time) continue;
        const src = replay.entities.get(d.source);
        if (!src || (src.kind !== "pc" && src.kind !== "homun" && src.kind !== "merc")) continue;
        if (lastHit == null || d.time > lastHit) {
          lastHit = d.time;
          lastSrc = d.source;
        }
      }
      if (lastSrc !== replay.sessionInfo.aid) continue;
      const cur = filtered.get(ent.view) ?? { name: mobResolver(ent.view), count: 0 };
      cur.count += 1;
      filtered.set(ent.view, cur);
    }
    if (!filtered.size) {
      host.innerHTML = "";
      return;
    }
    const sorted = [...filtered.entries()].sort((a, b) => b[1].count - a[1].count);
    host.innerHTML = `<h2 class="section-title">${t.statsKillsChartTitle}</h2>
      <div id="kills-bars"></div>`;
    renderBarChart(
      $("#kills-bars"),
      sorted.map(([view, v]) => ({
        key: view,
        label: view ? `#${view} · ${v.name}` : v.name,
        labelSegments: view
          ? [
              { text: `#${view}`, href: mobDpUrl(view) },
              { text: ` · ${v.name}` },
            ]
          : undefined,
        value: v.count,
        display: fmt(v.count),
      })),
    );
    return;
  }

  if (!rows.length) {
    host.innerHTML = "";
    return;
  }
  host.innerHTML = `<h2 class="section-title">${t.statsKillsChartTitle}</h2>
    <div id="kills-bars"></div>`;
  renderBarChart(
    $("#kills-bars"),
    rows.map((r) => ({
      key: r.monsterView,
      label: r.monsterView ? `#${r.monsterView} · ${r.monsterName}` : r.monsterName,
      labelSegments: r.monsterView
        ? [
            { text: `#${r.monsterView}`, href: mobDpUrl(r.monsterView) },
            { text: ` · ${r.monsterName}` },
          ]
        : undefined,
      value: r.count,
      display: fmt(r.count),
    })),
  );
}

function pct(n: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((n / total) * 100);
}

/**
 * Bit → label mapping for the `equipped` (equipLocation) bitmask. Values
 * follow rAthena's `e_equip_pos`. First matching bit wins as the row's
 * primary slot; order also drives the row sort within the equipment table.
 */
const EQUIP_SLOTS: Array<readonly [bit: number, label: () => string]> = [
  [256, () => t.slotHeadTop],          // EQP_HEAD_TOP
  [512, () => t.slotHeadMid],          // EQP_HEAD_MID
  [1, () => t.slotHeadLow],            // EQP_HEAD_LOW
  [16, () => t.slotArmor],             // EQP_ARMOR
  [2, () => t.slotWeapon],             // EQP_HAND_R
  [32, () => t.slotShield],            // EQP_HAND_L
  [4, () => t.slotGarment],            // EQP_GARMENT
  [64, () => t.slotShoes],             // EQP_SHOES
  [8, () => t.slotAccLeft],            // EQP_ACC_L
  [128, () => t.slotAccRight],         // EQP_ACC_R
  [32768, () => t.slotAmmo],           // EQP_AMMO
  [1024, () => t.slotCostumeHeadTop],  // EQP_COSTUME_HEAD_TOP
  [2048, () => t.slotCostumeHeadMid],  // EQP_COSTUME_HEAD_MID
  [4096, () => t.slotCostumeHeadLow],  // EQP_COSTUME_HEAD_LOW
  [8192, () => t.slotCostumeGarment],  // EQP_COSTUME_GARMENT
  [65536, () => t.slotShadowArmor],    // EQP_SHADOW_ARMOR
  [131072, () => t.slotShadowWeapon],  // EQP_SHADOW_WEAPON
  [262144, () => t.slotShadowShield],  // EQP_SHADOW_SHIELD
  [524288, () => t.slotShadowShoes],   // EQP_SHADOW_SHOES
  [1048576, () => t.slotShadowAccRight], // EQP_SHADOW_ACC_R
  [2097152, () => t.slotShadowAccLeft],  // EQP_SHADOW_ACC_L
];

type EquippedRow = {
  slotOrder: number;
  slotLabel: string;
  itemId: number;
  itemName: string;
  refine: number;
  cards: number[];
};

function renderEquipment(replay: Replay) {
  const host = $("#equipment-pane");
  const itemResolver = (id: number) =>
    state.db?.resolveItem(id) ?? t.itemFallback(id);

  const rows: EquippedRow[] = [];
  for (const inv of replay.initialInventory.values()) {
    if (!inv.equipped) continue;
    if (!inv.itemId) continue;
    let slotOrder = EQUIP_SLOTS.length;
    let slotLabel = t.slotOther;
    for (let i = 0; i < EQUIP_SLOTS.length; i++) {
      const [bit, label] = EQUIP_SLOTS[i];
      if (inv.equipped & bit) {
        slotOrder = i;
        slotLabel = label();
        break;
      }
    }
    rows.push({
      slotOrder,
      slotLabel,
      itemId: inv.itemId,
      itemName: itemResolver(inv.itemId),
      refine: inv.refine,
      cards: inv.cards.filter((c) => c > 0),
    });
  }

  if (!rows.length) {
    host.innerHTML = "";
    return;
  }
  rows.sort((a, b) => a.slotOrder - b.slotOrder);

  host.innerHTML = `<h2 class="section-title">${t.equipmentTitle}</h2>
    <div id="equipment-table"></div>`;

  renderTable<EquippedRow>(
    $("#equipment-table"),
    [
      {
        key: "itemId",
        label: t.colId,
        format: (r) => String(r.itemId),
        href: (r) => itemDpUrl(r.itemId),
      },
      { key: "slotLabel", label: t.colSlot, sortValue: (r) => r.slotOrder },
      { key: "itemName", label: t.colItem },
      {
        key: "refine",
        label: t.colRefine,
        numeric: true,
        format: (r) => (r.refine > 0 ? `+${r.refine}` : t.none),
        sortValue: (r) => r.refine,
      },
      {
        key: "cards",
        label: t.colCards,
        sortValue: (r) => r.cards.length,
        render: (r, td) => {
          if (!r.cards.length) {
            td.textContent = t.equipmentEmptyCardSlot;
            return;
          }
          for (let i = 0; i < r.cards.length; i++) {
            if (i > 0) td.appendChild(document.createTextNode(", "));
            const id = r.cards[i];
            const link = document.createElement("a");
            link.className = "cell-link";
            link.href = itemDpUrl(id);
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.textContent = `#${id}`;
            link.addEventListener("click", (e) => e.stopPropagation());
            td.appendChild(link);
            td.appendChild(
              document.createTextNode(` · ${itemResolver(id)}`),
            );
          }
        },
      },
    ],
    rows,
    { initialSort: { key: "slotLabel", asc: true } },
  );
}


function renderKillsChart(replay: Replay) {
  const host = $("#kills-pane");
  const mobResolver = (id: number) =>
    state.db?.resolveMob(id) ?? t.mobFallback(id);

  const filter: { sourceAid?: number; targetView?: number } = {};
  const primary = primarySelectedPlayer();
  if (primary != null) filter.sourceAid = primary;
  if (state.selectedMonster != null) {
    // Filter on the species (view), not the specific instance — picking
    // "Deep Sea Sropho #1234" means "all Deep Sea Spropho kills".
    const ent = replay.entities.get(state.selectedMonster);
    if (ent?.view) filter.targetView = ent.view;
  }

  const rows = killsByPlayerAndMob(replay, filter, mobResolver);
  if (!rows.length) {
    host.innerHTML = "";
    return;
  }

  const playerLabel = primary != null ? playerName(replay, primary) : null;
  const monsterLabel =
    state.selectedMonster != null ? monsterName(replay, state.selectedMonster) : null;

  let title: string;
  let hint: string | null = null;
  if (playerLabel && monsterLabel) {
    title = t.killsPlayerVsMonsterTitle(playerLabel, monsterLabel);
  } else if (playerLabel) {
    title = t.killsByPlayerTitle(playerLabel);
  } else if (monsterLabel) {
    title = t.killsByMonsterTitle(monsterLabel);
  } else {
    title = t.killsAllTitle;
    hint = t.killsAllHint;
  }

  const truncated = rows.slice(0, KILLS_BAR_LIMIT);

  host.innerHTML = `<h2 class="section-title">${escape(title)}</h2>
    ${hint ? `<p class="section-hint">${escape(hint)}</p>` : ""}
    <div id="kills-bars"></div>`;

  renderBarChart(
    $("#kills-bars"),
    truncated.map((r) => {
      const mobHref = r.monsterView ? mobDpUrl(r.monsterView) : undefined;
      const idChip = r.monsterView ? `#${r.monsterView}` : "";
      let label: string;
      let labelSegments: { text: string; href?: string }[] | undefined;
      if (playerLabel && monsterLabel) {
        label = `${r.playerName} · ${idChip}${idChip ? " " : ""}${r.monsterName}`;
        labelSegments = idChip
          ? [
              { text: `${r.playerName} · ` },
              { text: idChip, href: mobHref },
              { text: ` · ${r.monsterName}` },
            ]
          : [{ text: `${r.playerName} · ${r.monsterName}` }];
      } else if (playerLabel) {
        label = idChip ? `${idChip} · ${r.monsterName}` : r.monsterName;
        labelSegments = idChip
          ? [
              { text: idChip, href: mobHref },
              { text: ` · ${r.monsterName}` },
            ]
          : [{ text: r.monsterName }];
      } else if (monsterLabel) {
        // Bar represents a player when the mob is fixed — no DP link.
        label = r.playerName;
      } else {
        label = idChip
          ? `${r.playerName} · ${idChip} · ${r.monsterName}`
          : `${r.playerName} · ${r.monsterName}`;
        labelSegments = idChip
          ? [
              { text: `${r.playerName} · ` },
              { text: idChip, href: mobHref },
              { text: ` · ${r.monsterName}` },
            ]
          : [{ text: `${r.playerName} · ${r.monsterName}` }];
      }
      return {
        key: r.key,
        label,
        labelSegments,
        value: r.count,
        display: fmt(r.count),
      };
    }),
  );
}

function renderSkillUsesChart(replay: Replay) {
  const host = $("#skill-uses-pane");
  const skillResolver = (id: number) =>
    id === 0 ? t.autoAttack : state.db?.resolveSkill(id) ?? t.skillFallback(id);

  const filter: { sourceAid?: number; targetAid?: number } = {};
  const primary = primarySelectedPlayer();
  if (primary != null) filter.sourceAid = primary;
  if (state.selectedMonster != null) filter.targetAid = state.selectedMonster;

  const rows = skillUsageByPlayer(replay, filter, skillResolver);
  if (!rows.length) {
    host.innerHTML = "";
    return;
  }

  const playerLabel = primary != null ? playerName(replay, primary) : null;
  const monsterLabel =
    state.selectedMonster != null ? monsterName(replay, state.selectedMonster) : null;

  let title: string;
  let hint: string | null = null;
  if (playerLabel && monsterLabel) {
    title = t.skillUsesPlayerVsMonsterTitle(playerLabel, monsterLabel);
  } else if (playerLabel) {
    title = t.skillUsesPlayerTitle(playerLabel);
  } else if (monsterLabel) {
    title = t.skillUsesMonsterTitle(monsterLabel);
  } else {
    title = t.skillUsesAllTitle;
    hint = t.skillUsesAllHint;
  }

  const showPlayerInLabel = playerLabel == null;
  const truncated = rows.slice(0, SKILL_USES_BAR_LIMIT);

  host.innerHTML = `<h2 class="section-title">${escape(title)}</h2>
    ${hint ? `<p class="section-hint">${escape(hint)}</p>` : ""}
    <div id="skill-uses-bars"></div>`;

  renderBarChart(
    $("#skill-uses-bars"),
    truncated.map((r) => {
      const idChip = r.skillId ? `#${r.skillId}` : "";
      const skillHref = r.skillId ? skillDpUrl(r.skillId) : undefined;
      const labelText = showPlayerInLabel
        ? `${r.playerName} · ${idChip ? `${idChip} · ` : ""}${r.skillName}`
        : `${idChip ? `${idChip} · ` : ""}${r.skillName}`;
      let labelSegments: { text: string; href?: string }[] | undefined;
      if (idChip) {
        labelSegments = showPlayerInLabel
          ? [
              { text: `${r.playerName} · ` },
              { text: idChip, href: skillHref },
              { text: ` · ${r.skillName}` },
            ]
          : [
              { text: idChip, href: skillHref },
              { text: ` · ${r.skillName}` },
            ];
      }
      return {
        key: r.key,
        label: labelText,
        labelSegments,
        value: r.count,
        display: fmt(r.count),
      };
    }),
  );
}

function monsterName(replay: Replay, aid: number): string {
  const ent = replay.entities.get(aid);
  if (ent && state.db && ent.view) {
    const fromDb = state.db.resolveMob(ent.view);
    if (!fromDb.startsWith("mob#")) return fromDb;
  }
  if (!ent) return t.unknownTargetName;
  if (ent.name) return ent.name;
  return t.mobFallback(ent.view || aid);
}

function playerName(replay: Replay, aid: number): string {
  const ent = replay.entities.get(aid);
  return ent?.name || `#${aid}`;
}

function playerClass(replay: Replay, aid: number): string {
  const ent = replay.entities.get(aid);
  if (!ent || !ent.view) return t.none;
  if (state.db) {
    const fromDb = state.db.resolveJob(ent.view);
    if (!fromDb.startsWith("job#")) return fromDb;
  }
  return t.none;
}

function playerLevel(replay: Replay, aid: number): number {
  return replay.entities.get(aid)?.level ?? 0;
}

function effectiveMaxHp(rawMaxHp: number, view: number): number {
  if (rawMaxHp > 0) return rawMaxHp;
  return state.db?.resolveMobHp(view) ?? 0;
}

/**
 * Whether the recording carries any crit information at all. Some servers
 * (Latam Event Horizon among them) never tag damage as DMG_CRITICAL or
 * DMG_MULTI_HIT_CRITICAL, so showing a "Críticos" column full of zeros
 * would be misleading — we hide the column entirely instead.
 */
const critDataCache = new WeakMap<Replay, boolean>();
function hasCritData(replay: Replay): boolean {
  const cached = critDataCache.get(replay);
  if (cached !== undefined) return cached;
  let result = false;
  for (const d of replay.damage) {
    if (d.rawAction === 10 || d.rawAction === 13) { result = true; break; }
  }
  critDataCache.set(replay, result);
  return result;
}

function renderBreadcrumb() {
  const r = state.replay!;
  const host = $("#breadcrumb");
  host.innerHTML = "";

  const crumbs: Array<{ label: string; value: string; clear: () => void }> = [];

  if (state.mode === "byPlayer") {
    // One chip per selected player. × removes that single player; if it
    // was the last one, also drop the selected monster (drill-down has
    // nothing to render).
    for (const playerAid of state.selectedPlayers) {
      crumbs.push({
        label: t.crumbPlayer,
        value: playerName(r, playerAid),
        clear: () => {
          state.selectedPlayers.delete(playerAid);
          if (state.selectedPlayers.size === 0) state.selectedMonster = null;
          rerender();
        },
      });
    }
    if (state.selectedMonster !== null) {
      crumbs.push({
        label: t.crumbMonster,
        value: monsterName(r, state.selectedMonster),
        clear: () => {
          state.selectedMonster = null;
          rerender();
        },
      });
    }
  } else {
    if (state.selectedMonster !== null) {
      crumbs.push({
        label: t.crumbMonster,
        value: monsterName(r, state.selectedMonster),
        clear: () => {
          state.selectedMonster = null;
          rerender();
        },
      });
    }
  }

  if (!crumbs.length) {
    host.hidden = true;
    return;
  }
  host.hidden = false;

  for (let i = 0; i < crumbs.length; i++) {
    if (i > 0) {
      const arrow = document.createElement("span");
      arrow.className = "arrow";
      arrow.textContent = "›";
      host.appendChild(arrow);
    }
    const c = crumbs[i];
    const node = document.createElement("span");
    node.className = "crumb";
    node.innerHTML = `<span class="label">${c.label}</span><span>${escape(c.value)}</span>`;
    const close = document.createElement("button");
    close.type = "button";
    close.title = t.clear;
    close.textContent = "✕";
    close.addEventListener("click", c.clear);
    node.appendChild(close);
    host.appendChild(node);
  }
}

function renderByPlayerMode(replay: Replay) {
  clearStatsOnlyPanes();
  clearByMonsterOnlyPanes();
  clearDpsAnalysisOnlyPanes();
  const primary = $("#primary-pane");
  const secondary = $("#secondary-pane");
  const barPane = $("#bar-pane");
  const chartPane = $("#chart-pane");
  const skillPane = $("#skill-pane");
  barPane.innerHTML = "";

  primary.innerHTML = `<h2 class="section-title">${t.playersHeading}</h2>
    <p class="section-hint">${t.playersHint}</p>
    <div id="primary-table"></div>`;

  const players = playersWhoDamaged(replay);
  renderTable<PlayerAgg>(
    $("#primary-table"),
    [
      { key: "name", label: t.colPlayer },
      {
        key: "class",
        label: t.colClass,
        format: (r) => playerClass(replay, r.aid),
        sortValue: (r) => playerClass(replay, r.aid),
      },
      {
        key: "level",
        label: t.colLevel,
        numeric: true,
        format: (r) => {
          const l = playerLevel(replay, r.aid);
          return l ? String(l) : t.none;
        },
        sortValue: (r) => playerLevel(replay, r.aid),
      },
      { key: "totalDealt", label: t.colDamageDealt, numeric: true, format: (r) => fmt(r.totalDealt) },
      { key: "hits", label: t.colHits, numeric: true, format: (r) => fmt(r.hits) },
      ...(hasCritData(replay)
        ? [{ key: "crits", label: t.colCrits, numeric: true, format: (r: PlayerAgg) => fmt(r.crits) }]
        : []),
      { key: "misses", label: t.colMisses, numeric: true, format: (r) => fmt(r.misses) },
      { key: "monstersHit", label: t.colMonstersHit, numeric: true, format: (r) => fmt(r.monstersHit) },
      { key: "kills", label: t.colKills, numeric: true, format: (r) => fmt(r.kills) },
    ],
    players,
    {
      initialSort: { key: "totalDealt", asc: false },
      onRowClick: (row) => {
        // Plain click toggles the player in/out of the multi-select set.
        // Removing the last selected player also clears the monster
        // (we'd have nothing left to drill into). Use the breadcrumb ×
        // chips to deselect specific players when many are selected.
        if (state.selectedPlayers.has(row.aid)) {
          state.selectedPlayers.delete(row.aid);
          if (state.selectedPlayers.size === 0) state.selectedMonster = null;
        } else {
          state.selectedPlayers.add(row.aid);
        }
        rerender();
      },
      isSelected: (row) => state.selectedPlayers.has(row.aid),
    },
  );

  secondary.innerHTML = "";
  chartPane.innerHTML = "";
  skillPane.innerHTML = "";

  const primaryPlayer = primarySelectedPlayer();
  if (primaryPlayer === null) return;

  const playerLabel = playerName(replay, primaryPlayer);
  const monsters = monstersDamagedByPlayer(replay, primaryPlayer);

  secondary.innerHTML = `<h2 class="section-title">${escape(t.monstersDamagedBy(playerLabel))}</h2>
    <p class="section-hint">${t.monstersDamagedByHint}</p>
    <div id="secondary-table"></div>`;

  renderTable<MonsterAgg>(
    $("#secondary-table"),
    [
      {
        key: "view",
        label: t.colMobId,
        format: (r) => (r.view ? String(r.view) : t.none),
        href: (r) => (r.view ? mobDpUrl(r.view) : null),
      },
      {
        key: "name",
        label: t.colMonster,
        format: (r) => formatMonsterRow(r),
        sortValue: (r) => formatMonsterRow(r),
      },
      { key: "totalReceived", label: t.colDamage, numeric: true, format: (r) => fmt(r.totalReceived) },
      { key: "hits", label: t.colHits, numeric: true, format: (r) => fmt(r.hits) },
      {
        key: "maxHp",
        label: t.colMaxHp,
        numeric: true,
        format: (r) => {
          const hp = effectiveMaxHp(r.maxHp, r.view);
          return hp > 0 ? fmt(hp) : t.none;
        },
        sortValue: (r) => effectiveMaxHp(r.maxHp, r.view),
      },
      {
        key: "ttkMs",
        label: t.colTtk,
        numeric: true,
        format: (r) => (r.ttkMs == null ? t.none : `${(r.ttkMs / 1000).toFixed(1)} s`),
        sortValue: (r) => r.ttkMs ?? Number.POSITIVE_INFINITY,
      },
    ],
    monsters,
    {
      initialSort: { key: "totalReceived", asc: false },
      onRowClick: (row) => {
        if (state.selectedMonster !== row.aid) state.byPlayerCompareRange = null;
        state.selectedMonster = row.aid;
        state.selectedMobSkillTarget = null;
        rerender();
      },
      isSelected: (row) => row.aid === state.selectedMonster,
    },
  );

  if (state.selectedMonster === null) return;

  // Render N timeline cards (one per selected player) into chartPane,
  // then N skill tables into skillPane. Pane order in index.html stacks
  // all timelines first, then all skill tables — so when the user
  // multi-selects players for comparison, like-cards group together.
  const monsterAid = state.selectedMonster;
  const skillResolver = (id: number) =>
    id === 0 ? t.autoAttack : state.db?.resolveSkill(id) ?? t.skillFallback(id);

  // Lock all timeline cards to the same x + y scales so visual comparison
  // is honest. Walk every selected player's damage + skill-use events
  // once to find the union x range and the max damage value.
  let sharedXMin = Number.POSITIVE_INFINITY;
  let sharedXMax = Number.NEGATIVE_INFINITY;
  let sharedYMax = 0;
  for (const playerAid of state.selectedPlayers) {
    for (const d of replay.damage) {
      if (d.source !== playerAid || d.target !== monsterAid) continue;
      if (d.time < sharedXMin) sharedXMin = d.time;
      if (d.time > sharedXMax) sharedXMax = d.time;
      if (d.damage > sharedYMax) sharedYMax = d.damage;
    }
    for (const u of replay.skillUses) {
      if (u.source !== playerAid || u.target !== monsterAid) continue;
      if (u.time < sharedXMin) sharedXMin = u.time;
      if (u.time > sharedXMax) sharedXMax = u.time;
    }
  }
  const sharedXRange =
    sharedXMin <= sharedXMax
      ? { startMs: sharedXMin, endMs: sharedXMax }
      : null;
  const sharedYMaxOrNull = sharedYMax > 0 ? sharedYMax : null;

  for (const playerAid of state.selectedPlayers) {
    const events = replay.damage.filter(
      (d) => d.source === playerAid && d.target === monsterAid,
    );
    if (!events.length) continue;
    const card = document.createElement("section");
    card.className = "matchup-card";
    card.innerHTML = `<h2 class="section-title">${escape(
      t.matchupTimelineCardTitle(playerName(replay, playerAid)),
    )}</h2>`;
    const chartHost = document.createElement("div");
    chartHost.className = "stats-chart";
    card.appendChild(chartHost);
    chartPane.appendChild(card);
    const damage = events.map((d) => ({
      time: d.time,
      damage: d.damage,
      skillId: d.skillId,
      skillName: skillResolver(d.skillId),
    }));
    // Non-damage skill uses against the same monster (debuffs, heals on
    // undead, etc.) overlay as vertical markers — reuses the scatter's
    // chat-series slot, since semantically it's the same "event-at-time"
    // shape and we'd never show real chat alongside the matchup.
    const skillUseMarkers = replay.skillUses
      .filter((u) => u.source === playerAid && u.target === monsterAid)
      .map((u) => ({ time: u.time, message: skillResolver(u.skillId) }));
    renderDpsScatter(
      chartHost,
      { damage, chat: skillUseMarkers },
      {
        initialRange: state.byPlayerCompareRange,
        xRangeMs: sharedXRange,
        yMax: sharedYMaxOrNull,
        onSelect: (range) => {
          // Drag-select on any card mirrors to every other selected
          // player's card — share-the-window comparison. Dedupe equal
          // selections so we don't trigger a no-op rerender storm.
          const cur = state.byPlayerCompareRange;
          if (
            (cur === null && range === null) ||
            (cur && range && cur.startMs === range.startMs && cur.endMs === range.endMs)
          ) {
            return;
          }
          state.byPlayerCompareRange = range;
          rerender();
        },
      },
    );
  }

  for (const playerAid of state.selectedPlayers) {
    const events = replay.damage.filter(
      (d) => d.source === playerAid && d.target === monsterAid,
    );
    if (!events.length) continue;
    const card = document.createElement("section");
    card.className = "matchup-card";
    skillPane.appendChild(card);
    renderSkillTable(card, events, t.matchupSkillsCardTitle(playerName(replay, playerAid)));
  }
}

function renderByMonsterMode(replay: Replay) {
  clearStatsOnlyPanes();
  clearDpsAnalysisOnlyPanes();
  const primary = $("#primary-pane");
  const secondary = $("#secondary-pane");
  const barPane = $("#bar-pane");
  const chartPane = $("#chart-pane");
  const skillPane = $("#skill-pane");

  primary.innerHTML = `<h2 class="section-title">${t.monstersHeading}</h2>
    <p class="section-hint">${t.monstersHint}</p>
    <div id="primary-table"></div>`;

  const monsters = monstersWhoTookDamage(replay);
  renderTable<MonsterAgg>(
    $("#primary-table"),
    [
      {
        key: "view",
        label: t.colMobId,
        format: (r) => (r.view ? String(r.view) : t.none),
        href: (r) => (r.view ? mobDpUrl(r.view) : null),
      },
      {
        key: "name",
        label: t.colMonster,
        format: (r) => formatMonsterRow(r),
        sortValue: (r) => formatMonsterRow(r),
      },
      { key: "totalReceived", label: t.colDamageTaken, numeric: true, format: (r) => fmt(r.totalReceived) },
      { key: "hits", label: t.colHits, numeric: true, format: (r) => fmt(r.hits) },
      { key: "attackers", label: t.colAttackers, numeric: true, format: (r) => fmt(r.attackers) },
      {
        key: "maxHp",
        label: t.colMaxHp,
        numeric: true,
        format: (r) => {
          const hp = effectiveMaxHp(r.maxHp, r.view);
          return hp > 0 ? fmt(hp) : t.none;
        },
        sortValue: (r) => effectiveMaxHp(r.maxHp, r.view),
      },
      {
        key: "ttkMs",
        label: t.colTtk,
        numeric: true,
        format: (r) => (r.ttkMs == null ? t.none : `${(r.ttkMs / 1000).toFixed(1)} s`),
        sortValue: (r) => r.ttkMs ?? Number.POSITIVE_INFINITY,
      },
    ],
    monsters,
    {
      initialSort: { key: "totalReceived", asc: false },
      onRowClick: (row) => {
        state.selectedMonster = row.aid;
        state.selectedMobSkillTarget = null;
        rerender();
      },
      isSelected: (row) => row.aid === state.selectedMonster,
    },
  );

  secondary.innerHTML = "";
  barPane.innerHTML = "";
  chartPane.innerHTML = "";
  skillPane.innerHTML = "";
  clearByMonsterOnlyPanes();

  if (state.selectedMonster === null) return;

  renderMonsterOverview(replay, state.selectedMonster);

  const monsterLabel = monsterName(replay, state.selectedMonster);
  const events = replay.damage.filter((d) => d.target === state.selectedMonster);
  // Damage events whose source is a known player-affiliated entity (pc /
  // homun / merc). Mob-on-mob splash from instance hordes ends up in `events`
  // too, but it isn't useful in the per-player chart or skill table.
  const playerEvents = events.filter((d) => isPlayerSource(replay, d.source));
  const players = playersThatDamaged(replay, state.selectedMonster);

  secondary.innerHTML = `<h2 class="section-title">${escape(t.playersWhoDamaged(monsterLabel))}</h2>
    <div id="secondary-table"></div>`;

  renderTable<PlayerAgg>(
    $("#secondary-table"),
    [
      { key: "name", label: t.colPlayer },
      {
        key: "class",
        label: t.colClass,
        format: (r) => playerClass(replay, r.aid),
        sortValue: (r) => playerClass(replay, r.aid),
      },
      {
        key: "level",
        label: t.colLevel,
        numeric: true,
        format: (r) => {
          const l = playerLevel(replay, r.aid);
          return l ? String(l) : t.none;
        },
        sortValue: (r) => playerLevel(replay, r.aid),
      },
      { key: "totalDealt", label: t.colDamageDealt, numeric: true, format: (r) => fmt(r.totalDealt) },
      { key: "hits", label: t.colHits, numeric: true, format: (r) => fmt(r.hits) },
      ...(hasCritData(replay)
        ? [{ key: "crits", label: t.colCrits, numeric: true, format: (r: PlayerAgg) => fmt(r.crits) }]
        : []),
      { key: "misses", label: t.colMisses, numeric: true, format: (r) => fmt(r.misses) },
      { key: "kills", label: t.colKillingBlow, numeric: true, format: (r) => fmt(r.kills) },
    ],
    players,
    { initialSort: { key: "totalDealt", asc: false } },
  );

  if (events.length) {
    barPane.innerHTML = `<h2 class="section-title">${t.damageByPlayerTitle}</h2>
      <p class="section-hint">${t.damageByPlayerHint(monsterLabel)}</p>
      <div id="dps-bars"></div>`;

    const bars = players.map((p) => ({
      key: p.aid,
      label: p.name,
      value: p.totalDealt,
      display: fmt(p.totalDealt),
    }));
    renderBarChart($("#dps-bars"), bars);
  }

  const bucketMs = pickBucketMs(playerEvents);
  chartPane.innerHTML = `<h2 class="section-title">${t.damageOverTimeMultiTitle}</h2>
    <div id="dps-chart"></div>`;
  renderDamageMulti(
    $("#dps-chart"),
    damageTimelineMulti(replay, playerEvents, bucketMs),
  );

  renderMobHpCurve(replay, state.selectedMonster);
  renderSkillByPlayerTable(skillPane, playerEvents, t.skillsAgainstMonster);
  renderMobVictims(replay, state.selectedMonster, monsterLabel);
  renderMobSkills(replay, state.selectedMonster, monsterLabel);
}

function renderMonsterOverview(replay: Replay, mobAid: number) {
  const host = $("#monster-overview-pane");
  const ent = replay.entities.get(mobAid);
  if (!ent) {
    host.innerHTML = "";
    return;
  }

  // Aggregate damage in/out and the social facts in a single pass.
  let totalReceived = 0;
  let totalDealt = 0;
  const attackers = new Set<number>();
  const victims = new Set<number>();
  const victimDamage = new Map<number, number>();
  for (const d of replay.damage) {
    if (d.target === mobAid) {
      totalReceived += d.damage;
      if (isPlayerSource(replay, d.source)) attackers.add(d.source);
    }
    if (d.source === mobAid && isPlayerSource(replay, d.target)) {
      totalDealt += d.damage;
      victims.add(d.target);
      victimDamage.set(d.target, (victimDamage.get(d.target) ?? 0) + d.damage);
    }
  }

  let topVictim: { aid: number; name: string; total: number } | null = null;
  for (const [aid, total] of victimDamage) {
    if (!topVictim || total > topVictim.total) {
      const v = replay.entities.get(aid);
      topVictim = { aid, name: v?.name || `#${aid}`, total };
    }
  }

  const kill = replay.kills.find((k) => k.aid === mobAid && k.kind === 1);
  const killTime = kill?.time ?? null;
  const timeAliveMs =
    killTime != null
      ? Math.max(0, killTime - ent.firstSeenMs)
      : Math.max(0, replay.sessionInfo.durationMs - ent.firstSeenMs);
  const ttkMs = killTime != null ? killTime - ent.firstSeenMs : null;

  let killer: { aid: number; name: string } | null = null;
  if (killTime != null) {
    const lastHit = lastDamageBeforeFromPlayer(replay, mobAid, killTime);
    if (lastHit) {
      const k = replay.entities.get(lastHit.source);
      killer = { aid: lastHit.source, name: k?.name || `#${lastHit.source}` };
    }
  }

  const maxHp = effectiveMaxHp(ent.maxHp, ent.view);
  const speciesName = monsterName(replay, mobAid);
  const speciesValue = ent.view
    ? `<a class="cell-link" href="${escape(mobDpUrl(ent.view))}" target="_blank" rel="noopener noreferrer">#${ent.view}</a> · ${escape(speciesName)}`
    : escape(speciesName);

  const cells: SummaryCell[] = [
    { label: t.cellSpecies, value: speciesValue, valueIsHtml: true },
    { label: t.colLevel, value: ent.level ? String(ent.level) : t.none },
    {
      label: t.cellMobMaxHp,
      value: maxHp > 0 ? fmt(maxHp) : t.none,
    },
    {
      label: t.cellBoss,
      value: ent.isBoss ? t.bossMark : t.none,
    },
    {
      label: t.cellTimeAlive,
      value: timeAliveMs ? formatDuration(timeAliveMs) : t.none,
    },
    {
      label: t.cellMobTtk,
      value: ttkMs != null ? formatDuration(ttkMs) : t.none,
    },
    {
      label: t.cellKilledBy,
      value: killer ? killer.name : t.none,
    },
    {
      label: t.cellMobDamageReceived,
      value: fmt(totalReceived),
      hint: maxHp > 0 ? `${pct(totalReceived, maxHp)}% do HP máx.` : undefined,
    },
    {
      label: t.cellMobAttackers,
      value: fmt(attackers.size),
    },
    {
      label: t.cellMobDamageDealt,
      value: fmt(totalDealt),
    },
    {
      label: t.cellMobVictims,
      value: fmt(victims.size),
    },
    {
      label: t.cellMobTopVictim,
      value: topVictim ? topVictim.name : t.none,
      hint: topVictim ? fmt(topVictim.total) : undefined,
    },
  ];

  renderSummaryCard(host, t.mobOverviewTitle, cells);
}

function lastDamageBeforeFromPlayer(
  replay: Replay,
  targetAid: number,
  byTime: number,
): DamageEvent | null {
  let best: DamageEvent | null = null;
  for (const ev of replay.damage) {
    if (ev.target !== targetAid) continue;
    if (ev.time > byTime) continue;
    if (!isPlayerSource(replay, ev.source)) continue;
    if (!best || ev.time > best.time) best = ev;
  }
  return best;
}

function renderMobHpCurve(replay: Replay, mobAid: number) {
  const host = $("#hp-curve-pane");
  const ent = replay.entities.get(mobAid);
  // Only show the curve if the server actually reported HP at some point
  // (either the spawn packet carried a real maxHp, or there is at least one
  // mobHp snapshot). Otherwise the chart degenerates to a straight line
  // from "full HP" to 0 at vanish time — purely decorative and misleading,
  // even if Divine Pride happens to know a max HP for the species.
  const hasServerSamples = replay.mobHp.some((m) => m.aid === mobAid);
  const serverMaxHp = ent && ent.maxHp > 0 ? ent.maxHp : 0;
  if (!hasServerSamples && serverMaxHp <= 0) {
    host.innerHTML = "";
    return;
  }
  const fallbackMax = ent ? effectiveMaxHp(ent.maxHp, ent.view) : 0;
  const series = mobHpCurve(replay, mobAid, fallbackMax);
  if (!series.ts.length) {
    host.innerHTML = "";
    return;
  }
  const maxValues = series.maxHp.map((m) => (m > 0 ? m : fallbackMax));

  host.innerHTML = `<h2 class="section-title">${t.hpCurveTitle}</h2>
    <div id="hp-curve-chart" class="stats-chart"></div>`;
  renderLineChart(
    $("#hp-curve-chart"),
    series.ts,
    [
      { label: t.hpSeriesLabel, values: series.hp, paletteIndex: 6 },
      { label: t.hpMaxSeriesLabel, values: maxValues, paletteIndex: 7 },
    ],
    { height: 220 },
  );
}

function renderMobVictims(
  replay: Replay,
  mobAid: number,
  monsterLabel: string,
) {
  const host = $("#mob-victims-pane");
  const victims = playersDamagedByMonster(replay, mobAid);
  if (!victims.length) {
    host.innerHTML = `<section class="stats-card"><h2 class="section-title">${escape(t.mobVictimsTitle(monsterLabel))}</h2><p class="section-hint">${t.mobNeverAttackedHint}</p></section>`;
    return;
  }

  const hasCrits = hasCritData(replay);

  host.innerHTML = `<h2 class="section-title">${escape(t.mobVictimsTitle(monsterLabel))}</h2>
    <div id="mob-victims-table"></div>
    <h2 class="section-title" style="margin-top:1rem">${escape(t.mobVictimsBarTitle(monsterLabel))}</h2>
    <div id="mob-victims-bars"></div>`;

  renderTable<PlayerAgg>(
    $("#mob-victims-table"),
    [
      { key: "name", label: t.colPlayer },
      {
        key: "class",
        label: t.colClass,
        format: (r) => playerClass(replay, r.aid),
        sortValue: (r) => playerClass(replay, r.aid),
      },
      {
        key: "level",
        label: t.colLevel,
        numeric: true,
        format: (r) => {
          const l = playerLevel(replay, r.aid);
          return l ? String(l) : t.none;
        },
        sortValue: (r) => playerLevel(replay, r.aid),
      },
      {
        key: "totalDealt",
        label: t.colDamageTaken,
        numeric: true,
        format: (r) => fmt(r.totalDealt),
      },
      { key: "hits", label: t.colHits, numeric: true, format: (r) => fmt(r.hits) },
      ...(hasCrits
        ? [{ key: "crits", label: t.colCrits, numeric: true, format: (r: PlayerAgg) => fmt(r.crits) }]
        : []),
      { key: "misses", label: t.colMisses, numeric: true, format: (r) => fmt(r.misses) },
      {
        key: "kills",
        label: t.colKillingBlow,
        numeric: true,
        format: (r) => fmt(r.kills),
      },
    ],
    victims,
    { initialSort: { key: "totalDealt", asc: false } },
  );

  renderBarChart(
    $("#mob-victims-bars"),
    victims.map((v) => ({
      key: v.aid,
      label: v.name,
      value: v.totalDealt,
      display: fmt(v.totalDealt),
    })),
  );
}

function renderMobSkills(
  replay: Replay,
  mobAid: number,
  monsterLabel: string,
) {
  const host = $("#mob-skills-pane");
  const skillResolver = (id: number) =>
    id === 0 ? t.autoAttack : state.db?.resolveSkill(id) ?? t.skillFallback(id);

  // Build the per-victim filter list from the players this mob actually hit.
  const victims = playersDamagedByMonster(replay, mobAid);
  const validTargetAids = new Set(victims.map((v) => v.aid));

  // Drop a stale filter if the user switched mobs — the previously-selected
  // player may not be a victim of the new one.
  if (
    state.selectedMobSkillTarget != null &&
    !validTargetAids.has(state.selectedMobSkillTarget)
  ) {
    state.selectedMobSkillTarget = null;
  }

  const rows = mobSkillBreakdown(
    replay,
    mobAid,
    skillResolver,
    state.selectedMobSkillTarget ?? undefined,
  );

  if (!rows.length && !victims.length) {
    host.innerHTML = `<section class="stats-card"><h2 class="section-title">${escape(t.mobSkillsTitle(monsterLabel))}</h2><p class="section-hint">${t.mobNoSkillsHint}</p></section>`;
    return;
  }

  // Build the filter `<select>` markup. "Todos os alvos" resets to no filter.
  const opts = [
    `<option value="">${escape(t.mobSkillsFilterAll)}</option>`,
    ...victims.map(
      (v) =>
        `<option value="${v.aid}"${
          state.selectedMobSkillTarget === v.aid ? " selected" : ""
        }>${escape(v.name)}</option>`,
    ),
  ].join("");

  host.innerHTML = `<h2 class="section-title">${escape(t.mobSkillsTitle(monsterLabel))}</h2>
    <p class="section-hint">${t.mobSkillsHint}</p>
    <div class="mob-skills-filter">
      <label for="mob-skills-target">${t.mobSkillsFilterLabel}</label>
      <select id="mob-skills-target">${opts}</select>
    </div>
    <div id="mob-skills-table"></div>`;

  $<HTMLSelectElement>("#mob-skills-target").addEventListener("change", (e) => {
    const v = (e.currentTarget as HTMLSelectElement).value;
    state.selectedMobSkillTarget = v ? Number(v) : null;
    rerender();
  });

  if (!rows.length) {
    $("#mob-skills-table").innerHTML = `<p class="section-hint">${t.mobSkillsNoneForTarget}</p>`;
    return;
  }

  renderTable<MobSkillAgg>(
    $("#mob-skills-table"),
    [
      {
        key: "skillId",
        label: t.colId,
        format: (r) => (r.skillId ? String(r.skillId) : t.none),
        href: (r) => (r.skillId ? skillDpUrl(r.skillId) : null),
      },
      { key: "name", label: t.colSkill },
      { key: "hits", label: t.colHits, numeric: true, format: (r) => fmt(r.hits) },
      {
        key: "totalDamage",
        label: t.colTotalDamage,
        numeric: true,
        format: (r) => fmt(r.totalDamage),
      },
      {
        key: "avgDamage",
        label: t.colAvgDamage,
        numeric: true,
        format: (r) => fmt(r.avgDamage),
      },
      {
        key: "noDamageUses",
        label: t.colNoDamageUses,
        numeric: true,
        format: (r) => fmt(r.noDamageUses),
      },
      {
        key: "distinctTargets",
        label: t.colDistinctTargets,
        numeric: true,
        format: (r) => fmt(r.distinctTargets),
      },
      {
        key: "avgCastMs",
        label: t.colAvgCast,
        numeric: true,
        format: (r) => (r.avgCastMs == null ? t.none : `${r.avgCastMs} ms`),
        sortValue: (r) => r.avgCastMs ?? -1,
      },
    ],
    rows,
    { initialSort: { key: "totalDamage", asc: false } },
  );
}

function renderSkillTable(host: HTMLElement, events: DamageEvent[], title: string) {
  if (!events.length) {
    host.innerHTML = "";
    return;
  }
  host.innerHTML = `<h2 class="section-title">${escape(title)}</h2>`;
  const tableHost = document.createElement("div");
  host.appendChild(tableHost);
  const skillResolver = (id: number) =>
    id === 0 ? t.autoAttack : state.db?.resolveSkill(id) ?? t.skillFallback(id);
  const rows = bySkill(events, state.replay!.skillCasts, skillResolver);
  renderTable(
    tableHost,
    [
      {
        key: "skillId",
        label: t.colId,
        format: (r) => (r.skillId ? String(r.skillId) : t.none),
        href: (r) => (r.skillId ? skillDpUrl(r.skillId) : null),
      },
      { key: "name", label: t.colSkill },
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
    ],
    rows,
    { initialSort: { key: "totalDamage", asc: false } },
  );
}

function renderSkillByPlayerTable(
  host: HTMLElement,
  events: DamageEvent[],
  title: string,
) {
  if (!events.length) {
    host.innerHTML = "";
    return;
  }
  host.innerHTML = `<h2 class="section-title">${escape(title)}</h2>
    <div id="skill-table"></div>`;
  const skillResolver = (id: number) =>
    id === 0 ? t.autoAttack : state.db?.resolveSkill(id) ?? t.skillFallback(id);
  const rows = bySkillAndPlayer(state.replay!, events, skillResolver);
  renderTable(
    $("#skill-table"),
    [
      {
        key: "skillId",
        label: t.colId,
        format: (r) => (r.skillId ? String(r.skillId) : t.none),
        href: (r) => (r.skillId ? skillDpUrl(r.skillId) : null),
      },
      { key: "name", label: t.colSkill },
      { key: "playerName", label: t.colPlayer },
      {
        key: "class",
        label: t.colClass,
        format: (r) => playerClass(state.replay!, r.playerAid),
        sortValue: (r) => playerClass(state.replay!, r.playerAid),
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
    ],
    rows,
    { initialSort: { key: "totalDamage", asc: false } },
  );
}

function renderSummary(replay: Replay) {
  const totalDmg = replay.damage.reduce((s, e) => s + e.damage, 0);
  const seconds = replay.sessionInfo.durationMs / 1000;
  const dps = seconds > 0 ? totalDmg / seconds : 0;

  $("#summary").innerHTML = `
    <h2>${t.sessionTitle}</h2>
    <div class="summary-grid">
      <div><span>${t.player}</span><span>${escape(replay.sessionInfo.player) || t.none}</span></div>
      <div><span>${t.map}</span><span>${escape(replay.sessionInfo.map) || t.none}</span></div>
      <div><span>${t.recordedAt}</span><span>${replay.sessionInfo.recordedAt.toLocaleString(locale)}</span></div>
      <div><span>${t.duration}</span><span>${formatDuration(replay.sessionInfo.durationMs)}</span></div>
      <div><span>${t.totalDamage}</span><span>${fmt(totalDmg)}</span></div>
      <div><span>${t.avgDps}</span><span>${fmt(Math.round(dps))}</span></div>
      <div><span>${t.damageEvents}</span><span>${fmt(replay.damage.length)}</span></div>
      <div><span>${t.kills}</span><span>${fmt(replay.kills.length)}</span></div>
      <div><span>${t.entitiesSeen}</span><span>${fmt(replay.entities.size)}</span></div>
      <div><span>${t.packetsParsed}</span><span>${fmt(replay.totals.handledPackets)} / ${fmt(replay.totals.packetCount)}</span></div>
    </div>
  `;
}

function formatMonsterRow(row: MonsterAgg): string {
  const display = state.replay
    ? monsterName(state.replay, row.aid)
    : row.name || t.mobFallback(row.view || row.aid);
  return row.isBoss ? `${display}  ${t.bossMark}` : display;
}

function fmt(n: number): string {
  return n.toLocaleString(locale);
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]!);
}

function formatDuration(ms: number): string {
  if (!ms) return t.none;
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}h ${m}m ${s}s`
    : m > 0
      ? `${m}m ${s}s`
      : `${s}s`;
}

function pickBucketMs(events: DamageEvent[]): number {
  if (!events.length) return 1000;
  const span = events[events.length - 1].time - events[0].time;
  if (span <= 30_000) return 1_000;
  if (span <= 120_000) return 2_000;
  if (span <= 600_000) return 5_000;
  if (span <= 1_800_000) return 15_000;
  return 30_000;
}

// ---------------------------------------------------------------------------
// Recent replays list (home view)
// ---------------------------------------------------------------------------

function buildReplaySummary(replay: Replay): ReplaySummary {
  const totalDamage = replay.damage.reduce((s, e) => s + e.damage, 0);
  const seconds = replay.sessionInfo.durationMs / 1000;
  const avgDps = seconds > 0 ? Math.round(totalDamage / seconds) : 0;
  // Mob-name resolver from the DP DB if loaded; otherwise fall back to the
  // `mob#<view>` placeholder — the aggregator will then prefer the
  // server-reported per-instance name when available. Job resolver is the
  // same story; the aggregator will leave `class` empty if it returns the
  // `job#<id>` placeholder.
  const resolveMob = state.db
    ? (id: number) => state.db!.resolveMob(id)
    : (id: number) => `mob#${id}`;
  const resolveJob = state.db
    ? (id: number) => state.db!.resolveJob(id)
    : (id: number) => `job#${id}`;
  return {
    player: replay.sessionInfo.player || "",
    map: replay.sessionInfo.map || "",
    recordedAt: replay.sessionInfo.recordedAt,
    durationMs: replay.sessionInfo.durationMs,
    totalDamage,
    avgDps,
    damageEvents: replay.damage.length,
    kills: replay.kills.length,
    entitiesSeen: replay.entities.size,
    handledPackets: replay.totals.handledPackets,
    packetCount: replay.totals.packetCount,
    mvpRecords: mvpMatchups(replay, resolveMob, resolveJob),
  };
}

function setupRecentReplayFilters() {
  const playerEl = document.querySelector<HTMLInputElement>(
    "#recent-replays-filter-player",
  );
  const mapEl = document.querySelector<HTMLInputElement>(
    "#recent-replays-filter-map",
  );
  const clearEl = document.querySelector<HTMLButtonElement>(
    "#recent-replays-filter-clear",
  );
  if (!playerEl || !mapEl || !clearEl) return;
  // Filtering is purely client-side over the already-loaded set, so each
  // keystroke just resets the page slice and repaints. No round-trip.
  playerEl.addEventListener("input", () => {
    state.recent.playerFilter = playerEl.value;
    state.recent.pageIndex = 0;
    paintRecentReplays();
  });
  mapEl.addEventListener("input", () => {
    state.recent.mapFilter = mapEl.value;
    state.recent.pageIndex = 0;
    paintRecentReplays();
  });
  clearEl.addEventListener("click", () => {
    state.recent.playerFilter = "";
    state.recent.mapFilter = "";
    playerEl.value = "";
    mapEl.value = "";
    state.recent.pageIndex = 0;
    paintRecentReplays();
  });
}

async function loadRecentReplays() {
  const host = $("#recent-replays");
  if (state.recent.loading) return;
  if (state.route !== "home" || state.replay) return;
  // Cache-aware: if the shared cache is fresh, paint instantly with no
  // loading state. Otherwise fall through to the async path and show the
  // spinner while the bulk fetch is in flight.
  if (isSummariesCacheFresh()) {
    state.recent.items = getCachedSummaries();
    state.recent.error = null;
    host.hidden = false;
    paintRecentReplays();
    return;
  }
  state.recent.loading = true;
  state.recent.error = null;
  paintRecentReplays();
  host.hidden = false;
  try {
    state.recent.items = await ensureSummariesLoaded();
  } catch (err) {
    console.error(err);
    state.recent.error = (err as Error).message;
  } finally {
    state.recent.loading = false;
    paintRecentReplays();
  }
}

/**
 * Case-insensitive substring match on player + map across the full loaded
 * set. Both filters apply (AND) when both are non-empty.
 */
function filterRecentItems(): ReplayListItem[] {
  const p = state.recent.playerFilter.trim().toLowerCase();
  const m = state.recent.mapFilter.trim().toLowerCase();
  if (!p && !m) return state.recent.items;
  return state.recent.items.filter((it) => {
    if (p && !(it.player ?? "").toLowerCase().includes(p)) return false;
    if (m && !(it.map ?? "").toLowerCase().includes(m)) return false;
    return true;
  });
}

function paintRecentReplays() {
  const host = $("#recent-replays");
  // If the user has loaded a replay since the fetch started, or navigated
  // off the home route, don't take the page back over.
  if (state.replay || state.route !== "home") {
    host.hidden = true;
    return;
  }
  $("#recent-replays-title").textContent = t.recentReplaysTitle;

  const hasAnyFilter =
    !!state.recent.playerFilter.trim() || !!state.recent.mapFilter.trim();
  const filtered = filterRecentItems();

  // Hint never says "loading" — the spinner up top owns that signal. Only
  // when we have no items at all do we surface "Carregando…" so the empty
  // section doesn't look broken on first paint.
  let hint: string;
  if (state.recent.error) hint = t.recentReplaysError(state.recent.error);
  else if (!state.recent.items.length && state.recent.loading) {
    hint = t.recentReplaysLoading;
  } else if (!filtered.length) {
    hint = hasAnyFilter ? t.recentReplaysNoMatch : t.recentReplaysEmpty;
  } else hint = t.recentReplaysHint;
  $("#recent-replays-hint").textContent = hint;

  $<HTMLButtonElement>("#recent-replays-filter-clear").disabled = !hasAnyFilter;
  $("#recent-replays-loading-indicator").hidden = !state.recent.loading;

  // Only swap the list DOM when results have landed — during loading the
  // previous render stays in place so the section doesn't flicker.
  if (!state.recent.loading) {
    const listEl = $("#recent-replays-list");
    listEl.innerHTML = "";
    if (!state.recent.error) {
      const start = state.recent.pageIndex * RECENT_PAGE_SIZE;
      const page = filtered.slice(start, start + RECENT_PAGE_SIZE);
      for (const item of page) {
        listEl.appendChild(buildRecentRow(item));
      }
    }
  }

  paintRecentPagination(filtered.length);
}

function buildRecentRow(item: ReplayListItem): HTMLElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "recent-replays-row";
  row.addEventListener("click", () => openRecentReplay(item.id));

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
    {
      label: t.totalDamage,
      value: item.totalDamage != null ? fmt(item.totalDamage) : t.none,
    },
    {
      label: t.kills,
      value: item.kills != null ? fmt(item.kills) : t.none,
    },
    {
      label: t.colUploadedAt,
      value: item.uploadedAt ? item.uploadedAt.toLocaleString(locale) : t.none,
    },
  ];

  for (const c of cells) {
    const cell = document.createElement("div");
    const label = document.createElement("span");
    label.className = "recent-replays-cell-label";
    label.textContent = c.label;
    const value = document.createElement("span");
    value.className = "recent-replays-cell-value";
    value.textContent = c.value;
    cell.appendChild(label);
    cell.appendChild(value);
    row.appendChild(cell);
  }
  return row;
}

function paintRecentPagination(filteredCount: number) {
  const host = $("#recent-replays-pagination");
  host.innerHTML = "";
  if (state.recent.error || state.recent.loading) return;
  if (!filteredCount && state.recent.pageIndex === 0) return;

  const pageCount = Math.max(1, Math.ceil(filteredCount / RECENT_PAGE_SIZE));
  // Clamp pageIndex in case a fresh filter shrank the list past the active
  // page (e.g. user paginates to page 4, types a filter with only 2 pages).
  if (state.recent.pageIndex >= pageCount) {
    state.recent.pageIndex = pageCount - 1;
  }
  const hasMore = state.recent.pageIndex < pageCount - 1;

  const prev = document.createElement("button");
  prev.type = "button";
  prev.textContent = t.paginationPrev;
  prev.disabled = state.recent.pageIndex === 0;
  prev.addEventListener("click", () => {
    if (state.recent.pageIndex === 0) return;
    state.recent.pageIndex -= 1;
    paintRecentReplays();
  });

  const indicator = document.createElement("span");
  indicator.className = "recent-replays-page-indicator";
  indicator.textContent = t.paginationPageOf(state.recent.pageIndex + 1);

  const next = document.createElement("button");
  next.type = "button";
  next.textContent = t.paginationNext;
  next.disabled = !hasMore;
  next.addEventListener("click", () => {
    if (!hasMore) return;
    state.recent.pageIndex += 1;
    paintRecentReplays();
  });

  host.appendChild(prev);
  host.appendChild(indicator);
  host.appendChild(next);
}

function openRecentReplay(id: string) {
  const url = new URL(location.href);
  url.searchParams.set("r", id);
  history.pushState(null, "", url.toString());
  $("#recent-replays").hidden = true;
  void loadFromUrl();
}

// ---------------------------------------------------------------------------
// Análise de DPS — drag-selectable scatter of player damage + own-chat events
// ---------------------------------------------------------------------------

function renderDpsAnalysisMode(replay: Replay) {
  clearByModeOnlyPanes();
  clearByMonsterOnlyPanes();
  clearStatsOnlyPanes();
  // The #primary/#secondary/#bar/#chart panes are owned by the other three
  // modes (Estatísticas / Por jogador / Por monstro). Clear them too so the
  // previous tab's cards don't bleed into Análise de DPS.
  $("#primary-pane").innerHTML = "";
  $("#secondary-pane").innerHTML = "";
  $("#bar-pane").innerHTML = "";
  $("#chart-pane").innerHTML = "";
  $("#skill-pane").innerHTML = "";
  $("#breadcrumb").hidden = true;

  renderDpsAnalysisHelp();
  renderDpsAnalysisChart(replay);
  renderDpsAnalysisStats(replay);
}

function renderDpsAnalysisHelp() {
  const host = $("#dps-analysis-help-pane");
  const range = state.dpsAnalysisRange;
  const rangeChip = range
    ? `<span class="muted small" style="margin-left:0.75rem">${escape(t.dpsAnalysisRangeLabel(formatDuration(range.startMs), formatDuration(range.endMs)))}</span>`
    : "";
  host.innerHTML = `
    <section class="stats-card">
      <h2>${t.dpsAnalysisHelpTitle}${rangeChip}</h2>
      <p><strong>${escape(t.dpsAnalysisHelpHowToUse)}</strong> ${escape(t.dpsAnalysisHelpHowToUseBody)}</p>
      <p><strong>${escape(t.dpsAnalysisHelpDpsCalc)}</strong> ${escape(t.dpsAnalysisHelpDpsCalcBody)}</p>
      <p><strong>${escape(t.dpsAnalysisHelpTimeMetrics)}</strong> ${escape(t.dpsAnalysisHelpTimeMetricsBody)}</p>
      <button type="button" id="dps-analysis-clear" class="share-btn"${range ? "" : " disabled"}>${t.dpsAnalysisClearSelection}</button>
    </section>
  `;
  const btn = document.querySelector<HTMLButtonElement>("#dps-analysis-clear");
  btn?.addEventListener("click", () => {
    if (!state.dpsAnalysisRange) return;
    state.dpsAnalysisRange = null;
    rerender();
  });
}

function renderDpsAnalysisChart(replay: Replay) {
  const host = $("#dps-analysis-chart-pane");
  const aid = replay.sessionInfo.aid;
  const skillResolver = (id: number) =>
    id === 0 ? t.autoAttack : state.db?.resolveSkill(id) ?? t.skillFallback(id);

  const damage = replay.damage
    .filter((d) => d.source === aid)
    .map((d) => ({
      time: d.time,
      damage: d.damage,
      skillId: d.skillId,
      skillName: skillResolver(d.skillId),
    }));
  // Server prepends "<playerName> : " to every echoed self-chat. Drop that
  // prefix so the tooltip just shows the message text.
  const playerPrefix = `${replay.sessionInfo.player} : `;
  const stripPrefix = (msg: string) =>
    msg.startsWith(playerPrefix) ? msg.slice(playerPrefix.length) : msg;
  const chat = replay.chats.map((c) => ({
    time: c.time,
    message: stripPrefix(c.message),
  }));

  if (!damage.length) {
    host.innerHTML = `<section class="stats-card"><h2>${t.dpsAnalysisChartTitle}</h2><p class="section-hint">${t.dpsAnalysisEmpty}</p></section>`;
    return;
  }

  host.innerHTML = `
    <section class="stats-card">
      <h2 class="section-title">${t.dpsAnalysisChartTitle}</h2>
      <div id="dps-analysis-chart" class="stats-chart"></div>
      <div class="dps-analysis-legend">
        <span class="dps-analysis-legend-dot dps-analysis-legend-dot--damage"></span>${t.dpsAnalysisDamageSeries}
        <span class="dps-analysis-legend-dot dps-analysis-legend-dot--chat"></span>${t.dpsAnalysisChatSeries}
      </div>
    </section>
  `;
  renderDpsScatter(
    $("#dps-analysis-chart"),
    { damage, chat },
    {
      initialRange: state.dpsAnalysisRange,
      onSelect: (range) => {
        const cur = state.dpsAnalysisRange;
        if (
          (cur === null && range === null) ||
          (cur && range && cur.startMs === range.startMs && cur.endMs === range.endMs)
        ) {
          return;
        }
        state.dpsAnalysisRange = range;
        rerender();
      },
    },
  );
}

function renderDpsAnalysisStats(replay: Replay) {
  const host = $("#dps-analysis-stats-pane");
  const aid = replay.sessionInfo.aid;
  const hasPlayerDamage = replay.damage.some((d) => d.source === aid);
  if (!hasPlayerDamage) {
    host.innerHTML = "";
    return;
  }
  const skillResolver = (id: number) =>
    id === 0 ? t.autoAttack : state.db?.resolveSkill(id) ?? t.skillFallback(id);
  const stats = dpsAnalysisStats(replay, state.dpsAnalysisRange, skillResolver);

  const cells: SummaryCell[] = [
    { label: t.cellSelectionDuration, value: formatDuration(stats.selectionDurationMs) },
    { label: t.cellEventsInWindow, value: fmt(stats.events) },
    { label: t.totalDamage, value: fmt(stats.totalDamage) },
    {
      label: t.cellCombatSpan,
      value: stats.combatSpanMs > 0 ? formatDuration(stats.combatSpanMs) : t.none,
      hint: t.cellCombatSpanHint,
    },
    {
      label: t.cellWindowDps,
      value: stats.dps > 0 ? fmt(stats.dps) : t.none,
    },
    {
      label: t.cellMeanInterval,
      value:
        stats.meanIntervalMs == null
          ? t.none
          : `${Math.round(stats.meanIntervalMs)} ms`,
    },
    {
      label: t.cellHighestSingleHit,
      value: stats.highestHit > 0 ? fmt(stats.highestHit) : t.none,
    },
    {
      label: t.cellAverageHit,
      value: stats.averageHit > 0 ? fmt(stats.averageHit) : t.none,
    },
    {
      label: t.cellLongestGap,
      value: stats.longestGapMs > 0 ? `${Math.round(stats.longestGapMs)} ms` : t.none,
    },
    { label: t.cellDistinctSkills, value: fmt(stats.distinctSkills) },
    {
      label: t.cellTopSkillWindow,
      value: stats.topSkillName ?? t.none,
      hint: stats.topSkillId == null ? undefined : fmt(stats.topSkillDamage),
    },
  ];

  renderSummaryCard(host, t.dpsAnalysisStatsTitle, cells);
}

// ---------------------------------------------------------------------------
// Suggestions / comments
// ---------------------------------------------------------------------------

const SUGGESTION_VOTES_KEY = "ragnarecap.suggestionVotes";

type LocalVoteMap = Record<string, "up" | "down">;

// Single-cookie dedup: persists across sessions, survives clearing the tab
// state. Not a real auth boundary — the user can wipe storage and vote
// again, which is fine per the product brief.
function readVotes(): LocalVoteMap {
  try {
    const raw = localStorage.getItem(SUGGESTION_VOTES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as LocalVoteMap) : {};
  } catch {
    return {};
  }
}

function writeVote(id: string, dir: "up" | "down") {
  try {
    const votes = readVotes();
    votes[id] = dir;
    localStorage.setItem(SUGGESTION_VOTES_KEY, JSON.stringify(votes));
  } catch {
    // localStorage may be unavailable (Safari private mode, quotas) — silently
    // accept the vote loss; the user can vote again next session.
  }
}

function setupSuggestionsForm() {
  const form = document.querySelector<HTMLFormElement>("#suggestions-form");
  if (!form) return;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>("#suggestions-input");
    const text = input.value.trim();
    if (!text || state.suggestions.posting) return;
    void submitSuggestion(text);
  });
}

async function loadSuggestions() {
  if (state.suggestions.loading) return;
  state.suggestions.loading = true;
  state.suggestions.error = null;
  paintSuggestions();
  $("#suggestions").hidden = false;
  try {
    state.suggestions.items = await listSuggestions();
  } catch (err) {
    console.error(err);
    state.suggestions.error = (err as Error).message;
  } finally {
    state.suggestions.loading = false;
    paintSuggestions();
  }
}

async function submitSuggestion(text: string) {
  if (text.length > SUGGESTION_MAX_LENGTH) {
    state.suggestions.statusMsg = t.suggestionsTooLong;
    paintSuggestions();
    return;
  }
  state.suggestions.posting = true;
  state.suggestions.statusMsg = t.suggestionsSending;
  paintSuggestions();
  try {
    await createSuggestion(text);
    state.suggestions.statusMsg = t.suggestionsSent;
    $<HTMLInputElement>("#suggestions-input").value = "";
    await loadSuggestions();
  } catch (err) {
    console.error(err);
    state.suggestions.statusMsg = t.suggestionsSubmitError(
      (err as Error).message,
    );
  } finally {
    state.suggestions.posting = false;
    paintSuggestions();
  }
}

async function castVote(id: string, dir: "up" | "down") {
  const votes = readVotes();
  if (votes[id]) {
    state.suggestions.statusMsg = t.suggestionsAlreadyVoted;
    paintSuggestions();
    return;
  }
  // Optimistic local bump so the UI reacts instantly.
  const target = state.suggestions.items.find((s) => s.id === id);
  if (target) {
    if (dir === "up") target.upvotes += 1;
    else target.downvotes += 1;
  }
  writeVote(id, dir);
  paintSuggestions();
  try {
    await voteSuggestion(id, dir);
  } catch (err) {
    console.error(err);
    // Rollback both the optimistic counter and the local vote record so the
    // user can retry. Failure here usually means the network blew up or the
    // doc disappeared.
    if (target) {
      if (dir === "up") target.upvotes -= 1;
      else target.downvotes -= 1;
    }
    const v = readVotes();
    delete v[id];
    try {
      localStorage.setItem(SUGGESTION_VOTES_KEY, JSON.stringify(v));
    } catch {}
    state.suggestions.statusMsg = t.suggestionsVoteError(
      (err as Error).message,
    );
    paintSuggestions();
  }
}

function paintSuggestions() {
  const host = $("#suggestions");
  if (state.route !== "suggestions") {
    host.hidden = true;
    return;
  }
  host.hidden = false;

  const hintEl = $("#suggestions-hint");
  const statusEl = $("#suggestions-status");
  const listEl = $("#suggestions-list");
  const submitBtn = $<HTMLButtonElement>("#suggestions-submit");
  const inputEl = $<HTMLInputElement>("#suggestions-input");

  hintEl.textContent = state.suggestions.error
    ? t.suggestionsError(state.suggestions.error)
    : state.suggestions.loading
      ? t.suggestionsLoading
      : t.suggestionsHint;

  statusEl.textContent = state.suggestions.statusMsg ?? "";
  submitBtn.disabled = state.suggestions.posting;
  submitBtn.textContent = state.suggestions.posting
    ? t.suggestionsSending
    : t.suggestionsSubmit;
  inputEl.disabled = state.suggestions.posting;

  listEl.innerHTML = "";
  if (state.suggestions.loading || state.suggestions.error) return;
  if (!state.suggestions.items.length) {
    const empty = document.createElement("p");
    empty.className = "muted small";
    empty.textContent = t.suggestionsEmpty;
    listEl.appendChild(empty);
    return;
  }
  const votes = readVotes();
  for (const s of state.suggestions.items) {
    listEl.appendChild(buildSuggestionRow(s, votes[s.id]));
  }
}

function buildSuggestionRow(
  s: Suggestion,
  myVote: "up" | "down" | undefined,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "suggestion-row";

  const body = document.createElement("div");
  body.className = "suggestion-body";
  const text = document.createElement("div");
  text.className = "suggestion-text";
  text.textContent = s.text;
  body.appendChild(text);
  const meta = document.createElement("div");
  meta.className = "suggestion-meta";
  meta.textContent = s.createdAt
    ? t.suggestionPostedAt(s.createdAt.toLocaleString(locale))
    : "";
  body.appendChild(meta);
  row.appendChild(body);

  const votes = document.createElement("div");
  votes.className = "suggestion-votes";
  const up = document.createElement("button");
  up.type = "button";
  up.className = "suggestion-vote-btn" + (myVote === "up" ? " active" : "");
  up.textContent = `▲ ${s.upvotes}`;
  up.title = t.suggestionUpvote;
  up.disabled = !!myVote;
  up.addEventListener("click", () => castVote(s.id, "up"));
  const down = document.createElement("button");
  down.type = "button";
  down.className = "suggestion-vote-btn" + (myVote === "down" ? " active" : "");
  down.textContent = `▼ ${s.downvotes}`;
  down.title = t.suggestionDownvote;
  down.disabled = !!myVote;
  down.addEventListener("click", () => castVote(s.id, "down"));
  votes.appendChild(up);
  votes.appendChild(down);
  row.appendChild(votes);

  return row;
}

init();
