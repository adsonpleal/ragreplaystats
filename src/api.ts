// Client for the Worker API in worker/index.ts. Replaces the Firebase SDK that
// used to live in src/firebase.ts.
//
// Two things this removes beyond the vendor swap:
//   - the Firebase JS SDK itself, which was lazily imported to keep first paint
//     cheap for people just dropping a local file. Same-origin `fetch` needs no
//     such dance, so the lazy-init machinery is gone.
//   - the 1 MB upload ceiling. That was never a policy number — it was
//     Firestore's hard per-document size limit, and the bytes were stored inside
//     the document. They live in R2 now, so the cap is a real choice. The Worker
//     enforces it; the check here only fails fast so the UI can say why without
//     round-tripping 5 MB first. Both read the same constant from shared/.

import {
  MAX_FILE_NAME,
  MAX_UPLOAD_BYTES,
  tooLargeMessage,
  type MvpRecord,
} from "../shared/replay";

export type { MvpRecord };

/** Summary metadata stored with the replay so the list renders without bytes. */
export type ReplaySummary = {
  player: string;
  map: string;
  recordedAt: Date;
  durationMs: number;
  totalDamage: number;
  avgDps: number;
  damageEvents: number;
  kills: number;
  entitiesSeen: number;
  handledPackets: number;
  packetCount: number;
  /** Per-(player, MVP species) leaderboard rows. Empty when no boss damaged. */
  mvpRecords: MvpRecord[];
};

export type ReplayListItem = {
  id: string;
  fileName: string;
  uploadedAt: Date | null;
  /** Subset that may be missing on rows migrated from legacy Firestore docs. */
  player: string | null;
  map: string | null;
  recordedAt: Date | null;
  durationMs: number | null;
  totalDamage: number | null;
  avgDps: number | null;
  damageEvents: number | null;
  kills: number | null;
  entitiesSeen: number | null;
  handledPackets: number | null;
  packetCount: number | null;
  /** Size of the stored .rrf. Null on rows migrated before it was recorded. */
  byteSize: number | null;
  /** Empty array when the replay damaged no MVP. */
  mvpRecords: MvpRecord[];
};

export type FetchedReplay = {
  bytes: Uint8Array;
  fileName: string;
};

/**
 * What GET /api/replays actually puts on the wire: `ReplayListItem` with the two
 * timestamps still as epoch millis (JSON has no Date).
 *
 * Declaring it as a transform of `ReplayListItem` rather than re-listing every
 * field is what makes the two halves typecheck against each other. With
 * per-field `as` casts a renamed column compiled cleanly on both sides and only
 * showed up at runtime as null cells in the UI.
 */
type WireListItem = Omit<ReplayListItem, "uploadedAt" | "recordedAt"> & {
  uploadedAt: number | null;
  recordedAt: number | null;
};

const API = "/api/replays";

/** Epoch millis (what the API sends) -> Date, tolerating null/absent. */
function toDate(ms: unknown): Date | null {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms) : null;
}

async function apiError(res: Response): Promise<never> {
  let message = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) message = body.error;
  } catch {
    // Non-JSON error body (a proxy page, say) — the status is all we have.
  }
  throw new Error(message);
}

export async function uploadReplay(
  // `Uint8Array<ArrayBuffer>`, not the default `Uint8Array<ArrayBufferLike>`:
  // BlobPart excludes SharedArrayBuffer-backed views, and pinning it here is
  // what lets the Blob take the view directly instead of defensively copying
  // up to 5 MB to launder the type.
  bytes: Uint8Array<ArrayBuffer>,
  fileName: string,
  summary?: ReplaySummary,
): Promise<string> {
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error(tooLargeMessage());

  const form = new FormData();
  // No defensive copy: the Blob constructor already reads only the view's own
  // [byteOffset, byteLength) range, so slicing first would just duplicate up to
  // 5 MB for nothing.
  form.append("file", new Blob([bytes], { type: "application/octet-stream" }), fileName);
  form.append("fileName", fileName.slice(0, MAX_FILE_NAME));
  if (summary) {
    form.append(
      "summary",
      JSON.stringify({ ...summary, recordedAt: summary.recordedAt.toISOString() }),
    );
  }

  const res = await fetch(API, { method: "POST", body: form });
  if (!res.ok) await apiError(res);
  const { id } = (await res.json()) as { id: string };
  return id;
}

export async function fetchReplay(id: string): Promise<FetchedReplay | null> {
  const res = await fetch(`${API}/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) await apiError(res);
  const buf = await res.arrayBuffer();
  const header = res.headers.get("X-Replay-Filename");
  return {
    bytes: new Uint8Array(buf),
    fileName: header ? decodeURIComponent(header) : `${id}.rrf`,
  };
}

/**
 * Every replay summary, newest first.
 *
 * Still the whole collection rather than a page: the leaderboard's top-N is
 * all-time, so a recent slice would silently drop records. What changed is the
 * cost — this is one edge-cached response from our own Worker instead of a
 * paged Firestore REST query run per visitor, and D1 does the paging-free read
 * in one statement. The response is edge-cached (see the Cache-Control the
 * Worker sets), so most visitors are served by the CDN and never reach it.
 */
export async function listRecentReplays(): Promise<ReplayListItem[]> {
  const res = await fetch(API);
  if (!res.ok) await apiError(res);
  const { items } = (await res.json()) as { items: WireListItem[] };
  // The Worker already emits camelCase and nulls, so the only work left is
  // millis -> Date. Spreading keeps new columns flowing through without a
  // hand-written line here for each one.
  return items.map((d) => ({
    ...d,
    uploadedAt: toDate(d.uploadedAt),
    recordedAt: toDate(d.recordedAt),
  }));
}
