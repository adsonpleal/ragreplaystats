import { useEffect, useRef } from "react";
import uPlot, { type Options } from "uplot";
import { useDarkMode } from "./palette";

const ACCENT_LIGHT = "#c5462a";
const ACCENT_DARK = "#ff7a55";
const CHAT_LIGHT = "#1f77b4";
const CHAT_DARK = "#62a4d9";

export type DpsScatterDamage = { time: number; damage: number; skillId: number; skillName: string };
export type DpsScatterChat = { time: number; message: string };
export type DpsScatterData = { damage: DpsScatterDamage[]; chat: DpsScatterChat[] };

type Range = { startMs: number; endMs: number } | null;

function formatDamage(n: number): string {
  return n.toLocaleString("pt-BR");
}
function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/**
 * Drag-selectable scatter for the DPS Analysis tab and the per-player matchup
 * cards: damage events as filled circles + chat/skill markers as vertical bars,
 * with a shared hover tooltip. uPlot is recreated when data/theme/range/locked
 * axes change; `onSelect` is deduped against the current range.
 */
export function DpsScatter({
  data,
  range,
  onSelect,
  xRangeMs = null,
  yMax = null,
  className = "stats-chart",
}: {
  data: DpsScatterData;
  range: Range;
  onSelect: (range: Range) => void;
  xRangeMs?: Range;
  yMax?: number | null;
  className?: string;
}) {
  const dark = useDarkMode();
  const hostRef = useRef<HTMLDivElement>(null);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const rangeKey = range ? `${range.startMs}-${range.endMs}` : "null";
  const xKey = xRangeMs ? `${xRangeMs.startMs}-${xRangeMs.endMs}` : "auto";
  const dataKey = `${data.damage.length}:${data.chat.length}:${data.damage[0]?.time ?? 0}:${data.damage[data.damage.length - 1]?.time ?? 0}`;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = "";

    const accent = dark ? ACCENT_DARK : ACCENT_LIGHT;
    const chatColor = dark ? CHAT_DARK : CHAT_LIGHT;
    const tooltipBg = dark ? "#1e1e22" : "#fafafa";
    const tooltipFg = dark ? "#eee" : "#222";
    const axisStroke = dark ? "#aaa" : "#444";

    const damage = [...data.damage].sort((a, b) => a.time - b.time);
    const chat = [...data.chat].sort((a, b) => a.time - b.time);
    if (!damage.length && !chat.length) {
      host.textContent = "Sem dados.";
      return;
    }

    const xMs: number[] = [];
    for (const d of damage) xMs.push(d.time);
    for (const c of chat) xMs.push(c.time);
    xMs.sort((a, b) => a - b);
    const xs: number[] = [];
    for (const tm of xMs) if (!xs.length || xs[xs.length - 1] !== tm) xs.push(tm);
    const xsSec = xs.map((tm) => tm / 1000);
    const xIndex = new Map<number, number>();
    xs.forEach((tm, i) => xIndex.set(tm, i));

    const damageY: (number | null)[] = new Array(xs.length).fill(null);
    for (const d of damage) damageY[xIndex.get(d.time)!] = d.damage;
    const peakDamage = damage.reduce((m, d) => Math.max(m, d.damage), 1);

    const damageByTime = new Map<number, DpsScatterDamage>();
    for (const d of damage) damageByTime.set(d.time, d);
    const chatByTime = new Map<number, DpsScatterChat>();
    for (const c of chat) chatByTime.set(c.time, c);

    const tooltip = document.createElement("div");
    tooltip.className = "dps-tooltip";
    Object.assign(tooltip.style, {
      position: "absolute",
      pointerEvents: "none",
      background: tooltipBg,
      color: tooltipFg,
      border: `1px solid ${axisStroke}`,
      padding: "0.4rem 0.6rem",
      borderRadius: "4px",
      fontSize: "0.85rem",
      zIndex: "10",
      maxWidth: "320px",
      display: "none",
    });
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
      cursor: { drag: { x: true, y: false, setScale: false }, points: { show: false } },
      series: [
        { label: "Tempo (s)" },
        { label: "Dano", stroke: "rgba(0,0,0,0)", paths: () => null, points: { show: false } },
      ],
      scales: {
        x: xRangeMs
          ? { time: false, range: () => [xRangeMs.startMs / 1000, xRangeMs.endMs / 1000] }
          : { time: false },
        y: { range: () => [0, (yMax ?? peakDamage) * 1.06] },
      },
      axes: [
        { stroke: axisStroke },
        {
          stroke: axisStroke,
          values: (_u, ticks) =>
            ticks.map((v) =>
              v >= 1_000_000
                ? `${(v / 1_000_000).toFixed(1)}M`
                : v >= 1_000
                  ? `${Math.round(v / 1000)}k`
                  : `${v}`,
            ),
        },
      ],
      legend: { show: false },
      hooks: {
        draw: [
          (u) => {
            drawChatBars(u);
            drawDamageDots(u);
          },
        ],
        ready: [
          (u) => {
            const cur = rangeRef.current;
            if (!cur) return;
            const left = u.valToPos(cur.startMs / 1000, "x");
            const right = u.valToPos(cur.endMs / 1000, "x");
            if (right <= left) return;
            u.setSelect(
              { left, top: 0, width: right - left, height: u.bbox.height / devicePixelRatio },
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
            let bestKind: "damage" | "chat" | null = null;
            let bestPxDist = 16;
            let bestTime = 0;
            for (const d of damage) {
              const dist = Math.abs(u.valToPos(d.time / 1000, "x") - left);
              if (dist < bestPxDist) {
                bestPxDist = dist;
                bestKind = "damage";
                bestTime = d.time;
              }
            }
            for (const c of chat) {
              const dist = Math.abs(u.valToPos(c.time / 1000, "x") - left);
              if (dist < bestPxDist) {
                bestPxDist = dist;
                bestKind = "chat";
                bestTime = c.time;
              }
            }
            if (bestKind === null) {
              tooltip.style.display = "none";
              return;
            }
            if (bestKind === "damage") {
              const d = damageByTime.get(bestTime)!;
              tooltip.innerHTML =
                `<strong>${formatDamage(d.damage)}</strong>` +
                `<br>${escapeHtml(d.skillName)}` +
                `<br><span style="color:${axisStroke}">t=${(d.time / 1000).toFixed(1)} s</span>`;
            } else {
              const c = chatByTime.get(bestTime)!;
              tooltip.innerHTML =
                `<strong>${escapeHtml(c.message)}</strong>` +
                `<br><span style="color:${axisStroke}">t=${(c.time / 1000).toFixed(1)} s</span>`;
            }
            tooltip.style.display = "block";

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
            const next: Range =
              u.select.width <= 1
                ? null
                : (() => {
                    const x0 = u.posToVal(u.select.left, "x");
                    const x1 = u.posToVal(u.select.left + u.select.width, "x");
                    return {
                      startMs: Math.round(Math.min(x0, x1) * 1000),
                      endMs: Math.round(Math.max(x0, x1) * 1000),
                    };
                  })();
            const cur = rangeRef.current;
            const same =
              (cur === null && next === null) ||
              (!!cur && !!next && cur.startMs === next.startMs && cur.endMs === next.endMs);
            if (same) return;
            onSelectRef.current(next);
          },
        ],
      },
    };

    const chart = new uPlot(options, [xsSec, damageY], host);
    const onLeave = () => {
      tooltip.style.display = "none";
    };
    host.addEventListener("mouseleave", onLeave);
    const ro = new ResizeObserver(() => {
      const w = host.clientWidth;
      if (w && w !== chart.width) chart.setSize({ width: w, height: chart.height });
    });
    ro.observe(host);
    return () => {
      ro.disconnect();
      host.removeEventListener("mouseleave", onLeave);
      chart.destroy();
      tooltip.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey, dark, rangeKey, xKey, yMax]);

  return <div ref={hostRef} className={className} />;
}
