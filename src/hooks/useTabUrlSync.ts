import { useEffect, useRef } from "react";
import { type Mode, useAppStore } from "../store/useAppStore";

const VALID_MODES: ReadonlySet<Mode> = new Set([
  "byPlayer",
  "byMonster",
  "stats",
  "dpsAnalysis",
]);

export function readTabFromUrl(): Mode | null {
  const raw = new URLSearchParams(location.search).get("tab");
  if (!raw) return null;
  return VALID_MODES.has(raw as Mode) ? (raw as Mode) : null;
}

/**
 * Two-way sync between the active explorer tab and the `?tab=` query param,
 * via replaceState so switching tabs doesn't pollute history — the React
 * successor to the old `syncTabToUrl` / `readTabFromUrl`. `byPlayer` is the
 * "default" tab and keeps the URL clean.
 *
 * Call once from the Explorer (which only mounts when a replay is loaded). On
 * mount it honours an incoming `?tab=…`; afterwards it mirrors mode → URL.
 */
export function useTabUrlSync() {
  const mode = useAppStore((s) => s.mode);
  const setMode = useAppStore((s) => s.setMode);
  const firstReflect = useRef(true);

  // Honour ?tab=… once when the explorer first mounts for a replay.
  useEffect(() => {
    const urlTab = readTabFromUrl();
    if (urlTab && urlTab !== useAppStore.getState().mode) setMode(urlTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reflect the active tab back to the URL — but skip the initial render so a
  // fresh load with no ?tab doesn't gain a redundant ?tab=stats.
  useEffect(() => {
    if (firstReflect.current) {
      firstReflect.current = false;
      return;
    }
    const url = new URL(location.href);
    if (mode === "byPlayer") url.searchParams.delete("tab");
    else url.searchParams.set("tab", mode);
    const next = url.pathname + (url.search || "");
    if (next !== location.pathname + location.search) {
      history.replaceState(null, "", next);
    }
  }, [mode]);
}
