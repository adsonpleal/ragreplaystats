// Lazy Firebase init — the SDK isn't loaded unless someone shares or opens
// a shared link, keeping first-paint cheap for users dropping a local file.

import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  Bytes,
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  limit as fbLimit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  startAfter,
  Timestamp,
  type Firestore,
  type QueryDocumentSnapshot,
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyBqceBTU2JscflNsx8L0pNJJpNhJMgqOSE",
  authDomain: "ragreplaystats.firebaseapp.com",
  projectId: "ragreplaystats",
  storageBucket: "ragreplaystats.firebasestorage.app",
  messagingSenderId: "53098962801",
  appId: "1:53098962801:web:bb04a8b362accb7c04a0d0",
};

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
 * Page through recent replays, newest first. The Firestore JS SDK doesn't
 * support per-field projection, so the server still ships the bytes blob —
 * we just don't read it. Acceptable cost at v1; if list bandwidth becomes a
 * problem move summaries to their own collection.
 */
export async function listRecentReplays(
  pageSize: number,
  cursor?: QueryDocumentSnapshot,
): Promise<{ items: ReplayListItem[]; lastDoc: QueryDocumentSnapshot | null }> {
  const col = collection(getDb(), COLLECTION);
  const constraints = cursor
    ? [orderBy("uploadedAt", "desc"), startAfter(cursor), fbLimit(pageSize)]
    : [orderBy("uploadedAt", "desc"), fbLimit(pageSize)];
  const snap = await getDocs(query(col, ...constraints));
  const items: ReplayListItem[] = snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    return {
      id: d.id,
      fileName:
        typeof data.fileName === "string" ? data.fileName : `${d.id}.rrf`,
      uploadedAt:
        data.uploadedAt instanceof Timestamp
          ? data.uploadedAt.toDate()
          : null,
      player: typeof data.player === "string" ? data.player : null,
      map: typeof data.map === "string" ? data.map : null,
      recordedAt:
        data.recordedAt instanceof Timestamp
          ? data.recordedAt.toDate()
          : null,
      durationMs:
        typeof data.durationMs === "number" ? data.durationMs : null,
      totalDamage:
        typeof data.totalDamage === "number" ? data.totalDamage : null,
      avgDps: typeof data.avgDps === "number" ? data.avgDps : null,
      damageEvents:
        typeof data.damageEvents === "number" ? data.damageEvents : null,
      kills: typeof data.kills === "number" ? data.kills : null,
      entitiesSeen:
        typeof data.entitiesSeen === "number" ? data.entitiesSeen : null,
      handledPackets:
        typeof data.handledPackets === "number" ? data.handledPackets : null,
      packetCount:
        typeof data.packetCount === "number" ? data.packetCount : null,
    };
  });
  return { items, lastDoc: snap.docs[snap.docs.length - 1] ?? null };
}

export type { QueryDocumentSnapshot };
