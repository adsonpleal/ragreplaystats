import uPlot, { type Options } from "uplot";

const ACCENT_LIGHT = "#c5462a";
const ACCENT_DARK = "#ff7a55";
const CHAT_LIGHT = "#1f77b4";
const CHAT_DARK = "#62a4d9";

export type DpsScatterDamage = {
  time: number;
  damage: number;
  skillId: number;
  skillName: string;
};
export type DpsScatterChat = {
  time: number;
  message: string;
};

export type DpsScatterData = {
  damage: DpsScatterDamage[];
  chat: DpsScatterChat[];
};

export type DpsScatterOptions = {
  /** Called when the user drag-selects a range. null = single-click reset. */
  onSelect: (range: { startMs: number; endMs: number } | null) => void;
  /** Re-paint a previously-saved selection rect after rerender. */
  initialRange?: { startMs: number; endMs: number } | null;
};

/**
 * Drag-selectable scatter chart for the DPS Analysis tab. Two layered
 * point-only series:
 *   - Damage events: filled circles at (time, damage value)
 *   - Chat events: filled diamonds floating just above the highest damage
 * A single shared tooltip toggles between the closest-by-x event of either
 * series within a 16-pixel x-radius.
 */
export function renderDpsScatter(
  host: HTMLElement,
  data: DpsScatterData,
  opts: DpsScatterOptions,
): uPlot | null {
  removePreviousChart(host);
  host.innerHTML = "";

  const accent = isDark() ? ACCENT_DARK : ACCENT_LIGHT;
  const chatColor = isDark() ? CHAT_DARK : CHAT_LIGHT;
  const tooltipBg = isDark() ? "#1e1e22" : "#fafafa";
  const tooltipFg = isDark() ? "#eee" : "#222";
  const axisStroke = isDark() ? "#aaa" : "#444";

  const damage = [...data.damage].sort((a, b) => a.time - b.time);
  const chat = [...data.chat].sort((a, b) => a.time - b.time);

  if (!damage.length && !chat.length) {
    host.textContent = "Sem dados.";
    return null;
  }

  // Shared x-axis = union of all event timestamps (in seconds). Each y series
  // has nulls for x positions where it has no event.
  const xMs: number[] = [];
  for (const d of damage) xMs.push(d.time);
  for (const c of chat) xMs.push(c.time);
  xMs.sort((a, b) => a - b);
  // Dedup
  const xs: number[] = [];
  for (const t of xMs) {
    if (!xs.length || xs[xs.length - 1] !== t) xs.push(t);
  }
  const xsSec = xs.map((t) => t / 1000);

  const xIndex = new Map<number, number>();
  xs.forEach((t, i) => xIndex.set(t, i));

  const damageY: (number | null)[] = new Array(xs.length).fill(null);
  for (const d of damage) damageY[xIndex.get(d.time)!] = d.damage;
  const peakDamage = damage.reduce((m, d) => Math.max(m, d.damage), 1);

  // Build per-x lookup tables for the tooltip.
  const damageByTime = new Map<number, DpsScatterDamage>();
  for (const d of damage) damageByTime.set(d.time, d);
  const chatByTime = new Map<number, DpsScatterChat>();
  for (const c of chat) chatByTime.set(c.time, c);

  // Tooltip element (sibling of the chart inside `host`).
  const tooltip = document.createElement("div");
  tooltip.className = "dps-tooltip";
  tooltip.style.position = "absolute";
  tooltip.style.pointerEvents = "none";
  tooltip.style.background = tooltipBg;
  tooltip.style.color = tooltipFg;
  tooltip.style.border = `1px solid ${axisStroke}`;
  tooltip.style.padding = "0.4rem 0.6rem";
  tooltip.style.borderRadius = "4px";
  tooltip.style.fontSize = "0.85rem";
  tooltip.style.zIndex = "10";
  tooltip.style.maxWidth = "320px";
  tooltip.style.display = "none";
  host.style.position = "relative";
  host.appendChild(tooltip);

  let lastSelectAt = 0;

  const drawDamageDots = (u: uPlot) => {
    const ctx = u.ctx;
    const ys = u.data[1] as (number | null)[];
    ctx.save();
    ctx.fillStyle = accent;
    for (let i = 0; i < xs.length; i++) {
      const y = ys[i];
      if (y == null) continue;
      const px = u.valToPos(xsSec[i], "x", true);
      const py = u.valToPos(y, "y", true);
      ctx.beginPath();
      ctx.arc(px, py, 6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  };

  const drawChatBars = (u: uPlot) => {
    if (!chat.length) return;
    const ctx = u.ctx;
    const top = u.bbox.top;
    const height = u.bbox.height;
    ctx.save();
    ctx.fillStyle = chatColor;
    ctx.globalAlpha = 0.55;
    for (const c of chat) {
      const px = u.valToPos(c.time / 1000, "x", true);
      ctx.fillRect(px - 1.5, top, 3, height);
    }
    ctx.restore();
  };

  const options: Options = {
    width: host.clientWidth || 1000,
    height: 280,
    padding: [12, 16, 0, 0],
    cursor: {
      drag: { x: true, y: false, setScale: false },
      points: { show: false },
    },
    series: [
      { label: "Tempo (s)" },
      // Damage values feed the y-scale; we draw both the dots and the chat
      // bars manually in the `draw` hook so uPlot's default path / points
      // never appear.
      {
        label: "Dano",
        stroke: "rgba(0,0,0,0)",
        paths: () => null,
        points: { show: false },
      },
    ],
    scales: {
      x: { time: false },
      // Cap the y axis at the highest damage observed (with a small head
      // room) — chat bars span the full plot height regardless of y, so
      // there's no need to reserve space above the damage cloud.
      y: { range: () => [0, peakDamage * 1.06] },
    },
    axes: [
      { stroke: axisStroke },
      {
        stroke: axisStroke,
        values: (_u, ticks) =>
          ticks.map((v) => (v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1_000 ? `${Math.round(v / 1000)}k` : `${v}`)),
      },
    ],
    legend: { show: false },
    hooks: {
      // Chat bars first (so damage circles overlay them), then damage.
      draw: [
        (u) => {
          drawChatBars(u);
          drawDamageDots(u);
        },
      ],
      ready: [
        (u) => {
          if (!opts.initialRange) return;
          const left = u.valToPos(opts.initialRange.startMs / 1000, "x");
          const right = u.valToPos(opts.initialRange.endMs / 1000, "x");
          if (right <= left) return;
          u.setSelect(
            {
              left,
              top: 0,
              width: right - left,
              height: u.bbox.height / devicePixelRatio,
            },
            false,
          );
        },
      ],
      setCursor: [
        (u) => {
          const cursor = u.cursor;
          const rect = host.getBoundingClientRect();
          const left = cursor.left ?? -1;
          const top = cursor.top ?? -1;
          if (left < 0 || top < 0) {
            tooltip.style.display = "none";
            return;
          }
          const cursorTimeMs = u.posToVal(left, "x") * 1000;

          // Find nearest event by x-pixel proximity, both series.
          let bestKind: "damage" | "chat" | null = null;
          let bestPxDist = 16; // tolerance in px
          let bestTime = 0;
          for (const d of damage) {
            const px = u.valToPos(d.time / 1000, "x");
            const dist = Math.abs(px - left);
            if (dist < bestPxDist) {
              bestPxDist = dist;
              bestKind = "damage";
              bestTime = d.time;
            }
          }
          for (const c of chat) {
            const px = u.valToPos(c.time / 1000, "x");
            const dist = Math.abs(px - left);
            if (dist < bestPxDist) {
              bestPxDist = dist;
              bestKind = "chat";
              bestTime = c.time;
            }
          }

          if (bestKind === null) {
            tooltip.style.display = "none";
            void cursorTimeMs;
            return;
          }

          if (bestKind === "damage") {
            const d = damageByTime.get(bestTime)!;
            const skill = d.skillName;
            tooltip.innerHTML =
              `<strong>${formatDamage(d.damage)}</strong>` +
              `<br>${escape(skill)}` +
              `<br><span style="color:${axisStroke}">t=${(d.time / 1000).toFixed(1)} s</span>`;
          } else {
            const c = chatByTime.get(bestTime)!;
            tooltip.innerHTML =
              `<strong>${escape(c.message)}</strong>` +
              `<br><span style="color:${axisStroke}">t=${(c.time / 1000).toFixed(1)} s</span>`;
          }
          tooltip.style.display = "block";

          // `cursor.left` is relative to uPlot's plotting area; the tooltip
          // is positioned relative to `host` which also contains the y-axis
          // gutter / chart padding. Translate by the plot area's offset
          // inside the host so the tooltip ends up centred under the cursor.
          const overRect = u.over.getBoundingClientRect();
          const cursorHostX = overRect.left - rect.left + left;
          const cursorHostY = overRect.top - rect.top + top;
          const ttRect = tooltip.getBoundingClientRect();
          const OFFSET = 10;
          let x = cursorHostX - ttRect.width / 2;
          if (x < 4) x = 4;
          if (x + ttRect.width > rect.width - 4) x = rect.width - ttRect.width - 4;
          let y = cursorHostY - ttRect.height - OFFSET;
          if (y < 4) y = 4;
          tooltip.style.left = `${x}px`;
          tooltip.style.top = `${y}px`;
        },
      ],
      setSelect: [
        (u) => {
          const now = performance.now();
          if (now - lastSelectAt < 50) return;
          lastSelectAt = now;

          if (u.select.width <= 1) {
            opts.onSelect(null);
            return;
          }
          const x0 = u.posToVal(u.select.left, "x");
          const x1 = u.posToVal(u.select.left + u.select.width, "x");
          opts.onSelect({
            startMs: Math.round(Math.min(x0, x1) * 1000),
            endMs: Math.round(Math.max(x0, x1) * 1000),
          });
        },
      ],
    },
  };

  const aligned: uPlot.AlignedData = [xsSec, damageY];
  const chart = new uPlot(options, aligned, host);

  // Hide tooltip when the cursor leaves the chart.
  host.addEventListener("mouseleave", () => {
    tooltip.style.display = "none";
  });

  trackChart(host, chart);
  return chart;
}

function formatDamage(n: number): string {
  return n.toLocaleString("pt-BR");
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]!);
}

function isDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

type Tracked = { chart: uPlot; resize: () => void };
const trackedByHost = new WeakMap<HTMLElement, Tracked>();

function removePreviousChart(host: HTMLElement) {
  const prev = trackedByHost.get(host);
  if (!prev) return;
  window.removeEventListener("resize", prev.resize);
  prev.chart.destroy();
  trackedByHost.delete(host);
}

function trackChart(host: HTMLElement, chart: uPlot) {
  const resize = () => {
    chart.setSize({ width: host.clientWidth, height: chart.height });
  };
  window.addEventListener("resize", resize, { passive: true });
  trackedByHost.set(host, { chart, resize });
}
