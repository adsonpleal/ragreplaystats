import { useMemo } from "react";
import type uPlot from "uplot";
import type { AlignedData, Options } from "uplot";
import { palette, useDarkMode } from "./palette";
import { drawPhaseMarkers } from "./phaseMarkers";
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
  phaseStartsMs = [],
}: {
  xs: number[];
  series: LineSeries[];
  height?: number;
  liveLegend?: boolean;
  /** A grouped monster's later phases — drawn as labelled vertical lines. */
  phaseStartsMs?: readonly number[];
}) {
  const dark = useDarkMode();
  const labelsKey = series.map((s, i) => `${s.label}:${s.paletteIndex ?? i}`).join("|");
  const phasesKey = phaseStartsMs.join(",");

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
      hooks: { draw: [(u) => drawPhaseMarkers(u, phaseStartsMs, dark)] },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dark, labelsKey, height, liveLegend, phasesKey]);

  const data = useMemo<AlignedData>(
    () => [xs.map((t) => t / 1000), ...series.map((s) => s.values)] as AlignedData,
    [xs, series],
  );

  if (!xs.length || !series.length) return <>Sem dados.</>;
  return <UplotChart options={options} data={data} />;
}
