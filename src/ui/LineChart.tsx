import { useMemo } from "react";
import type uPlot from "uplot";
import type { AlignedData, Options } from "uplot";
import { palette, useDarkMode } from "./palette";
import { UplotChart } from "./UplotChart";

export type LineSeries = {
  label: string;
  values: number[];
  paletteIndex?: number;
};

export function LineChart({
  xs,
  series,
  height = 240,
  liveLegend = true,
}: {
  xs: number[];
  series: LineSeries[];
  height?: number;
  liveLegend?: boolean;
}) {
  const dark = useDarkMode();
  const labelsKey = series.map((s, i) => `${s.label}:${s.paletteIndex ?? i}`).join("|");

  const options = useMemo<Omit<Options, "width">>(() => {
    const pal = palette(dark);
    const uSeries: uPlot.Series[] = [{ label: "Tempo (s)" }];
    for (let i = 0; i < series.length; i++) {
      const s = series[i];
      const idx = s.paletteIndex ?? i;
      uSeries.push({ label: s.label, stroke: pal[idx % pal.length], width: 1.4 });
    }
    const stroke = dark ? "#aaa" : "#444";
    return {
      height,
      padding: [8, 12, 0, 0],
      cursor: { drag: { x: true, y: false, setScale: false } },
      series: uSeries,
      axes: [{ stroke }, { stroke }],
      scales: { x: { time: false } },
      legend: { live: liveLegend },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dark, labelsKey, height, liveLegend]);

  const data = useMemo<AlignedData>(
    () => [xs.map((t) => t / 1000), ...series.map((s) => s.values)] as AlignedData,
    [xs, series],
  );

  if (!xs.length || !series.length) return <>Sem dados.</>;
  return <UplotChart options={options} data={data} />;
}
