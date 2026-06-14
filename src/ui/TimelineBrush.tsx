import { useEffect, useRef } from "react";
import uPlot, { type Options } from "uplot";
import type { BrushSeries } from "../aggregate/index";
import { PALETTE_DARK, PALETTE_LIGHT, useDarkMode } from "./palette";

type Range = { startMs: number; endMs: number } | null;

function hexAlpha(hex: string, alpha: number): string {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Timeline brush strip: total-damage curve + kill-event dot markers.
 * Drag-selecting fires `onSelect`; `range` re-paints a saved selection rect.
 * The uPlot instance is recreated when the data, theme, or saved range change
 * (mirrors the old recreate-on-rerender behaviour), and `onSelect` is deduped
 * against the current range so restoring the rect doesn't loop.
 */
export function TimelineBrush({
  data,
  range,
  onSelect,
}: {
  data: BrushSeries;
  range: Range;
  onSelect: (range: Range) => void;
}) {
  const dark = useDarkMode();
  const hostRef = useRef<HTMLDivElement>(null);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const rangeKey = range ? `${range.startMs}-${range.endMs}` : "null";
  const dataKey = `${data.ts.length}:${data.ts[0] ?? 0}:${data.ts[data.ts.length - 1] ?? 0}`;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !data.ts.length) return;
    host.innerHTML = "";

    const palette = dark ? PALETTE_DARK : PALETTE_LIGHT;
    const xsSec = data.ts.map((tms) => tms / 1000);

    const distinctViews: number[] = [];
    for (const v of data.killViews) if (!distinctViews.includes(v)) distinctViews.push(v);
    const colorByView = new Map<number, string>();
    distinctViews.forEach((v, i) => colorByView.set(v, palette[i % palette.length]));

    const peakDamage = data.damage.reduce((mx, v) => (v > mx ? v : mx), 0);
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

    // setSelect fires during the gesture and on release; throttle + dedup.
    let lastSelectAt = 0;
    const stroke = dark ? "#aaa" : "#444";

    const options: Options = {
      width: host.clientWidth || 1000,
      height: 100,
      padding: [4, 12, 0, 0],
      cursor: { drag: { x: true, y: false, setScale: false }, points: { show: false } },
      series: [
        { label: "Tempo (s)" },
        { label: "Dano por bucket", stroke: palette[0], fill: hexAlpha(palette[0], 0.12), width: 1 },
      ],
      axes: [{ stroke }, { stroke, show: false }],
      scales: { x: { time: false } },
      legend: { show: false },
      hooks: {
        draw: [drawDots],
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

    const chart = new uPlot(options, [xsSec, data.damage], host);
    const ro = new ResizeObserver(() => {
      const w = host.clientWidth;
      if (w && w !== chart.width) chart.setSize({ width: w, height: chart.height });
    });
    ro.observe(host);
    return () => {
      ro.disconnect();
      chart.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey, dark, rangeKey]);

  if (!data.ts.length) return null;
  return <div ref={hostRef} id="brush-chart" />;
}
