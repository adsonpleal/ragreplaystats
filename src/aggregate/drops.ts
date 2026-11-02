// Ground drops — what hit the floor during the recording, and whether the
// recorder picked it up.
//
// These live here rather than on `Replay` because rrfparser 1.4.0 does not
// decode the two floor-item packets: `replay.itemAdds` is the *inventory* side
// (ZC_ITEM_PICKUP_ACK), which cannot tell a mob drop from an NPC purchase and
// says nothing about an item nobody collected. So this module walks the packet
// stream a second time, over rrfparser's stable container API, and decodes them
// itself. The long-term home is the parser; until it ships them, this is the
// only way the app can see a drop at all.
//
// The walk costs roughly as much as `decodeReplay` (~60-110 ms on a 900 KB
// recording), so it is lazy and cached per file — see `groundDropsFor`.

import {
  deriveKeys,
  readContainers,
  readHeader,
  type ItemAddEvent,
  type PacketChunk,
} from "rrfparser";

/**
 * `ZC_ITEM_FALL_ENTRY` — an item lands on the floor, with the drop animation.
 * 24 bytes on every LATAM recording checked (643 packets across a 177-replay
 * corpus), laid out as: u32 ground id, u32 item id, u16 item type, u8
 * identified, u16 x, u16 y, u8 subX, u8 subY, u16 amount, u8 showDropEffect,
 * u16 dropEffectMode. Matches rAthena's `packet_dropflooritem`.
 */
const FALL_ENTRY = 0x0add;
const FALL_ENTRY_LEN = 24;

/**
 * `ZC_ITEM_DISAPPEAR` — the floor item is gone: someone picked it up, or it
 * timed out. 6 bytes: the ground id and nothing else, which is why "collected"
 * has to be inferred from the pickup acks below.
 */
const DISAPPEAR = 0x00a1;
const DISAPPEAR_LEN = 6;

/**
 * How far a pickup ack may sit from the floor item's removal and still be
 * considered the same event. The server sends them back to back — every pair in
 * the corpus was within 3 ms — so this is three orders of magnitude of slack.
 */
const PICKUP_MATCH_MS = 1_000;

export type GroundDrop = {
  /** Milliseconds from recording start. */
  time: number;
  /** The server's handle for this floor item; what the removal packet names. */
  groundId: number;
  itemId: number;
  amount: number;
  /** Cell the item landed on. */
  x: number;
  y: number;
  identified: boolean;
  /** When the item left the floor, or null if it was still there at the end. */
  removedAt: number | null;
  /**
   * True when a pickup ack puts this item in the recorder's own bag. False
   * covers three different things the recording cannot tell apart: another
   * player took it, it timed out, or it is still lying there.
   */
  collected: boolean;
};

