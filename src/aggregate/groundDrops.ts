// Reading the floor-item packets out of a `.rrf`.
//
// This file is a stop-gap and lives alone so that it can be deleted alone:
// rrfparser 1.4.0 does not decode either packet, and `replay.itemAdds` is the
// *inventory* side (ZC_ITEM_PICKUP_ACK), which cannot tell a mob drop from an
// NPC purchase and never sees an item nobody collected. The long-term home is
// the parser — the day it ships them, `groundDropsFor` becomes a field read and
// everything else in `drops.ts` carries on unchanged.
//
// It walks the stream over the parser's *stable* container API, not
// `inspectPacketStream`, which rrfparser documents as unstable.
//
// The walk costs roughly as much as `decodeReplay` (~60-110 ms on a 900 KB
// recording), so nothing here runs until the Drops tab opens, and the result is
// cached per loaded file.

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
  // Bucketed by item: a long session is thousands of acks against hundreds of
  // drops, and only the handful sharing an item id can ever match.
  const byItem = new Map<number, ItemAddEvent[]>();
  for (const add of itemAdds) {
    const bucket = byItem.get(add.itemId);
    if (bucket) bucket.push(add);
    else byItem.set(add.itemId, [add]);
  }
  const spent = new WeakSet<ItemAddEvent>();

  for (const drop of drops) {
    if (drop.removedAt == null) continue;
    for (const add of byItem.get(drop.itemId) ?? []) {
      if (add.amount !== drop.amount) continue;
      if (Math.abs(add.time - drop.removedAt) > PICKUP_MATCH_MS) continue;
      if (spent.has(add)) continue;
      spent.add(add);
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
        groundId: v.getUint32(2, true),
        itemId: v.getUint32(6, true),
        amount: v.getUint16(19, true),
        x: v.getUint16(13, true),
        y: v.getUint16(15, true),
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
      const drop = byGroundId.get(viewOf(ch.data).getUint32(2, true));
      if (drop && drop.removedAt == null) drop.removedAt = ch.time;
    }
  }

  markCollected(drops, itemAdds);
  return drops;
}

// Keyed by the stored replay bytes, which are one object per loaded file, so a
// tab switch re-reads the decode instead of redoing it. The entries hold plain
// numbers only — nothing here keeps the replay buffer alive.
const cache = new WeakMap<Uint8Array, GroundDrop[]>();

/** The floor drops of a loaded `.rrf`, decoded once per file. */
export function groundDropsFor(
  bytes: Uint8Array<ArrayBuffer> | null,
  itemAdds: readonly ItemAddEvent[],
): GroundDrop[] {
  if (!bytes) return [];
  const hit = cache.get(bytes);
  if (hit) return hit;
  let drops: GroundDrop[] = [];
  try {
    const header = readHeader(bytes.buffer);
    const containers = readContainers(
      bytes.buffer,
      header.containerTableOffset,
      deriveKeys(header.recordedAt),
    );
    const stream = containers.find((c) => c.kind === "packetStream");
    if (stream?.kind === "packetStream") drops = groundDropsFromChunks(stream.chunks, itemAdds);
  } catch (err) {
    // A truncated or foreign file still has every other tab working; losing the
    // drops list is not worth taking the app down for.
    console.error("failed to decode ground drops", err);
  }
  cache.set(bytes, drops);
  return drops;
}
