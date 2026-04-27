import uPlot, { type Options } from "uplot";

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

export type LineSeries = {
  label: string;
  values: number[];
  paletteIndex?: number;
};

export type LineChartOptions = {
  height?: number;
  liveLegend?: boolean;
};

export function renderLineChart(
  host: HTMLElement,
  xs: number[],
  series: LineSeries[],
  options: LineChartOptions = {},
): uPlot | null {
  removePreviousChart(host);
  host.innerHTML = "";
  if (!xs.length || !series.length) {
    host.textContent = "Sem dados.";
    return null;
  }

  const palette = isDark() ? PALETTE_DARK : PALETTE_LIGHT;
  const xsSec = xs.map((t) => t / 1000);

  const uSeries: uPlot.Series[] = [{ label: "Tempo (s)" }];
  const data: uPlot.AlignedData = [xsSec];
  for (let i = 0; i < series.length; i++) {
    const s = series[i];
    const idx = s.paletteIndex ?? i;
    uSeries.push({
      label: s.label,
      stroke: palette[idx % palette.length],
      width: 1.4,
    });
    data.push(s.values);
  }

  const opts: Options = {
    width: host.clientWidth || 1000,
    height: options.height ?? 240,
    padding: [8, 12, 0, 0],
    cursor: { drag: { x: true, y: false, setScale: false } },
    series: uSeries,
    axes: axes(),
    scales: { x: { time: false } },
    legend: { live: options.liveLegend ?? true },
  };

  const chart = new uPlot(opts, data, host);
  trackChart(host, chart);
  return chart;
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
