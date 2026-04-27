import uPlot, { type Options } from "uplot";
import type { DamagePoint, DamageSeries } from "../aggregate/index.js";

const PALETTE_LIGHT = [
  "#c5462a", "#1f77b4", "#2ca02c", "#9467bd", "#ff7f0e",
  "#17becf", "#d62728", "#8c564b", "#e377c2", "#7f7f7f",
  "#bcbd22", "#5b8c5a",
];
const PALETTE_DARK = [
  "#ff7a55", "#62a4d9", "#52d36b", "#bf99ee", "#ffae42",
  "#56dde9", "#ff5b5d", "#c89388", "#f7a3da", "#a6a6a6",
  "#e3e266", "#7fc185",
];

export function renderDamageSingle(
  host: HTMLElement,
  points: DamagePoint[],
  label: string,
) {
  host.innerHTML = "";
  if (!points.length) {
    host.textContent = "Sem eventos de dano para exibir.";
    return;
  }

  const xs = points.map((p) => p.t / 1000);
  const ys = points.map((p) => p.damage);
  const palette = isDark() ? PALETTE_DARK : PALETTE_LIGHT;

  const opts: Options = {
    width: host.clientWidth || 1000,
    height: 240,
    cursor: { drag: { x: true, y: false } },
    series: [
      { label: "Tempo (s)" },
      {
        label,
        stroke: palette[0],
        fill: hexAlpha(palette[0], 0.15),
        width: 1.6,
      },
    ],
    axes: axes(),
    scales: { x: { time: false } },
  };

  const chart = new uPlot(opts, [xs, ys], host);
  setupResize(chart, host);
}

export function renderDamageMulti(host: HTMLElement, multi: DamageSeries) {
  host.innerHTML = "";
  if (!multi.series.length || !multi.ts.length) {
    host.textContent = "Sem eventos de dano para exibir.";
    return;
  }

  const xs = multi.ts.map((t) => t / 1000);
  const palette = isDark() ? PALETTE_DARK : PALETTE_LIGHT;

  const series: uPlot.Series[] = [{ label: "Tempo (s)" }];
  const data: uPlot.AlignedData = [xs];

  for (let i = 0; i < multi.series.length; i++) {
    const s = multi.series[i];
    series.push({
      label: s.name,
      stroke: palette[i % palette.length],
      width: 1.4,
    });
    data.push(s.damage);
  }

  const opts: Options = {
    width: host.clientWidth || 1000,
    height: 280,
    cursor: { drag: { x: true, y: false } },
    series,
    axes: axes(),
    scales: { x: { time: false } },
    legend: { live: true },
  };

  const chart = new uPlot(opts, data, host);
  setupResize(chart, host);
}

function axes(): uPlot.Axis[] {
  const stroke = isDark() ? "#aaa" : "#444";
  return [{ stroke }, { stroke }];
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

type Tracked = { chart: uPlot; resize: () => void };
const trackedByHost = new WeakMap<HTMLElement, Tracked>();

function setupResize(chart: uPlot, host: HTMLElement) {
  // Reset any previous resize listener attached to this host so we don't
  // accumulate them across re-renders (memory leak / eventual page crash).
  const prev = trackedByHost.get(host);
  if (prev) {
    window.removeEventListener("resize", prev.resize);
    try {
      prev.chart.destroy();
    } catch {
      /* already destroyed */
    }
  }
  const handler = () => {
    chart.setSize({ width: host.clientWidth, height: chart.height });
  };
  window.addEventListener("resize", handler, { passive: true });
  trackedByHost.set(host, { chart, resize: handler });
}
