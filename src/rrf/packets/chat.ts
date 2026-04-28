import { readKoreanZ } from "../reader.js";
import type { ChatEvent } from "../types.js";

/**
 * 0x008e — ZC_NOTIFY_PLAYERCHAT. The recording's own chat echoed back.
 *
 * Layout:
 *   PacketType   u16  (0x008e — already consumed by the dispatcher)
 *   PacketLength u16  (whole packet incl. id+len)
 *   Message      char[PacketLength - 4]   (null-terminated, koreanZ on Latam)
 *
 * No AID — the orchestrator stamps the source as `sessionInfo.aid`.
 */
export function decodeSelfChat(raw: Uint8Array, time: number): ChatEvent {
  const pktLen = raw[2] | (raw[3] << 8);
  const messageBytes = raw.subarray(
    4,
    Math.max(4, Math.min(raw.byteLength, pktLen)),
  );
  return { time, message: readKoreanZ(messageBytes) };
}
