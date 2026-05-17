// Lazy Firebase init — the SDK isn't loaded unless someone shares or opens
// a shared link, keeping first-paint cheap for users dropping a local file.

import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  addDoc,
  Bytes,
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  increment,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  type Firestore,
  type QueryDocumentSnapshot,
} from "firebase/firestore";

/**
 * Production Firestore project — what's deployed to ragnarecap.web.app.
 * Real user data lives here; we read/write it for real visits and uploads.
 */
const prodConfig = {
  apiKey: "AIzaSyBqceBTU2JscflNsx8L0pNJJpNhJMgqOSE",
  authDomain: "ragreplaystats.firebaseapp.com",
  projectId: "ragreplaystats",
  storageBucket: "ragreplaystats.firebasestorage.app",
  messagingSenderId: "53098962801",
  appId: "1:53098962801:web:bb04a8b362accb7c04a0d0",
};

/**
 * Dev Firestore project — used only by `vite dev`. Keeps HMR-storm reads
 * and test uploads out of the production project's quota and metrics.
 * Rules + indexes are deployed via `firebase deploy --project ragreplaystats-dev`.
 */
const devConfig = {
  apiKey: "AIzaSyCUQWHZ_CCRSzAeD1rR0qBYuVJwZZhImpw",
  authDomain: "ragreplaystats-dev.firebaseapp.com",
  projectId: "ragreplaystats-dev",
  storageBucket: "ragreplaystats-dev.firebasestorage.app",
  messagingSenderId: "463678398388",
  appId: "1:463678398388:web:8b6128ba2ed579adaf5ce1",
};

// Vite injects `import.meta.env.DEV === true` during `vite dev`, false in
// `vite build`. So `vite build` always points production at prod, and
// `npm run dev` automatically lands on the dev project.
const firebaseConfig = import.meta.env.DEV ? devConfig : prodConfig;

let app: FirebaseApp | null = null;
let db: Firestore | null = null;

function getDb(): Firestore {
  if (!db) {
    if (!app) app = initializeApp(firebaseConfig);
    db = getFirestore(app);
  }
  return db;
}

const COLLECTION = "replays";

/** Generates a 10-char random slug from a 56-symbol confusion-free alphabet. */
export function generateReplayId(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const arr = crypto.getRandomValues(new Uint8Array(10));
  let id = "";
  for (const b of arr) id += alphabet[b % alphabet.length];
  return id;
}

/**
 * Per-(player, MVP species) record denormalized into the replay doc at
 * upload time. Powers the cross-replay MVP leaderboard without requiring
 * the leaderboard to download bytes blobs.
 */
export type MvpRecord = {
  view: number;
  name: string;
  playerAid: number;
  playerName: string;
  /** Sum of damage events from this player to this MVP species. */
  totalDamage: number;
  /** Biggest single damage event (one cast / one auto-attack). */
  highestHit: number;
  combatSpanMs: number;
  dps: number;
};

/**
 * Summary metadata denormalized into the replay doc at upload time so the
 * "recent replays" list can render rows without downloading bytes.
 */
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
  /** Subset of ReplaySummary that may be missing on legacy docs. */
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
  /** Empty array when missing on legacy docs. */
  mvpRecords: MvpRecord[];
};

export async function uploadReplay(
  bytes: Uint8Array,
  fileName: string,
  summary?: ReplaySummary,
): Promise<string> {
  if (bytes.byteLength >= 1024 * 1024) {
    throw new Error(
      "Arquivo grande demais para o compartilhamento (limite 1 MB).",
    );
  }
  const id = generateReplayId();
  const payload: Record<string, unknown> = {
    bytes: Bytes.fromUint8Array(bytes),
    uploadedAt: serverTimestamp(),
    fileName: fileName.slice(0, 200),
  };
  if (summary) {
    payload.player = summary.player.slice(0, 50);
    payload.map = summary.map.slice(0, 50);
    payload.recordedAt = Timestamp.fromDate(summary.recordedAt);
    payload.durationMs = Math.round(summary.durationMs);
    payload.totalDamage = Math.round(summary.totalDamage);
    payload.avgDps = Math.round(summary.avgDps);
    payload.damageEvents = Math.round(summary.damageEvents);
    payload.kills = Math.round(summary.kills);
    payload.entitiesSeen = Math.round(summary.entitiesSeen);
    payload.handledPackets = Math.round(summary.handledPackets);
    payload.packetCount = Math.round(summary.packetCount);
    if (summary.mvpRecords && summary.mvpRecords.length) {
      // Belt-and-suspenders: aggregator already caps at 200 and sorts; we
      // re-truncate + sanitise here so a doc never grows unbounded even if
      // a caller passes a hand-built summary.
      payload.mvpRecords = summary.mvpRecords.slice(0, 200).map((r) => ({
        view: Math.round(r.view),
        name: r.name.slice(0, 40),
        playerAid: Math.round(r.playerAid),
        playerName: r.playerName.slice(0, 50),
        totalDamage: Math.round(r.totalDamage),
        highestHit: Math.round(r.highestHit),
        combatSpanMs: Math.round(r.combatSpanMs),
        dps: Math.round(r.dps),
      }));
    }
  }
  await setDoc(doc(getDb(), COLLECTION, id), payload);
  return id;
}

