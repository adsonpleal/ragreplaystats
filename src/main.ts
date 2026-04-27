import {
  brushSeries,
  bySkill,
  bySkillAndPlayer,
  computeResumo,
  consumablesByItem,
  damageTimelineMulti,
  damageTimelineSingle,
  isPlayerSource,
  killsByPlayerAndMob,
  lootByItem,
  mobHpCurve,
  type MobSkillAgg,
  mobSkillBreakdown,
  monstersDamagedByPlayer,
  monstersWhoTookDamage,
  paramCurve,
  playersDamagedByMonster,
  SP_HP,
  SP_MAXHP,
  SP_SP,
  SP_MAXSP,
  statusUptime,
  type MonsterAgg,
  type PlayerAgg,
  playersThatDamaged,
  playersWhoDamaged,
  type Range,
  skillUsageByPlayer,
} from "./aggregate/index.js";
import { loadReferenceDb, type ReferenceDb } from "./db/loader.js";
import { prefetchReplay } from "./divine-pride.js";
import { fetchReplay, uploadReplay } from "./firebase.js";
import { t, locale } from "./i18n.js";
import { decodeReplay } from "./rrf/decode.js";
import type { DamageEvent, Replay } from "./rrf/types.js";
import { renderBarChart } from "./ui/bar-chart.js";
import { renderDamageMulti, renderDamageSingle } from "./ui/dps-chart.js";
import { renderLineChart } from "./ui/line-chart.js";
import { renderSummaryCard, type SummaryCell } from "./ui/stats-summary.js";
import { renderTable } from "./ui/table.js";
import { renderTimelineBrush } from "./ui/timeline-brush.js";

type Mode = "byPlayer" | "byMonster" | "stats";

type State = {
  replay: Replay | null;
  db: ReferenceDb | null;
  mode: Mode;
  selectedPlayer: number | null;
  selectedMonster: number | null;
  /** Brush selection. null = full session. */
  selectedTimeRange: Range;
  /** Set once a replay has been uploaded or fetched — used to render the share link. */
  shareId: string | null;
  /**
   * Per-victim filter for the "Habilidades de <mob>" card. Reset when the
   * selected monster changes.
   */
  selectedMobSkillTarget: number | null;
};

const state: State = {
  replay: null,
  db: null,
  mode: "byPlayer",
  selectedPlayer: null,
  selectedMonster: null,
  selectedTimeRange: null,
  shareId: null,
  selectedMobSkillTarget: null,
};

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector<T>(sel)!;

function init() {
  paintStaticStrings();
  setupDropZone();
  setupModeToggle();
  void loadReferenceDb().then((db) => {
    state.db = db;
    if (state.replay) rerender();
  });
  void loadFromUrl();
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
  if (!state.shareId) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
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
  state.selectedPlayer = null;
  state.selectedMonster = null;
  state.selectedTimeRange = null;
  state.selectedMobSkillTarget = null;
  state.shareId = shareId;
  status.textContent = t.decoded(
    replay.totals.handledPackets,
    replay.totals.packetCount,
    ms,
    fileName,
  );
  rerender();
  renderShareControls();

  // Pull names from Divine Pride in the background; re-render when finished
  // so any `mob#1234` / `skill#999` fallbacks become real names.
  void prefetchReplay(replay).then(() => {
    if (state.replay === replay) rerender();
  });
}

function paintStaticStrings() {
  $("#tagline").textContent = t.appTagline;
  $("#drop-prompt").innerHTML =
    `${t.dropPrompt} <label class="link" for="file-input">${t.browse}</label>.`;
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
      }
    });
}

