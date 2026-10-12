import { useEffect, useState } from "react";
import type { ReplayListItem } from "../api";
import { ensureLoaded, getCached, isFresh, STALE_MS } from "../replay-summaries";

/**
 * Loads the shared replay-summary list via the bulk-fetch cache (used by both
 * the home "recent replays" section and the leaderboard). Resolves instantly
 * with no spinner when the cache is still fresh. Rechecks while visible and
 * when returning to the tab, including restoration from the back/forward cache.
 */
export function useReplaySummaries() {
  const [items, setItems] = useState<ReplayListItem[]>(getCached);
  const [loading, setLoading] = useState(() => !isFresh() && !getCached().length);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      // Keep existing rows visible during background updates.
      if (!getCached().length && !isFresh()) setLoading(true);
      void ensureLoaded()
        .then((data) => {
          if (!cancelled) {
            setItems(data);
            setError(null);
          }
        })
        .catch((e) => {
          if (!cancelled) setError((e as Error).message);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };

    refresh();
    const timer = window.setInterval(refresh, STALE_MS);
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  return { items, loading, error };
}
