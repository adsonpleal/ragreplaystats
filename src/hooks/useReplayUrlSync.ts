import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useAppStore } from "../store/useAppStore";

/**
 * Keeps the `?r=<id>` query param and the loaded replay in sync on the home
 * route (successor to the old loadFromUrl / openRecentReplay / share-link
 * wiring):
 *   - an incoming `?r=` that isn't already loaded triggers a fetch + decode
 *   - a replay that gains a share id with no `?r=` in the URL (i.e. a local
 *     file that was just uploaded) has the id written into the URL, with
 *     replaceState semantics so no extra history entry appears
 *
 * The `?r=` is the source of truth for *which* replay is open; the store only
 * ever fills a gap. Reflecting the store back over an existing (different)
 * `?r=` instead would fight the fetch above and never converge — see the
 * comment on the second effect.
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

  // Only ever *adds* a missing `?r=`; it never overwrites one that is already
  // there. The store keeps the previous replay alive across route changes (so
  // Back/Forward don't refetch), so on arriving at `/?r=<new id>` from the
  // leaderboard the store's `shareId` is still the *old* replay. Writing that
  // back into the URL would send the effect above off to re-fetch the old
  // replay, whose load then makes this effect write the other id back — the
  // two chase each other through `?r=` forever, flipping the view between the
  // two replays until the tab is closed.
  useEffect(() => {
    if (shareId && !r) {
      setSearchParams(
        (prev) => {
          prev.set("r", shareId);
          return prev;
        },
        { replace: true },
      );
    }
    // `setSearchParams` is a fresh closure every render; the id/URL pair is
    // what actually decides whether there's anything to write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareId, r]);

  return r;
}
