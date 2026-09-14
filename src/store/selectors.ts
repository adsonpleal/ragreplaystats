import { useAppStore } from "./useAppStore";

const NO_PHASES: readonly number[] = [];

/**
 * When the monster at `aid` has its phases grouped, the times its later phases
 * appeared — for the charts' phase lines. Empty otherwise.
 */
export function usePhaseStarts(aid: number): readonly number[] {
  return useAppStore((s) => (s.groupPhases ? s.bossPhases.phaseStarts.get(aid) : undefined) ?? NO_PHASES);
}

/**
 * "Primary" selected player = the first one inserted into the set, by `Set`
 * iteration order. Drives the secondary monster table, breadcrumb, and any
 * per-player pane that hasn't been multiplied across the selection yet.
 */
export function primarySelectedPlayer(players: Set<number>): number | null {
  const it = players.values().next();
  return it.done ? null : it.value;
}
