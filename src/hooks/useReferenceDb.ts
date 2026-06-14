import { useEffect } from "react";
import { loadReferenceDb } from "../db/loader";
import { useAppStore } from "../store/useAppStore";

// Module-level guard so the DB is fetched exactly once for the app's lifetime,
// even if several components call the hook.
let dbPromise: Promise<void> | null = null;

/**
 * Loads the reference DB (job names + the pc-class index) once and stashes it
 * in the store. Returns the current db (null until the fetch resolves).
 */
export function useReferenceDb() {
  const db = useAppStore((s) => s.db);
  useEffect(() => {
    if (db || dbPromise) return;
    dbPromise = loadReferenceDb().then((loaded) => {
      useAppStore.getState().setDb(loaded);
    });
  }, [db]);
  return db;
}
