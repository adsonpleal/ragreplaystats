// Shared by the browser bundle (src/) and the Cloudflare Worker (worker/).
//
// These two are separate TypeScript projects with separate tsconfigs, and both
// list this directory in their `include` — Vite bundles it from `src/`, wrangler
// bundles it from `worker/`. Everything here must therefore stay free of DOM and
// of Workers globals: plain types and pure functions only.
//
// It exists because the upload limit, its user-facing message, and the MVP record
// shape all have to agree across the wire, and a comment saying "keep in sync"
// is not a mechanism. Drift here used to be silent in both directions: a lower
// client cap rejects uploads the server would accept, a higher one makes someone
// push the whole file to earn a 413.

/**
 * Upload ceiling. Under Firestore this was 1 MiB and was NOT a policy choice —
 * it was the hard per-document size limit, since the bytes were stored inside
 * the document. With the bytes in R2 the number is finally ours to pick.
 */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** Cap on the stored file name, applied on both sides of the upload. */
export const MAX_FILE_NAME = 200;

/** Matches the cap the old firestore.rules put on the mvpRecords array. */
export const MAX_MVP_RECORDS = 250;

export function tooLargeMessage(): string {
  return `Arquivo grande demais para o compartilhamento (limite ${
    MAX_UPLOAD_BYTES / 1024 / 1024
  } MB).`;
}

/**
 * Per-(player, MVP species) record stored alongside a replay. Powers the
 * cross-replay MVP leaderboard without downloading replay bytes.
 */
export type MvpRecord = {
  view: number;
  name: string;
  playerAid: number;
  playerName: string;
  /**
   * Resolved class/job name at upload time (e.g. "Executor", "Falcão do Vento").
   * Empty string when the recorder is a homunculus/mercenary or when the job DB
   * hadn't loaded yet at upload — those rows appear under the "(Sem classe)"
   * bucket on the leaderboard filter.
   */
  class: string;
  totalDamage: number;
  /** Biggest single damage event (one cast / one auto-attack). */
  highestHit: number;
  combatSpanMs: number;
  dps: number;
};

/**
 * Classes the Latam server renamed. Records uploaded before a rename carry the
 * old label, and the leaderboard's class filter compares by exact string — so
 * without this an old record is unreachable under its current class name.
 *
 * This used to run on every read, in the Firebase client. It runs at WRITE time
 * now (the Worker's upload path), which is the right depth: the value is
 * normalized once as it enters the database rather than on every render for the
 * rest of the table's life.
 */
const LEGACY_CLASS_RENAMES: Record<string, string> = {
  Arquimágico: "Magus",
  Assassino: "Executor",
  Ladino: "Mandraque",
  Patrulheiro: "Falcão do Vento",
  Poeta: "Maestro",
};

export function normalizeClass(cls: string): string {
  return LEGACY_CLASS_RENAMES[cls] ?? cls;
}
