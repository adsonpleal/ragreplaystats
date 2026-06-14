import { create } from "zustand";
import { prefetchReplay } from "../divine-pride";
import type { ReferenceDb } from "../db/loader";
import { fetchReplay, uploadReplay } from "../firebase";
import { invalidate as invalidateSummariesCache } from "../replay-summaries";
import { buildReplaySummary } from "../features/replay/replaySummary";
import { t } from "../i18n";
import { decodeReplay } from "../rrf/decode";
import type { Range } from "../aggregate/index";
import type { Replay } from "../rrf/types";

export type Mode = "byPlayer" | "byMonster" | "stats" | "dpsAnalysis";

export type DragRange = { startMs: number; endMs: number } | null;

/**
 * Central app state — the React/Zustand successor to the single mutable
 * `state` object in the old `main.ts`. Routing (home/leaderboard/suggestions)
 * now lives in react-router, so it is not part of this store; everything else
 * is mirrored field-for-field.
 */
export type AppState = {
  replay: Replay | null;
  db: ReferenceDb | null;
  /**
   * Bumped whenever name data lands (reference DB load, or per-replay
   * divine-pride prefetch). The resolver closures are stable but start
   * returning real names instead of `mob#123` fallbacks once their maps
   * load — components read this so they re-render and re-resolve.
   */
  namesVersion: number;
  mode: Mode;
  /** Multi-select. First inserted = "primary" (drives breadcrumb + secondary). */
  selectedPlayers: Set<number>;
  selectedMonster: number | null;
  selectedTimeRange: Range;
  selectedMobSkillTarget: number | null;
  dpsAnalysisRange: DragRange;
  byPlayerCompareRange: DragRange;
  shareId: string | null;
  replayBytes: Uint8Array | null;
  replayFileName: string | null;
  openedFromUrl: boolean;
  /** Status line under the drop zone (parsing / decoded / upload / errors). */
  status: string;

  setDb: (db: ReferenceDb) => void;
  loadReplayFromBytes: (
    buf: ArrayBuffer,
    fileName: string,
    shareId: string | null,
  ) => void;
  loadReplayFromUrl: (id: string) => Promise<void>;
  /** Upload the currently-loaded replay + its summary; sets shareId on success. */
  uploadCurrent: () => Promise<void>;
  clearReplay: () => void;
  setStatus: (msg: string) => void;
  setShareId: (id: string) => void;

  setMode: (mode: Mode) => void;
  /** Toggle a player in/out of the multi-select; clears the monster if emptied. */
  togglePlayer: (aid: number) => void;
  setSelectedPlayers: (players: Set<number>) => void;
  selectMonster: (aid: number | null) => void;
  setSelectedTimeRange: (range: Range) => void;
  setSelectedMobSkillTarget: (aid: number | null) => void;
  setDpsAnalysisRange: (range: DragRange) => void;
  setByPlayerCompareRange: (range: DragRange) => void;
};

/** Fields reset to a clean slate whenever a new replay is loaded or cleared. */
const CLEARED_SELECTION = {
  selectedPlayers: new Set<number>(),
  selectedMonster: null,
  selectedTimeRange: null,
  selectedMobSkillTarget: null,
  dpsAnalysisRange: null,
  byPlayerCompareRange: null,
} as const;

export const useAppStore = create<AppState>((set, get) => ({
  replay: null,
  db: null,
  namesVersion: 0,
  mode: "stats",
  selectedPlayers: new Set(),
  selectedMonster: null,
  selectedTimeRange: null,
  selectedMobSkillTarget: null,
  dpsAnalysisRange: null,
  byPlayerCompareRange: null,
  shareId: null,
  replayBytes: null,
  replayFileName: null,
  openedFromUrl: false,
  status: "",

  setDb: (db) => set((s) => ({ db, namesVersion: s.namesVersion + 1 })),

  loadReplayFromBytes: (buf, fileName, shareId) => {
    const t0 = performance.now();
    const replay = decodeReplay(buf);
    const ms = (performance.now() - t0).toFixed(0);
    set({
      replay,
      ...CLEARED_SELECTION,
      selectedPlayers: new Set(),
      shareId,
      openedFromUrl: shareId != null,
      // Keep a copy of the raw bytes so the replay can be re-downloaded.
      replayBytes: new Uint8Array(buf).slice(),
      replayFileName: fileName,
      status: t.decoded(
        replay.totals.handledPackets,
        replay.totals.packetCount,
        ms,
        fileName,
      ),
    });
    // Load DP name databases in the background; bump namesVersion when ready so
    // any `mob#1234` / `skill#999` fallbacks become real names — but only if
    // this is still the active replay.
    void prefetchReplay(replay).then(() => {
      if (get().replay !== replay) return;
      set((s) => ({ namesVersion: s.namesVersion + 1 }));
    });
  },

  loadReplayFromUrl: async (id) => {
    set({ status: t.fetching(id) });
    try {
      const fetched = await fetchReplay(id);
      if (!fetched) {
        set({ status: t.notFound(id) });
        return;
      }
      get().loadReplayFromBytes(fetched.bytes.buffer as ArrayBuffer, fetched.fileName, id);
    } catch (err) {
      console.error(err);
      set({ status: t.fetchError((err as Error).message) });
    }
  },

  uploadCurrent: async () => {
    const { replay, replayBytes, replayFileName, db, status } = get();
    if (!replay || !replayBytes) return;
    set({ status: (status ? status + " · " : "") + t.uploading });
    try {
      const summary = buildReplaySummary(replay, db);
      const id = await uploadReplay(replayBytes, replayFileName ?? "replay.rrf", summary);
      // The shared summaries cache no longer reflects reality — drop it so a
      // return visit refetches and the new replay shows up immediately.
      invalidateSummariesCache();
      const url = new URL(location.href);
      url.searchParams.set("r", id);
      set({ shareId: id, status: t.shareReady(url.toString()) });
    } catch (err) {
      console.error(err);
      set({ status: t.uploadError((err as Error).message) });
    }
  },

  clearReplay: () =>
    set({
      replay: null,
      ...CLEARED_SELECTION,
      selectedPlayers: new Set(),
      shareId: null,
      replayBytes: null,
      replayFileName: null,
      openedFromUrl: false,
      status: "",
    }),

  setStatus: (status) => set({ status }),
  setShareId: (shareId) => set({ shareId }),

  setMode: (mode) =>
    set({
      mode,
      // Switching tabs drops any drill-down selection (old toggle behaviour).
      selectedPlayers: new Set(),
      selectedMonster: null,
      byPlayerCompareRange: null,
    }),

  togglePlayer: (aid) => {
    // Click toggles membership, preserving insertion order (first = primary).
    const next = new Set(get().selectedPlayers);
    if (next.has(aid)) next.delete(aid);
    else next.add(aid);
    // Removing the last player leaves nothing to drill into.
    if (next.size === 0) set({ selectedPlayers: next, selectedMonster: null });
    else set({ selectedPlayers: next });
  },

  setSelectedPlayers: (selectedPlayers) => set({ selectedPlayers }),
  selectMonster: (selectedMonster) =>
    set({ selectedMonster, selectedMobSkillTarget: null }),
  setSelectedTimeRange: (selectedTimeRange) => set({ selectedTimeRange }),
  setSelectedMobSkillTarget: (selectedMobSkillTarget) =>
    set({ selectedMobSkillTarget }),
  setDpsAnalysisRange: (dpsAnalysisRange) => set({ dpsAnalysisRange }),
  setByPlayerCompareRange: (byPlayerCompareRange) => set({ byPlayerCompareRange }),
}));
