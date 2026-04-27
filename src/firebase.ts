// Lazy Firebase init — the SDK isn't loaded unless someone shares or opens
// a shared link, keeping first-paint cheap for users dropping a local file.

import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  Bytes,
  doc,
  getDoc,
  getFirestore,
  serverTimestamp,
  setDoc,
  type Firestore,
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

export async function uploadReplay(
  bytes: Uint8Array,
  fileName: string,
): Promise<string> {
  if (bytes.byteLength >= 1024 * 1024) {
    throw new Error(
      "Arquivo grande demais para o compartilhamento (limite 1 MB).",
    );
  }
  const id = generateReplayId();
  await setDoc(doc(getDb(), COLLECTION, id), {
    bytes: Bytes.fromUint8Array(bytes),
    uploadedAt: serverTimestamp(),
    fileName: fileName.slice(0, 200),
  });
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
