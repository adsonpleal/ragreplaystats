import { ByteReader } from "../reader.js";
import type { ItemAddEvent, ItemDeleteEvent } from "../types.js";

/**
 * 0x07fa — ZC_DELETE_ITEM_FROM_BODY (8 bytes incl. pkt id).
 *   reason u16, index u16, amount u16
 *
 * Reason values (rAthena `enum delitem_reason`):
 *   0 = normal removal (dropped, sold, traded)
 *   1 = used (potion etc.)
 *   2 = used by skill (e.g. arrows)
 *   3 = lost on refine fail
 *   4 = consumed in production
 *   5 = consumed in special action
 *   ...
 *
 * `itemId` is filled in later by the orchestrator from the running
 * inventory snapshot.
 */
export function decodeItemDelete(
  reader: ByteReader,
  time: number,
): ItemDeleteEvent {
  const reason = reader.u16();
  // The server reports `slot + 2` here. The Items-container parser also
  // normalises to logical slot via `rawPos - 2`, so subtract 2 to match.
  const slot = reader.u16() - 2;
  const amount = reader.u16();
  return { time, slot, amount, reason, itemId: 0 };
}

export type ItemUseAckPacket = ItemAddEvent & { aid: number; success: boolean };

/**
 * 0x01c8 — ZC_USE_ITEM_ACK2 (15 bytes incl. pkt id).
 *   index u16, itemId u32, aid u32, amount u16, success u8
 *
 * The packet broadcasts to nearby observers, so `aid` is NOT necessarily
 * the recording's player. `amount` is the REMAINING quantity in that slot
 * after a successful use; `success` is 0 when the use failed (out of range,
 * cooldown, etc.) and 1 when it landed.
 *
 * Stackable consumables (potions, scrolls, etc.) fire 0x01c8 on each use
 * and only fire 0x07fa when the slot empties — so to count uses we have to
 * watch this packet, not just deletes.
 */
export function decodeItemUseAck(reader: ByteReader, time: number): ItemUseAckPacket {
  const slot = reader.u16() - 2;
  const itemId = reader.u32();
  const aid = reader.u32();
  const remaining = reader.u16();
  const success = reader.u8() === 1;
  return { time, slot, itemId, amount: remaining, refine: 0, aid, success };
}

/**
 * 0x0a37 — ZC_ADD_ITEM_TO_INVENTORY3 (variable length).
 * After pkt id:
 *   pktLen u16
 *   index u16
 *   amount u16
 *   nameid u32
 *   identified u8
 *   damage u8
 *   refine u8
 *   cards i32 × 4
 *   expireTime i32
 *   bindOnEquip u16
 *   equipLocation u32
 *   itemType u8
 *   result u8
 *   ... possibly more in newer versions
 *
 * We only need slot/itemId/amount/refine.
 */
export function decodeItemAdd(reader: ByteReader, time: number): ItemAddEvent {
  reader.u16(); // pktLen
  const slot = reader.u16() - 2;
  const amount = reader.u16();
  const itemId = reader.u32();
  reader.u8(); // identified
  reader.u8(); // damage
  const refine = reader.u8();
  return { time, slot, itemId, amount, refine };
}
