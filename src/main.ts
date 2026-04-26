import {
  bySkill,
  bySkillAndPlayer,
  damageTimelineMulti,
  damageTimelineSingle,
  killsByPlayerAndMob,
  monstersDamagedByPlayer,
  monstersWhoTookDamage,
  type MonsterAgg,
  type PlayerAgg,
  playersThatDamaged,
  playersWhoDamaged,
  skillUsageByPlayer,
} from "./aggregate/index.js";
import { loadReferenceDb, type ReferenceDb } from "./db/loader.js";
import { t, locale } from "./i18n.js";
import { decodeReplay } from "./rrf/decode.js";
import type { DamageEvent, Replay } from "./rrf/types.js";
import { renderBarChart } from "./ui/bar-chart.js";
import { renderDamageMulti, renderDamageSingle } from "./ui/dps-chart.js";
import { renderTable } from "./ui/table.js";

type Mode = "byPlayer" | "byMonster";

type State = {
  replay: Replay | null;
  db: ReferenceDb | null;
  mode: Mode;
  selectedPlayer: number | null;
  selectedMonster: number | null;
};

const state: State = {
  replay: null,
  db: null,
  mode: "byPlayer",
  selectedPlayer: null,
  selectedMonster: null,
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
}

function paintStaticStrings() {
  $("#tagline").textContent = t.appTagline;
  $("#drop-prompt").innerHTML =
    `${t.dropPrompt} <label class="link" for="file-input">${t.browse}</label>.`;
  document
    .querySelectorAll<HTMLButtonElement>(".mode-btn")
    .forEach((btn) => {
      btn.textContent =
        btn.dataset.mode === "byPlayer" ? t.modeByPlayer : t.modeByMonster;
    });
}

function setupDropZone() {
  const zone = $("#drop-zone");
  const input = $<HTMLInputElement>("#file-input");
  const status = $("#drop-status");

  const handleFile = async (file: File) => {
    status.textContent = t.parsing(file.name, (file.size / 1024).toFixed(1));
    try {
      const buf = await file.arrayBuffer();
      const t0 = performance.now();
      const replay = decodeReplay(buf);
      const ms = (performance.now() - t0).toFixed(0);
      state.replay = replay;
      state.selectedPlayer = null;
      state.selectedMonster = null;
      status.textContent = t.decoded(
        replay.totals.handledPackets,
        replay.totals.packetCount,
        ms,
        file.name,
      );
      rerender();
    } catch (err) {
      console.error(err);
      status.textContent = t.parseError((err as Error).message);
    }
  };

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
  } else {
    renderByMonsterMode(r);
  }

  renderSkillUsesChart(r);
  renderKillsChart(r);
}

const SKILL_USES_BAR_LIMIT = 30;
const KILLS_BAR_LIMIT = 30;

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
      let label: string;
      if (playerLabel && monsterLabel) {
        label = `${r.playerName} · ${r.monsterName}`;
      } else if (playerLabel) {
        label = r.monsterName;
      } else if (monsterLabel) {
        label = r.playerName;
      } else {
        label = `${r.playerName} · ${r.monsterName}`;
      }
      return {
        key: r.key,
        label,
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
    truncated.map((r) => ({
      key: r.key,
      label: showPlayerInLabel
        ? `${r.playerName} · ${r.skillName}`
        : r.skillName,
      value: r.count,
      display: fmt(r.count),
    })),
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
      { key: "crits", label: t.colCrits, numeric: true, format: (r) => fmt(r.crits) },
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
        key: "name",
        label: t.colMonster,
        format: (r) => formatMonsterRow(r),
        sortValue: (r) => formatMonsterRow(r),
      },
      { key: "view", label: t.colMobId, numeric: true, format: (r) => String(r.view) },
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
        key: "name",
        label: t.colMonster,
        format: (r) => formatMonsterRow(r),
        sortValue: (r) => formatMonsterRow(r),
      },
      { key: "view", label: t.colMobId, numeric: true, format: (r) => String(r.view) },
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
        rerender();
      },
      isSelected: (row) => row.aid === state.selectedMonster,
    },
  );

  secondary.innerHTML = "";
  barPane.innerHTML = "";
  chartPane.innerHTML = "";
  skillPane.innerHTML = "";

  if (state.selectedMonster === null) return;

  const monsterLabel = monsterName(replay, state.selectedMonster);
  const events = replay.damage.filter((d) => d.target === state.selectedMonster);
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
      { key: "crits", label: t.colCrits, numeric: true, format: (r) => fmt(r.crits) },
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

  const bucketMs = pickBucketMs(events);
  chartPane.innerHTML = `<h2 class="section-title">${t.damageOverTimeMultiTitle}</h2>
    <div id="dps-chart"></div>`;
  renderDamageMulti($("#dps-chart"), damageTimelineMulti(replay, events, bucketMs));

  renderSkillByPlayerTable(skillPane, events, t.skillsAgainstMonster);
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
      { key: "name", label: t.colSkill },
      { key: "skillId", label: t.colId, numeric: true, format: (r) => String(r.skillId) },
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
      { key: "playerName", label: t.colPlayer },
      {
        key: "class",
        label: t.colClass,
        format: (r) => playerClass(state.replay!, r.playerAid),
        sortValue: (r) => playerClass(state.replay!, r.playerAid),
      },
      { key: "name", label: t.colSkill },
      { key: "skillId", label: t.colId, numeric: true, format: (r) => String(r.skillId) },
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
