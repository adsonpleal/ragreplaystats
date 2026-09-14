import { useMemo } from "react";
import type uPlot from "uplot";
import type { AlignedData, Options } from "uplot";
import type { DamageSeries } from "../aggregate/index";
import { palette, useDarkMode } from "./palette";
import { drawPhaseMarkers } from "./phaseMarkers";
import { UplotChart } from "./UplotChart";

/**
 * Multi-series "damage over time" chart — one line per player/source, with a
 * line at each of `phaseStartsMs` (a grouped monster's later phases).
 */
export function DamageChart({
  multi,
  phaseStartsMs = [],
}: {
  multi: DamageSeries;
  phaseStartsMs?: readonly number[];
}) {
  const dark = useDarkMode();
  const labelsKey = multi.series.map((s) => s.name).join("|");
  const phasesKey = phaseStartsMs.join(",");

  const options = useMemo<Omit<Options, "width">>(() => {
    const pal = palette(dark);
    const series: uPlot.Series[] = [{ label: "Tempo (s)" }];
    for (let i = 0; i < multi.series.length; i++) {
      series.push({
        label: multi.series[i].name,
        stroke: pal[i % pal.length],
        width: 1.4,
      });
    }
    const stroke = dark ? "#aaa" : "#444";
    return {
      height: 280,
      cursor: { drag: { x: true, y: false } },
      series,
      axes: [{ stroke }, { stroke }],
      scales: { x: { time: false } },
      legend: { live: true },
      hooks: { draw: [(u) => drawPhaseMarkers(u, phaseStartsMs, dark)] },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dark, labelsKey, phasesKey]);

  const data = useMemo<AlignedData>(
    () => [multi.ts.map((t) => t / 1000), ...multi.series.map((s) => s.damage)] as AlignedData,
    [multi],
  );

  if (!multi.series.length || !multi.ts.length)
    return <>Sem eventos de dano para exibir.</>;
  return <UplotChart options={options} data={data} />;
}