function u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function viewOf(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Pair each removed floor item with the pickup ack that took it, so a drop can
 * say whether *this* player got it.
 *
 * An ack is consumed once matched: two identical items leaving the floor at the
 * same moment, one to the recorder and one to a party member, must not both
 * come out collected.
 */
function markCollected(drops: GroundDrop[], itemAdds: readonly ItemAddEvent[]) {
  const spent = new Set<number>();
  for (const drop of drops) {
    if (drop.removedAt == null) continue;
    for (let i = 0; i < itemAdds.length; i++) {
      if (spent.has(i)) continue;
      const add = itemAdds[i];
      if (add.itemId !== drop.itemId || add.amount !== drop.amount) continue;
      if (Math.abs(add.time - drop.removedAt) > PICKUP_MATCH_MS) continue;
      spent.add(i);
      drop.collected = true;
      break;
    }
  }
}

/** Decode the floor-item packets out of an already-walked packet stream. */
export function groundDropsFromChunks(
  chunks: readonly PacketChunk[],
  itemAdds: readonly ItemAddEvent[],
): GroundDrop[] {
  const drops: GroundDrop[] = [];
  const byGroundId = new Map<number, GroundDrop>();

  for (const ch of chunks) {
    if (ch.packetId === FALL_ENTRY) {
      if (ch.data.length < FALL_ENTRY_LEN) continue;
      const v = viewOf(ch.data);
      const drop: GroundDrop = {
        time: ch.time,
        groundId: u32(v, 2),
        itemId: u32(v, 6),
        amount: u16(v, 19),
        x: u16(v, 13),
        y: u16(v, 15),
        identified: v.getUint8(12) !== 0,
        removedAt: null,
        collected: false,
      };
      drops.push(drop);
      // The server reuses a ground id once the old item is gone; the live one
      // is always the last seen, which is what a removal refers to.
      byGroundId.set(drop.groundId, drop);
    } else if (ch.packetId === DISAPPEAR) {
      if (ch.data.length < DISAPPEAR_LEN) continue;
      // A removal for an id we never saw fall is an item that was already on
      // the floor when the player came into view — not a drop of this session.
      const drop = byGroundId.get(u32(viewOf(ch.data), 2));
      if (drop && drop.removedAt == null) drop.removedAt = ch.time;
    }
  }

  markCollected(drops, itemAdds);
  return drops;
}

/** Decode the floor drops straight out of the `.rrf` bytes. */
export function decodeGroundDrops(
  buf: ArrayBuffer,
  itemAdds: readonly ItemAddEvent[],
): GroundDrop[] {
  const header = readHeader(buf);
  const containers = readContainers(buf, header.containerTableOffset, deriveKeys(header.recordedAt));
  const stream = containers.find((c) => c.kind === "packetStream");
  if (!stream || stream.kind !== "packetStream") return [];
  return groundDropsFromChunks(stream.chunks, itemAdds);
}

// Keyed by the stored replay bytes, which are one object per loaded file, so a
// tab switch re-reads the decode instead of redoing it.
const cache = new WeakMap<Uint8Array, GroundDrop[]>();

/** `decodeGroundDrops`, decoded once per loaded file. */
export function groundDropsFor(
  bytes: Uint8Array<ArrayBuffer> | null,
  itemAdds: readonly ItemAddEvent[],
): GroundDrop[] {
  if (!bytes) return [];
  const hit = cache.get(bytes);
  if (hit) return hit;
  let drops: GroundDrop[];
  try {
    drops = decodeGroundDrops(bytes.buffer, itemAdds);
  } catch (err) {
    // A truncated or foreign file still has every other tab working; losing the
    // drops list is not worth taking the app down for.
    console.error("failed to decode ground drops", err);
    drops = [];
  }
  cache.set(bytes, drops);
  return drops;
}

export type DropFilter = "all" | "collected" | "uncollected";

/** Narrow a drop list to the collected / not-collected choice. */
export function filterDrops(drops: readonly GroundDrop[], filter: DropFilter): GroundDrop[] {
  if (filter === "collected") return drops.filter((d) => d.collected);
  if (filter === "uncollected") return drops.filter((d) => !d.collected);
  return [...drops];
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
  /** First and last time it dropped, for the detail column. */
  firstMs: number;
  lastMs: number;
  /** Units per hour over the window the rest of the app measures. */
  perHour: number;
};

/**
 * One row per item, sorted by quantity.
 *
 * `durationMs` is the caller's window — `effectiveDuration(replay, range)`, the
 * same measure the Estatísticas tab divides by for DPS, so items/hour and DPS
 * never disagree about how long the session was.
 */
export function dropsByItem(
  drops: readonly GroundDrop[],
  durationMs: number,
  resolveItem: (id: number) => string,
): DropItemRow[] {
  const hours = Math.max(1, durationMs) / 3_600_000;
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
  const rows = [...map.values()];
  for (const row of rows) row.perHour = row.quantity / hours;
  return rows.sort((a, b) => b.quantity - a.quantity || a.itemId - b.itemId);
}

/**
 * Bucket widths the timeline may use. The smallest one that keeps the chart
 * under `MAX_BUCKETS` points wins, so a 3-minute recording gets 5s buckets and
 * a 2-hour one gets 2-minute buckets instead of 1440 near-empty points.
 */
const BUCKET_LADDER_MS = [5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000];
const MAX_BUCKETS = 80;

export function pickBucketMs(durationMs: number): number {
  for (const ms of BUCKET_LADDER_MS) if (durationMs / ms <= MAX_BUCKETS) return ms;
  return BUCKET_LADDER_MS[BUCKET_LADDER_MS.length - 1];
}

export type DropTimeline = {
  /** Bucket centres, in milliseconds from recording start. */
  ts: number[];
  dropped: number[];
  collected: number[];
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
  bucketMs: number,
): DropTimeline {
  if (!drops.length) return { ts: [], dropped: [], collected: [], bucketMs };
  let last = durationMs;
  for (const d of drops) if (d.time > last) last = d.time;
  const bucketCount = Math.max(1, Math.ceil(Math.max(bucketMs, last) / bucketMs));

  const ts: number[] = [];
  for (let i = 0; i < bucketCount; i++) ts.push(i * bucketMs + bucketMs / 2);
  const dropped = new Array<number>(bucketCount).fill(0);
  const collected = new Array<number>(bucketCount).fill(0);

  for (const d of drops) {
    const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor(d.time / bucketMs)));
    dropped[idx] += d.amount;
    if (d.collected) collected[idx] += d.amount;
  }

  return { ts, dropped, collected, bucketMs };
}
