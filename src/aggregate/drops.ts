// Aggregations over the floor drops: the headline numbers, the per-item table
// with items/hour, and the timeline series. Reading the drops off the file is
// `groundDrops.ts`; nothing here knows what a packet is.

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

/**
 * Bucket widths the timeline may use. The smallest one that keeps the chart
 * under `MAX_BUCKETS` points wins, so a 3-minute recording gets 5s buckets and
 * a 2-hour one gets 2-minute buckets instead of 1440 near-empty points.
 */
const BUCKET_LADDER_MS = [5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000];
const MAX_BUCKETS = 80;

function pickBucketMs(spanMs: number): number {
  return (
    BUCKET_LADDER_MS.find((ms) => spanMs / ms <= MAX_BUCKETS) ??
    BUCKET_LADDER_MS[BUCKET_LADDER_MS.length - 1]
  );
}

export type DropTimeline = {
  /** Bucket centres, in milliseconds from recording start. */
  ts: number[];
  dropped: number[];
  collected: number[];
  /** The width this series chose — the chart labels its points with it. */
  bucketMs: number;
};

/**
 * Drops per bucket over the recording, as two series: everything that fell, and
 * the part the recorder picked up. Both on the same scale so the gap between
 * them reads as the loot left behind.
 */
export function dropTimeline(
  drops: readonly GroundDrop[],
  durationMs: number,
): DropTimeline {
  // A drop after the declared duration is still a drop — take the later end so
  // none falls off the right edge.
  let span = durationMs;
  for (const d of drops) if (d.time > span) span = d.time;
  const bucketMs = pickBucketMs(span);
  if (!drops.length) return { ts: [], dropped: [], collected: [], bucketMs };

  const bucketCount = Math.ceil(Math.max(bucketMs, span) / bucketMs);
  const ts: number[] = [];
  for (let i = 0; i < bucketCount; i++) ts.push(i * bucketMs + bucketMs / 2);
  const dropped = new Array<number>(bucketCount).fill(0);
  const collected = new Array<number>(bucketCount).fill(0);

  for (const d of drops) {
    const idx = Math.min(bucketCount - 1, Math.floor(d.time / bucketMs));
    dropped[idx] += d.amount;
    if (d.collected) collected[idx] += d.amount;
  }

  return { ts, dropped, collected, bucketMs };
}
