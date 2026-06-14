import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useAppStore } from "../store/useAppStore";

/**
 * Keeps the `?r=<id>` query param and the loaded replay in sync on the home
 * route (successor to the old loadFromUrl / openRecentReplay / share-link
 * wiring):
 *   - an incoming `?r=` that isn't already loaded triggers a fetch + decode
 *   - once a replay is shared (shareId set), the id is reflected back into the
 *     URL with replaceState semantics (no extra history entry)
 *
 * Returns the current `?r=` value so the page can hide the recent list while a
 * shared replay is loading.
 */
export function useReplayUrlSync(): string | null {
  const [searchParams, setSearchParams] = useSearchParams();
  const r = searchParams.get("r");
  const shareId = useAppStore((s) => s.shareId);
  const loadReplayFromUrl = useAppStore((s) => s.loadReplayFromUrl);
  // The id we last kicked a fetch for — guards against re-fetching (and against
  // retry storms when a fetch fails, leaving shareId null but r set).
  const requestedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!r) {
      requestedRef.current = null;
      return;
    }
    if (shareId === r || requestedRef.current === r) return;
    requestedRef.current = r;
    void loadReplayFromUrl(r);
  }, [r, shareId, loadReplayFromUrl]);

  useEffect(() => {
    if (shareId && shareId !== r) {
      setSearchParams(
        (prev) => {
          prev.set("r", shareId);
          return prev;
        },
        { replace: true },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareId]);

  return r;
}
