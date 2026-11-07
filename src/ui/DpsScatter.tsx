import { useEffect, useRef } from "react";
import uPlot, { type Options } from "uplot";
import { useDarkMode } from "./palette";
import { drawPhaseMarkers } from "./phaseMarkers";
import { panBy, zoomAt, ZOOM_STEP } from "./timelineZoom";

const ACCENT_LIGHT = "#c5462a";
const ACCENT_DARK = "#ff7a55";
const CHAT_LIGHT = "#1f77b4";
const CHAT_DARK = "#62a4d9";
/** Damage dot radius, in canvas pixels. */
const DOT_RADIUS = 6;

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

/** Point the x scale at `view`, or at the whole `full` span when there is none. */
function setXWindow(u: uPlot, view: Range, full: Range) {
  const win = view ?? full;
  // A session with a single event has no span to set; leave it autoscaled.
  if (!win || win.endMs === win.startMs) return;
  u.setScale("x", { min: win.startMs / 1000, max: win.endMs / 1000 });
}

/** Re-paint the saved selection, clipped to the visible window. */
function paintSelectRect(u: uPlot, range: Range) {
  if (!range) {
    u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
    return;
  }
  // `select` is positioned in CSS pixels, which is what `over` is sized in —
  // unlike `bbox`, which is canvas pixels and would need the device ratio.
  const clamp = (px: number) => Math.min(Math.max(px, 0), u.over.clientWidth);
  const left = clamp(u.valToPos(range.startMs / 1000, "x"));
  const right = clamp(u.valToPos(range.endMs / 1000, "x"));
  u.setSelect(
    { left, top: 0, width: Math.max(0, right - left), height: u.over.clientHeight },
    false,
  );
}

/**
 * Drag-selectable scatter for the DPS Analysis tab and the per-player matchup
 * cards: damage events as filled circles + chat/skill markers as vertical bars,
 * with a shared hover tooltip, and a dashed line at each of `phaseStartsMs` (a
 * grouped monster's later phases). uPlot is recreated when the data or the
 * theme change; `onSelect` is deduped against the current range.
 *
 * The visible window and the selection rect both ride on the live instance
 * instead of rebuilding it — a drag fires every 50 ms and a wheel notch faster
 * still.
 */
