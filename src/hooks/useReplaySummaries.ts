import { useEffect, useState } from "react";
import type { ReplayListItem } from "../firebase";
import { ensureLoaded, getCached, isFresh } from "../replay-summaries";

/**
 * Loads the shared replay-summary list via the bulk-fetch cache (used by both
 * the home "recent replays" section and the leaderboard). Resolves instantly
 * with no spinner when the cache is still fresh.
 */
export function useReplaySummaries() {
  const [items, setItems] = useState<ReplayListItem[]>(() => (isFresh() ? getCached() : []));
  const [loading, setLoading] = useState(() => !isFresh());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isFresh()) {
      setItems(getCached());
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    ensureLoaded()
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
    return () => {
      cancelled = true;
    };
  }, []);

  return { items, loading, error };
}