export type FetchedReplay = {
  bytes: Uint8Array;
  fileName: string;
};

export async function fetchReplay(id: string): Promise<FetchedReplay | null> {
  const snap = await getDoc(doc(getDb(), COLLECTION, id));
  if (!snap.exists()) return null;
  const data = snap.data() as { bytes: Bytes; fileName?: string };
  return {
    bytes: data.bytes.toUint8Array(),
    fileName: data.fileName ?? `${id}.rrf`,
  };
}

/**
 * Bulk fetch of recent replay summaries via Firestore REST's `runQuery`
 * with a `select` projection — drops the `bytes` blob (by far the largest
 * field) so a few hundred docs is a small payload. The client holds the
 * whole list and does case-insensitive substring filtering locally without
 * per-keystroke round trips. The regular Firebase JS SDK has no field
 * projection, hence the REST detour. Reads are public per firestore.rules,
 * so the API key alone is enough; no auth token needed.
 */
export async function listRecentReplays(
  maxItems = 300,
): Promise<ReplayListItem[]> {
  const url =
    `https://firestore.googleapis.com/v1/projects/` +
    `${firebaseConfig.projectId}/databases/(default)/documents:runQuery` +
    `?key=${firebaseConfig.apiKey}`;
  const body = {
    structuredQuery: {
      from: [{ collectionId: COLLECTION }],
      select: {
        fields: [
          { fieldPath: "fileName" },
          { fieldPath: "uploadedAt" },
          { fieldPath: "player" },
          { fieldPath: "map" },
          { fieldPath: "recordedAt" },
          { fieldPath: "durationMs" },
          { fieldPath: "totalDamage" },
          { fieldPath: "avgDps" },
          { fieldPath: "damageEvents" },
          { fieldPath: "kills" },
          { fieldPath: "entitiesSeen" },
          { fieldPath: "handledPackets" },
          { fieldPath: "packetCount" },
          { fieldPath: "mvpRecords" },
        ],
      },
      orderBy: [
        { field: { fieldPath: "uploadedAt" }, direction: "DESCENDING" },
      ],
      limit: maxItems,
    },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Firestore runQuery failed: ${res.status}`);
  }
  const rows = (await res.json()) as Array<{
    document?: { name: string; fields?: Record<string, unknown> };
  }>;
  return rows
    .filter((r) => r.document)
    .map((r) => parseRestSummary(r.document!));
}

function parseRestSummary(doc: {
  name: string;
  fields?: Record<string, unknown>;
}): ReplayListItem {
  const id = doc.name.split("/").pop() ?? "";
  const f = doc.fields ?? {};
  return {
    id,
    fileName: restStr(f.fileName) ?? `${id}.rrf`,
    uploadedAt: restTimestamp(f.uploadedAt),
    player: restStr(f.player),
    map: restStr(f.map),
    recordedAt: restTimestamp(f.recordedAt),
    durationMs: restNum(f.durationMs),
    totalDamage: restNum(f.totalDamage),
    avgDps: restNum(f.avgDps),
    damageEvents: restNum(f.damageEvents),
    kills: restNum(f.kills),
    entitiesSeen: restNum(f.entitiesSeen),
    handledPackets: restNum(f.handledPackets),
    packetCount: restNum(f.packetCount),
    mvpRecords: restMvpRecords(f.mvpRecords),
  };
}

/**
 * Defense in depth: even though the rules cap `mvpRecords` at 250 entries
 * and the writer trims strings, a doc written by an admin-SDK script or
 * through a future schema drift could still arrive with overlong content.
 * Trim on parse so a poisoned doc can't blow up the combobox or table UI.
 */
const MVP_RECORDS_PARSE_CAP = 250;
const MVP_NAME_PARSE_CAP = 80;
const MVP_PLAYER_NAME_PARSE_CAP = 80;

function restMvpRecords(v: unknown): MvpRecord[] {
  if (!v || typeof v !== "object") return [];
  const arr = (v as { arrayValue?: { values?: unknown[] } }).arrayValue?.values;
  if (!Array.isArray(arr)) return [];
  const out: MvpRecord[] = [];
  for (const entry of arr.slice(0, MVP_RECORDS_PARSE_CAP)) {
    const f = (entry as { mapValue?: { fields?: Record<string, unknown> } })
      .mapValue?.fields;
    if (!f) continue;
    out.push({
      view: restNum(f.view) ?? 0,
      name: (restStr(f.name) ?? "").slice(0, MVP_NAME_PARSE_CAP),
      playerAid: restNum(f.playerAid) ?? 0,
      playerName: (restStr(f.playerName) ?? "").slice(0, MVP_PLAYER_NAME_PARSE_CAP),
      totalDamage: restNum(f.totalDamage) ?? 0,
      highestHit: restNum(f.highestHit) ?? 0,
      combatSpanMs: restNum(f.combatSpanMs) ?? 0,
      dps: restNum(f.dps) ?? 0,
    });
  }
  return out;
}

function restStr(v: unknown): string | null {
  if (!v || typeof v !== "object") return null;
  const sv = (v as { stringValue?: unknown }).stringValue;
  return typeof sv === "string" ? sv : null;
}

function restNum(v: unknown): number | null {
  if (!v || typeof v !== "object") return null;
  const iv = (v as { integerValue?: unknown }).integerValue;
  if (typeof iv === "string") {
    const n = parseInt(iv, 10);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof iv === "number") return iv;
  const dv = (v as { doubleValue?: unknown }).doubleValue;
  if (typeof dv === "number") return dv;
  if (typeof dv === "string") {
    const n = parseFloat(dv);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function restTimestamp(v: unknown): Date | null {
  if (!v || typeof v !== "object") return null;
  const tv = (v as { timestampValue?: unknown }).timestampValue;
  if (typeof tv !== "string") return null;
  const d = new Date(tv);
  return Number.isFinite(d.getTime()) ? d : null;
}

// ---------------------------------------------------------------------------
// Suggestions / comments
// ---------------------------------------------------------------------------

const SUGGESTIONS_COLLECTION = "suggestions";
export const SUGGESTION_MAX_LENGTH = 500;

export type Suggestion = {
  id: string;
  text: string;
  createdAt: Date | null;
  upvotes: number;
  downvotes: number;
};

export async function createSuggestion(text: string): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Sugestão vazia.");
  if (trimmed.length > SUGGESTION_MAX_LENGTH) {
    throw new Error(`Sugestão muito longa (máx. ${SUGGESTION_MAX_LENGTH}).`);
  }
  const ref = await addDoc(collection(getDb(), SUGGESTIONS_COLLECTION), {
    text: trimmed,
    createdAt: serverTimestamp(),
    upvotes: 0,
    downvotes: 0,
  });
  return ref.id;
}

export async function listSuggestions(): Promise<Suggestion[]> {
  const col = collection(getDb(), SUGGESTIONS_COLLECTION);
  const snap = await getDocs(query(col, orderBy("createdAt", "desc")));
  return snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    return {
      id: d.id,
      text: typeof data.text === "string" ? data.text : "",
      createdAt:
        data.createdAt instanceof Timestamp ? data.createdAt.toDate() : null,
      upvotes: typeof data.upvotes === "number" ? data.upvotes : 0,
      downvotes: typeof data.downvotes === "number" ? data.downvotes : 0,
    };
  });
}

export async function voteSuggestion(
  id: string,
  direction: "up" | "down",
): Promise<void> {
  const ref = doc(getDb(), SUGGESTIONS_COLLECTION, id);
  const field = direction === "up" ? "upvotes" : "downvotes";
  await updateDoc(ref, { [field]: increment(1) });
}

export type { QueryDocumentSnapshot };