function setupDropZone() {
  const zone = $("#drop-zone");
  const input = $<HTMLInputElement>("#file-input");
  const status = $("#drop-status");

  const handleFile = async (file: File) => {
    status.textContent = t.parsing(file.name, (file.size / 1024).toFixed(1));
    // Drop any stale ?r=… so a refresh during upload doesn't reload the
    // previous shared replay.
    const url = new URL(location.href);
    if (url.searchParams.has("r")) {
      url.searchParams.delete("r");
      history.replaceState(null, "", url.toString());
    }
    try {
      const buf = await file.arrayBuffer();
      parseAndRender(buf, file.name, null);
      void uploadAndShare(buf, file.name);
    } catch (err) {
      console.error(err);
      status.textContent = t.parseError((err as Error).message);
    }
  };

  async function uploadAndShare(buf: ArrayBuffer, fileName: string) {
    const status = $("#drop-status");
    const prev = status.textContent;
    status.textContent = (prev ? prev + " · " : "") + t.uploading;
    try {
      const id = await uploadReplay(new Uint8Array(buf), fileName);
      state.shareId = id;
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
      state.mode = mode;
      state.selectedPlayer = null;
      state.selectedMonster = null;
      document.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      rerender();
    });
  });
}

function rerender() {
  const r = state.replay;
  if (!r) return;

  $("#summary").hidden = false;
  $("#explorer").hidden = false;
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
  } else {
    renderStatsMode(r);
  }
}

const SKILL_USES_BAR_LIMIT = 30;
const KILLS_BAR_LIMIT = 30;
const ITEM_BAR_LIMIT = 30;
const BRUSH_BUCKET_MS = 1_000;