export function DpsScatter({
  data,
  range,
  onSelect,
  xRangeMs = null,
  fullRangeMs = null,
  onXRangeChange,
  yMax = null,
  phaseStartsMs = [],
  className = "stats-chart",
}: {
  data: DpsScatterData;
  range: Range;
  onSelect: (range: Range) => void;
  /** The visible window — `null` shows the whole span. */
  xRangeMs?: Range;
  /**
   * How far the window may be zoomed out, and what it resets to. The parent
   * owns it so the controls beside the chart clamp to exactly what the wheel
   * does; without one, the plotted data's own bounds stand in.
   */
  fullRangeMs?: Range;
  /**
   * When given, the plot area zooms with the wheel (anchored under the cursor)
   * and pans with shift+wheel or a horizontal wheel. The window itself belongs
   * to the parent, so the buttons beside the chart act on the same state.
   */
  onXRangeChange?: (range: Range) => void;
  yMax?: number | null;
  phaseStartsMs?: readonly number[];
  className?: string;
}) {
  const dark = useDarkMode();
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const viewRef = useRef(xRangeMs);
  viewRef.current = xRangeMs;
  const fullRangeRef = useRef(fullRangeMs);
  fullRangeRef.current = fullRangeMs;
  const onXRangeChangeRef = useRef(onXRangeChange);
  onXRangeChangeRef.current = onXRangeChange;
  /** The plotted data's own bounds, which stand in when `fullRangeMs` is absent. */
  const dataSpanRef = useRef<Range>(null);

  const rangeKey = range ? `${range.startMs}-${range.endMs}` : "null";
  const xKey = xRangeMs ? `${xRangeMs.startMs}-${xRangeMs.endMs}` : "auto";
  const phasesKey = phaseStartsMs.join(",");
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

    // uPlot's own default for a numeric x scale is exactly [dataMin, dataMax],
    // so "no window" and "the full span" are the same picture — which is what
    // lets zooming all the way out land back on the untouched chart.
    const dataSpan = { startMs: xs[0], endMs: xs[xs.length - 1] };
    dataSpanRef.current = dataSpan;
    const fullSpan = () => fullRangeRef.current ?? dataSpan;

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
      const { left, width } = u.bbox;
      ctx.save();
      ctx.fillStyle = accent;
      // One `fill` per dot, not one path for the series: overlapping dots
      // composite their antialiased edges, and a single path would union them
      // into a visibly lighter rim.
      for (let i = 0; i < xs.length; i++) {
        const y = ys[i];
        if (y == null) continue;
        const px = u.valToPos(xsSec[i], "x", true);
        // Same rule as drawPhaseMarkers: zoomed in, what falls outside the
        // window must not be painted over the axis. `xs` is sorted, so once
        // past the right edge everything after it is too.
        if (px < left) continue;
        if (px > left + width) break;
        ctx.beginPath();
        ctx.arc(px, u.valToPos(y, "y", true), DOT_RADIUS, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    };

    const drawChatBars = (u: uPlot) => {
      if (!chat.length) return;
      const ctx = u.ctx;
      const { left, top, width, height } = u.bbox;
      ctx.save();
      ctx.fillStyle = chatColor;
      ctx.globalAlpha = 0.55;
      for (const c of chat) {
        const px = u.valToPos(c.time / 1000, "x", true);
        if (px < left) continue;
        if (px > left + width) break;
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
        x: { time: false },
        // Pinned to the peak of the whole series on purpose: a Y axis that
        // rescaled to the window would make the same hit look different at
        // every zoom level.
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
            drawPhaseMarkers(u, phaseStartsMs, dark);
            drawDamageDots(u);
          },
        ],
        ready: [
          (u) => {
            setXWindow(u, viewRef.current, fullSpan());
            paintSelectRect(u, rangeRef.current);
          },
        ],
        setScale: [
          (u, key) => {
            // uPlot commits a scale change in a microtask, so right after
            // `setScale` the rect would still be fitted to the old window. This
            // hook is the moment the new one is in force.
            if (key === "x") paintSelectRect(u, rangeRef.current);
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

            const overRect = u.rect;
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
    chartRef.current = chart;

    const onWheel = (e: WheelEvent) => {
      const report = onXRangeChangeRef.current;
      if (!report) return;
      e.preventDefault();
      const view = viewRef.current;
      const full = fullSpan();
      // uPlot keeps this rect cached and invalidates it on resize/scroll, so
      // reading it here never forces a layout.
      const overRect = chart.rect;
      // A horizontal wheel (trackpad) or shift+wheel pans; anything else zooms.
      const panPx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0;
      if (panPx !== 0) {
        const cur = view ?? full;
        report(panBy(view, full, (panPx / (overRect.width || 1)) * (cur.endMs - cur.startMs)));
        return;
      }
      if (e.deltaY === 0) return;
      const anchorMs = chart.posToVal(e.clientX - overRect.left, "x") * 1000;
      report(zoomAt(view, full, e.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP, anchorMs));
    };
    chart.over.addEventListener("wheel", onWheel, { passive: false });

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
      chart.over.removeEventListener("wheel", onWheel);
      chartRef.current = null;
      chart.destroy();
      tooltip.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey, dark, yMax, phasesKey]);

  // Window and selection change far more often than the data does, so they are
  // pushed onto the live instance instead of being dependencies of the effect
  // that builds it. A new window carries the selection rect with it, repainted
  // from the `setScale` hook above.
  useEffect(() => {
    const chart = chartRef.current;
    if (chart) setXWindow(chart, xRangeMs, fullRangeMs ?? dataSpanRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xKey]);

  useEffect(() => {
    const chart = chartRef.current;
    if (chart) paintSelectRect(chart, range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeKey]);

  return <div ref={hostRef} className={className} />;
}
