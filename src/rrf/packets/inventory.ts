import { ByteReader } from "../reader.js";
import type { ItemAddEvent, ItemDeleteEvent } from "../types.js";

/**
 * Raw shape of an equip/take-off ack before the orchestrator resolves the
 * item identity from the running inventory snapshot.
 */
export type EquipChangePacket = {
  time: number;
  slot: number;
  location: number;
  equipped: boolean;
  /** True only when the server reported the action succeeded (result === 0). */
  success: boolean;
};

/**
 * 0x0999 — ZC_ACK_WEAR_EQUIP_V5 (11 bytes incl. pkt id).
 *   index u16, wearLocation u32, wItemSpriteNumber u16, result u8
 *
 * `result === 0` (EQUIP_ITEM_SUCCESS) means the item was actually worn; any
 * other value is a failure (level/job/refine restriction) and is dropped.
 * `index` is the server slot (logical slot + 2), matching 0x07fa/0x0a37.
 */
export function decodeWearEquip(
  reader: ByteReader,
  time: number,
): EquipChangePacket {
  const slot = reader.u16() - 2;
  const location = reader.u32();
  reader.u16(); // wItemSpriteNumber (view id, not the item id)
  const result = reader.u8();
  return { time, slot, location, equipped: true, success: result === 0 };
}

/**
 * 0x099a — ZC_ACK_TAKEOFF_EQUIP_V5 (9 bytes incl. pkt id).
 *   index u16, wearLocation u32, result u8
 *
 * `result === 0` (UNEQUIP_ITEM_SUCCESS) means the item was removed.
 */
export function decodeTakeoffEquip(
  reader: ByteReader,
  time: number,
): EquipChangePacket {
  const slot = reader.u16() - 2;
  const location = reader.u32();
  const result = reader.u8();
  return { time, slot, location, equipped: false, success: result === 0 };
}

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
 * 0x0a37 — ZC_ITEM_PICKUP_ACK (fixed length, ~67 bytes).
 * After pkt id:
 *   index u16
 *   count u16
 *   nameid u32         (clients >= 2018-11-21; older variants use u16)
 *   identified u8
 *   damaged u8
 *   refine u8
 *   slot (4 cards × u16 = 8 bytes)
 *   location u32
 *   type u8
 *   result u8
 *   ... + HireExpireDate, bindOnEquip, options, favorite/look on newer builds
 *
 * Earlier versions of this decoder mistakenly read a `pktLen u16` first,
 * shifting every field two bytes and turning a stack of 1 item with id 7642
 * into "id 65536, qty 7642". `nameid` is the u32 form on the Latam server.
 *
 * We only need slot / itemId / amount / refine.
 */
export function decodeItemAdd(reader: ByteReader, time: number): ItemAddEvent {
  const slot = reader.u16() - 2;
  const amount = reader.u16();
  const itemId = reader.u32();
  reader.u8(); // identified
  reader.u8(); // damaged
  const refine = reader.u8();
  return { time, slot, itemId, amount, refine };
}
