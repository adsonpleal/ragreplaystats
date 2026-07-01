import { ByteReader } from "../reader.js";
import { readMoveData, readPosDir } from "./entity.js";
import type { FixPosEvent, MoveEvent } from "../types.js";

/**
 * 0x0086 — ZC_NOTIFY_MOVE: another entity starts walking from `from` to `to`.
 *   AID u32, MoveData(6), moveStartTime u32
 */
export function decodeMoveOther(reader: ByteReader, time: number): MoveEvent {
  const aid = reader.u32();
  const md = readMoveData(reader.bytes(6));
  const startTime = reader.u32();
  return { time, aid, from: md.from, to: md.to, startTime };
}

/**
 * 0x0087 — ZC_NOTIFY_PLAYERMOVE: local player starts walking. No AID — it's
 * always the session player.
 *   moveStartTime u32, MoveData(6)
 */
export function decodeMoveSelf(reader: ByteReader, time: number, selfAid: number): MoveEvent {
  const startTime = reader.u32();
  const md = readMoveData(reader.bytes(6));
  return { time, aid: selfAid, from: md.from, to: md.to, startTime };
}

/**
 * 0x0088 — ZC_STOPMOVE: server pins an entity at a cell (forced position
 * snap; e.g., the end of a knockback or a teleport).
 *   AID u32, x i16, y i16
 */
export function decodeFixPos(reader: ByteReader, time: number): FixPosEvent {
  const aid = reader.u32();
  const gx = reader.i16();
  const gy = reader.i16();
  return { time, aid, gx, gy };
}

/** Convenience: turn a spawn's pos field into a synthetic position event. */
export function spawnPositionEvent(
  aid: number,
  time: number,
  pos: { gx: number; gy: number; dir: number },
): FixPosEvent {
  return { time, aid, gx: pos.gx, gy: pos.gy };
}

// Re-export the bit-pack readers so the decoder can use them too.
export { readPosDir, readMoveData };
