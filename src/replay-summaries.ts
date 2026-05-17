// Shared bulk-fetch cache for the replay summary list.
//
// Both the home view's "Replays recentes" section and the /leaderboard page
// consume the same projected REST query (no bytes blob). Sharing the cache
// means a typical session does **one** bulk fetch instead of one per route
// visit, and a stale-while-revalidate TTL keeps re-fetches infrequent — both
// matter because each returned doc costs a Firestore read.
//
// Consumers:
//   - call `ensureLoaded()` to read the latest set (may resolve synchronously
//     from cache or async after a fetch)
//   - `invalidate()` after a write (e.g. fresh upload) so the next visit
//     pulls again instead of showing stale data
//   - `isLoading()` / `isFresh()` / `getCached()` to drive UI without
//     duplicating per-consumer loading state

import { listRecentReplays, type ReplayListItem } from "./firebase.js";

/**
 * Items are considered fresh for this long after a successful fetch. A
 * subsequent `ensureLoaded()` within the window resolves instantly with the
 * cached set. Tuned by feel: short enough that a stale leaderboard isn't a
 * surprise, long enough to dedupe rapid route switches and HMR reloads.
 */
const STALE_MS = 5 * 60 * 1000;

let items: ReplayListItem[] = [];
let loadedAt: number | null = null;
let inFlight: Promise<ReplayListItem[]> | null = null;

export function isFresh(): boolean {
  return loadedAt !== null && Date.now() - loadedAt < STALE_MS;
}

export function isLoading(): boolean {
  return inFlight !== null;
}

export function getCached(): ReplayListItem[] {
  return items;
}

/**
 * Returns the cached items if still fresh, otherwise kicks off a fetch and
 * resolves with the new set. Concurrent callers are coalesced onto the same
 * in-flight promise so two routes visited back-to-back share one network
 * request.
 */
export async function ensureLoaded(): Promise<ReplayListItem[]> {
  if (isFresh()) return items;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const data = await listRecentReplays();
      items = data;
      loadedAt = Date.now();
      return data;
    } finally {
      // Rejection path: `loadedAt` stays null and `inFlight` clears, so the
      // next route visit retries immediately. Intentional — at this scale a
      // backoff would mostly inconvenience the user; if errors become noisy
      // in observability, add a short negative-cache window here.
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * Force the next `ensureLoaded()` to refetch. Call after a write that the
 * user expects to see reflected immediately (e.g. their own replay upload).
 */
export function invalidate() {
  loadedAt = null;
}
