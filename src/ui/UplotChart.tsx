import { useEffect, useRef } from "react";
import uPlot, { type AlignedData, type Options } from "uplot";

/**
 * React wrapper around a uPlot instance. The chart is (re)created whenever the
 * `options` object identity changes — so **callers must memoise `options`**
 * (e.g. with `useMemo` keyed on dark-mode + labels) or the chart will rebuild
 * on every render and lose cursor/drag state. `data` changes are applied with
 * the cheap `setData`, and container resizes flow through a `ResizeObserver`.
 *
 * `width` is injected from the host element's measured width at creation, so
 * `options.width` is optional.
 */
export function UplotChart({
  options,
  data,
  className,
}: {
  options: Omit<Options, "width"> & { width?: number };
  data: AlignedData;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  // Hold the latest data so a rebuild (options change) starts from current data
  // without listing `data` as an effect dependency.
  const dataRef = useRef(data);
  dataRef.current = data;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const width = host.clientWidth || options.width || 1000;
    const u = new uPlot({ ...options, width }, dataRef.current, host);
    plotRef.current = u;

    const ro = new ResizeObserver(() => {
      const w = host.clientWidth;
      if (w && w !== u.width) u.setSize({ width: w, height: u.height });
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      u.destroy();
      plotRef.current = null;
    };
  }, [options]);

  useEffect(() => {
    plotRef.current?.setData(data);
  }, [data]);

  return <div ref={hostRef} className={className} />;
}
