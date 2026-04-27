import { ByteReader } from "../reader.js";
import type { StatusEvent } from "../types.js";

/**
 * 0x0196 — ZC_MSG_STATE_CHANGE (8 bytes).
 *   index u16 (status id), aid u32, isOn u8
 */
export function decodeStatus0196(
  reader: ByteReader,
  time: number,
): StatusEvent {
  const statusId = reader.u16();
  const aid = reader.u32();
  const isOn = reader.u8() !== 0;
  return { time, statusId, aid, isOn, totalMs: 0, leftMs: 0 };
}

/**
 * 0x043f — ZC_MSG_STATE_CHANGE3 (29 bytes incl. pkt id).
 * Order matches rAthena `packet_status_change2`:
 *   index u16, aid u32, isOn u8, left u32, val1 i32, val2 i32, val3 i32
 *
 * `total` field is *not* present in this variant (it's the older one).
 */
export function decodeStatus043f(
  reader: ByteReader,
  time: number,
): StatusEvent {
  const statusId = reader.u16();
  const aid = reader.u32();
  const isOn = reader.u8() !== 0;
  const leftMs = reader.u32();
  reader.skip(4 * 3); // val1, val2, val3
  return { time, statusId, aid, isOn, totalMs: 0, leftMs };
}

/**
 * 0x0983 — ZC_MSG_STATE_CHANGE_TICK (33 bytes incl. pkt id).
 * Order matches rAthena `packet_status_change`:
 *   index u16, aid u32, isOn u8, total u32, left u32, val1 i32, val2 i32, val3 i32
 *
 * Adds the `total` (full duration) compared to 0x043f.
 */
export function decodeStatus0983(
  reader: ByteReader,
  time: number,
): StatusEvent {
  const statusId = reader.u16();
  const aid = reader.u32();
  const isOn = reader.u8() !== 0;
  const totalMs = reader.u32();
  const leftMs = reader.u32();
  reader.skip(4 * 3); // val1, val2, val3
  return { time, statusId, aid, isOn, totalMs, leftMs };
}