function clearStatsOnlyPanes() {
  $("#brush-pane").innerHTML = "";
  $("#status-pane").innerHTML = "";
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

function renderStatsMode(replay: Replay) {
  clearByModeOnlyPanes();
  clearByMonsterOnlyPanes();
  $("#skill-pane").innerHTML = "";
  // Hide the breadcrumb — stats mode is always for the local player.
  $("#breadcrumb").hidden = true;

  renderResumoCard(replay);
  renderBrush(replay);
  renderConsumables(replay);
  renderLoot(replay);
  renderHpSpChart(replay);
  renderKillsByTypeChart(replay);
  renderStatusList(replay);
}

function renderResumoCard(replay: Replay) {
  const stats = computeResumo(replay, state.selectedTimeRange);
  const skillResolver = (id: number) =>
    state.db?.resolveSkill(id) ?? t.skillFallback(id);
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

function renderStatusList(replay: Replay) {
  const host = $("#status-pane");
  const statusResolver = (id: number) =>
    state.db?.resolveStatus(id) ?? t.statusFallback(id);
  const rows = statusUptime(replay, state.selectedTimeRange, statusResolver);
  if (!rows.length) {
    host.innerHTML = "";
    return;
  }

  const max = rows[0].uptimeMs || 1;
  let html = `<h2 class="section-title">${t.statsBuffsTitle}</h2>
    <div class="status-list">`;
  for (const r of rows.slice(0, 30)) {
    const pctW = Math.max(2, (r.uptimeMs / max) * 100);
    html += `<div class="status-row">
      <span class="bar-label" title="${escape(r.name)}">${escape(r.name)}</span>
      <span class="uptime-bar"><span class="uptime-fill" style="width:${pctW.toFixed(2)}%"></span></span>
      <span class="uptime-value">${formatDuration(r.uptimeMs)} · ${fmt(r.appliedCount)}×</span>
    </div>`;
  }
  html += "</div>";
  host.innerHTML = html;
}

function pct(n: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((n / total) * 100);
}


function renderKillsChart(replay: Replay) {
  const host = $("#kills-pane");
  const mobResolver = (id: number) =>
    state.db?.resolveMob(id) ?? t.mobFallback(id);

  const filter: { sourceAid?: number; targetView?: number } = {};
  if (state.selectedPlayer != null) filter.sourceAid = state.selectedPlayer;
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

  const playerLabel =
    state.selectedPlayer != null ? playerName(replay, state.selectedPlayer) : null;
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
    state.db?.resolveSkill(id) ?? t.skillFallback(id);

  const filter: { sourceAid?: number; targetAid?: number } = {};
  if (state.selectedPlayer != null) filter.sourceAid = state.selectedPlayer;
  if (state.selectedMonster != null) filter.targetAid = state.selectedMonster;

  const rows = skillUsageByPlayer(replay, filter, skillResolver);
  if (!rows.length) {
    host.innerHTML = "";
    return;
  }

  const playerLabel =
    state.selectedPlayer != null ? playerName(replay, state.selectedPlayer) : null;
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
  if (!ent) return t.mobFallback(aid);
  // For mobs, prefer the DB species name over the per-instance spawn-packet
  // label (the server often sends 2-byte codes that look like garbage).
  if (state.db && ent.view) {
    const fromDb = state.db.resolveMob(ent.view);
    if (!fromDb.startsWith("mob#")) return fromDb;
  }
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
    if (state.selectedPlayer !== null) {
      crumbs.push({
        label: t.crumbPlayer,
        value: playerName(r, state.selectedPlayer),
        clear: () => {
          state.selectedPlayer = null;
          state.selectedMonster = null;
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
        state.selectedPlayer = row.aid;
        state.selectedMonster = null;
        rerender();
      },
      isSelected: (row) => row.aid === state.selectedPlayer,
    },
  );

  secondary.innerHTML = "";
  chartPane.innerHTML = "";
  skillPane.innerHTML = "";

  if (state.selectedPlayer === null) return;

  const playerLabel = playerName(replay, state.selectedPlayer);
  const monsters = monstersDamagedByPlayer(replay, state.selectedPlayer);

  secondary.innerHTML = `<h2 class="section-title">${escape(t.monstersDamagedBy(playerLabel))}</h2>
    <p class="section-hint">${t.monstersDamagedByHint}</p>
    <div id="secondary-table"></div>`;

  renderTable<MonsterAgg>(
    $("#secondary-table"),
    [
      {
        key: "view",
        label: t.colMobId,
        format: (r) => String(r.view),
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
        state.selectedMonster = row.aid;
        state.selectedMobSkillTarget = null;
        rerender();
      },
      isSelected: (row) => row.aid === state.selectedMonster,
    },
  );

  if (state.selectedMonster === null) return;

  const monsterLabel = monsterName(replay, state.selectedMonster);
  const events = replay.damage.filter(
    (d) => d.source === state.selectedPlayer && d.target === state.selectedMonster,
  );
  const bucketMs = pickBucketMs(events);

  chartPane.innerHTML = `<h2 class="section-title">${escape(t.matchupTitle(playerLabel, monsterLabel))}</h2>
    <div id="dps-chart"></div>`;
  renderDamageSingle(
    $("#dps-chart"),
    damageTimelineSingle(events, bucketMs),
    `${playerLabel} → ${monsterLabel}`,
  );

  renderSkillTable(skillPane, events, t.skillsInMatchup);
}

function renderByMonsterMode(replay: Replay) {
  clearStatsOnlyPanes();
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
        format: (r) => String(r.view),
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
  // Resolve maxHp fallback once and feed it into the aggregator so the
  // firstSeenMs anchor exists even when the server hides HP for the boss.
  const fallbackMax = ent ? effectiveMaxHp(ent.maxHp, ent.view) : 0;
  const series = mobHpCurve(replay, mobAid, fallbackMax);
  if (!series.ts.length) {
    host.innerHTML = `<section class="stats-card"><h2 class="section-title">${t.hpCurveTitle}</h2><p class="section-hint">${t.mobNoHpDataHint}</p></section>`;
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
    state.db?.resolveSkill(id) ?? t.skillFallback(id);

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
        format: (r) => String(r.skillId),
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
  host.innerHTML = `<h2 class="section-title">${escape(title)}</h2>
    <div id="skill-table"></div>`;
  const skillResolver = (id: number) =>
    state.db?.resolveSkill(id) ?? t.skillFallback(id);
  const rows = bySkill(events, state.replay!.skillCasts, skillResolver);
  renderTable(
    $("#skill-table"),
    [
      {
        key: "skillId",
        label: t.colId,
        format: (r) => String(r.skillId),
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
    state.db?.resolveSkill(id) ?? t.skillFallback(id);
  const rows = bySkillAndPlayer(state.replay!, events, skillResolver);
  renderTable(
    $("#skill-table"),
    [
      {
        key: "skillId",
        label: t.colId,
        format: (r) => String(r.skillId),
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

init();
