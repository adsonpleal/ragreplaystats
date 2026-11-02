// Aggregations over the floor drops: the headline numbers and the per-item
// table with items/hour. Reading the drops off the file is `groundDrops.ts`;
// nothing here knows what a packet is.

import type { GroundDrop } from "./groundDrops";

export type DropFilter = "all" | "collected" | "uncollected";

/** Narrow a drop list to the collected / not-collected choice. */
export function filterDrops(drops: readonly GroundDrop[], filter: DropFilter): readonly GroundDrop[] {
  if (filter === "all") return drops;
  return drops.filter((d) => d.collected === (filter === "collected"));
}

/**
 * Units per hour over the window the rest of the app measures — pass
 * `effectiveDuration(replay, range)`, the same measure `computeResumo` divides
 * by for DPS, so the Drops tab and the Estatísticas tab never disagree about
 * how long the session was.
 */
function perHour(units: number, durationMs: number): number {
  return units / (Math.max(1, durationMs) / 3_600_000);
}

export type DropsSummary = {
  drops: number;
  units: number;
  collectedUnits: number;
  distinctItems: number;
  /** Drops the recording ended without seeing leave the floor. */
  stillOnGround: number;
  unitsPerHour: number;
};

export function dropsSummary(
  drops: readonly GroundDrop[],
  durationMs: number,
): DropsSummary {
  let units = 0;
  let collectedUnits = 0;
  let stillOnGround = 0;
  const items = new Set<number>();
  for (const d of drops) {
    units += d.amount;
    if (d.collected) collectedUnits += d.amount;
    if (d.removedAt == null) stillOnGround += 1;
    items.add(d.itemId);
  }
  return {
    drops: drops.length,
    units,
    collectedUnits,
    distinctItems: items.size,
    stillOnGround,
    unitsPerHour: perHour(units, durationMs),
  };
}

export type DropItemRow = {
  itemId: number;
  name: string;
  /** How many separate times this item hit the floor. */
  drops: number;
  /** Units across those drops — a stack of 5 counts as 5. */
  quantity: number;
  /** Units of that quantity the recorder picked up. */
  collected: number;
  /** First and last time it dropped, for the detail columns. */
  firstMs: number;
  lastMs: number;
  perHour: number;
};

/** One row per item, heaviest first. */
export function dropsByItem(
  drops: readonly GroundDrop[],
  durationMs: number,
  resolveItem: (id: number) => string,
): DropItemRow[] {
  const map = new Map<number, DropItemRow>();
  for (const d of drops) {
    let row = map.get(d.itemId);
    if (!row) {
      row = {
        itemId: d.itemId,
        name: resolveItem(d.itemId),
        drops: 0,
        quantity: 0,
        collected: 0,
        firstMs: d.time,
        lastMs: d.time,
        perHour: 0,
      };
      map.set(d.itemId, row);
    }
    row.drops += 1;
    row.quantity += d.amount;
    if (d.collected) row.collected += d.amount;
    if (d.time < row.firstMs) row.firstMs = d.time;
    if (d.time > row.lastMs) row.lastMs = d.time;
  }
  return [...map.values()]
    .map((row) => ({ ...row, perHour: perHour(row.quantity, durationMs) }))
    .sort((a, b) => b.quantity - a.quantity || a.itemId - b.itemId);
}
