import { useEffect, useState } from "react";

// Shared chart palettes (the old bar-chart / dps-chart / line-chart / scatter
// modules each had their own identical copy). Index 0 is the "local player"
// red; the rest cycle for additional series.
export const PALETTE_LIGHT = [
  "#c5462a", "#1f77b4", "#2ca02c", "#9467bd", "#ff7f0e",
  "#17becf", "#d62728", "#8c564b", "#e377c2", "#7f7f7f",
  "#bcbd22", "#5b8c5a",
];
export const PALETTE_DARK = [
  "#ff7a55", "#62a4d9", "#52d36b", "#bf99ee", "#ffae42",
  "#56dde9", "#ff5b5d", "#c89388", "#f7a3da", "#a6a6a6",
  "#e3e266", "#7fc185",
];

export function isDark(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

export function palette(dark = isDark()): string[] {
  return dark ? PALETTE_DARK : PALETTE_LIGHT;
}

/** Re-renders the component when the OS/browser colour scheme flips. */
export function useDarkMode(): boolean {
  const [dark, setDark] = useState(isDark);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return dark;
}
