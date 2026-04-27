import uPlot, { type Options } from "uplot";
import type { BrushSeries } from "../aggregate/index.js";

const PALETTE_LIGHT = [
  "#c5462a", "#1f77b4", "#2ca02c", "#9467bd", "#ff7f0e",
  "#17becf", "#d62728", "#8c564b", "#e377c2", "#7f7f7f",
];
const PALETTE_DARK = [
  "#ff7a55", "#62a4d9", "#52d36b", "#bf99ee", "#ffae42",
  "#56dde9", "#ff5b5d", "#c89388", "#f7a3da", "#a6a6a6",
];

export type BrushOptions = {
  /** Called when the user drag-selects a range. Pass null on single-click reset. */
  onSelect: (range: { startMs: number; endMs: number } | null) => void;
  /**
   * Re-paint a previously-saved selection rect when the chart is re-created
   * (e.g. after a rerender driven by the same selection). The setSelect hook
   * still fires, so the consumer must dedup — see `onSelect` callers.
   */
  initialRange?: { startMs: number; endMs: number } | null;
};

/**
 * Renders the timeline brush strip: total damage curve + kill-event dot
 * markers. Drag-selecting fires `onSelect`. Selection is rendered as a
 * native uPlot select rect (no scale change — the chart never zooms).
 */
export function renderTimelineBrush(
  host: HTMLElement,
  data: BrushSeries,
  opts: BrushOptions,
): uPlot | null {
  removePreviousChart(host);
  host.innerHTML = "";

  if (!data.ts.length) {
    host.textContent = "Sem dados.";
    return null;
  }

  const palette = isDark() ? PALETTE_DARK : PALETTE_LIGHT;
  const xsSec = data.ts.map((t) => t / 1000);

  const distinctViews: number[] = [];
  for (const v of data.killViews) {
    if (!distinctViews.includes(v)) distinctViews.push(v);
  }
  const colorByView = new Map<number, string>();
  distinctViews.forEach((v, i) =>
    colorByView.set(v, palette[i % palette.length]),
  );

  const peakDamage = data.damage.reduce((m, v) => (v > m ? v : m), 0);
  const dotY = peakDamage * 0.95 || 1;

  const drawDots = (u: uPlot) => {
    if (!data.killTs.length) return;
    const ctx = u.ctx;
    ctx.save();
    for (let i = 0; i < data.killTs.length; i++) {
      const x = u.valToPos(data.killTs[i] / 1000, "x", true);
      const y = u.valToPos(dotY, "y", true);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = colorByView.get(data.killViews[i]) ?? palette[0];
      ctx.fill();
    }
    ctx.restore();
  };

  // `setSelect` fires twice per drag: once during the gesture (with width=0
  // on the very first call) and once when the mouse releases. We only fire
  // `onSelect` on the release event when the gesture actually moved.
  let lastSelectAt = 0;

  const options: Options = {
    width: host.clientWidth || 1000,
    height: 100,
    padding: [4, 12, 0, 0],
    cursor: {
      drag: { x: true, y: false, setScale: false },
      // Hide the focus circle that appears on hover.
      points: { show: false },
    },
    series: [
      { label: "Tempo (s)" },
      {
        label: "Dano por bucket",
        stroke: palette[0],
        fill: hexAlpha(palette[0], 0.12),
        width: 1,
      },
    ],
    axes: axes(),
    scales: { x: { time: false } },
    legend: { show: false },
    hooks: {
      draw: [drawDots],
      ready: [
        (u) => {
          if (!opts.initialRange) return;
          const left = u.valToPos(opts.initialRange.startMs / 1000, "x");
          const right = u.valToPos(opts.initialRange.endMs / 1000, "x");
          if (right <= left) return;
          u.setSelect(
            { left, top: 0, width: right - left, height: u.bbox.height / devicePixelRatio },
            false,
          );
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

  const chart = new uPlot(options, [xsSec, data.damage], host);
  trackChart(host, chart);
  return chart;
}

function axes(): uPlot.Axis[] {
  const stroke = isDark() ? "#aaa" : "#444";
  return [{ stroke }, { stroke, show: false }];
}

function isDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

function hexAlpha(hex: string, alpha: number): string {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ---------------------------------------------------------------------------
// Per-host chart bookkeeping. Without this, every render adds another window
// "resize" listener referencing a destroyed uPlot — listener leak + memory
// leak that eventually crashes the page after many rerenders.
// ---------------------------------------------------------------------------

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
