/**
 * "Primary" selected player = the first one inserted into the set, by `Set`
 * iteration order. Drives the secondary monster table, breadcrumb, and any
 * per-player pane that hasn't been multiplied across the selection yet.
 */
export function primarySelectedPlayer(players: Set<number>): number | null {
  const it = players.values().next();
  return it.done ? null : it.value;
}
