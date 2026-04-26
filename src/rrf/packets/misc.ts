import { ByteReader, readKoreanZ } from "../reader.js";
import type { MapChange, MobHpUpdate, VanishEvent } from "../types.js";

/** 0x0080 — ZC_NOTIFY_VANISH. aid u32, type u8. */
export function decodeVanish(reader: ByteReader, time: number): VanishEvent {
  const aid = reader.u32();
  const kind = reader.u8();
  return { time, aid, kind };
}

/** 0x0977 — ZC_HP_INFO. aid u32, hp i32, maxHp i32. */
export function decodeMobHp(reader: ByteReader, time: number): MobHpUpdate {
  const aid = reader.u32();
  const hp = reader.i32();
  const maxHp = reader.i32();
  return { time, aid, hp, maxHp };
}

/** 0x0091 — ZC_NPCACK_MAPMOVE. mapname[16], x i16, y i16. */
export function decodeMapChange(reader: ByteReader, time: number): MapChange {
  const map = readKoreanZ(reader.bytes(16));
  reader.skip(4); // x, y
  return { time, map };
}
