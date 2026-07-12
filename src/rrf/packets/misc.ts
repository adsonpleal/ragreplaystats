import { ByteReader, readKoreanZ } from "../reader.js";
import type { MapChange, MobHpUpdate, NotifyEffectEvent, OptionChangeEvent, VanishEvent } from "../types.js";

/**
 * 0x01f3 — ZC_NOTIFY_EFFECT (`clif_specialeffect`, 10 bytes incl. pkt id).
 *   AID u32, type u32
 * `type` is an EF_* effect id the client renders on the entity. Item-use
 * effects (a Concentration/Awakening potion sparkle, a Berry flash) and many
 * other server `specialeffect` visuals arrive this way — so it covers item
 * consumption effects generically.
 */
export function decodeNotifyEffect(reader: ByteReader, time: number): NotifyEffectEvent {
  const aid = reader.u32();
  const effectId = reader.u32();
  return { time, aid, effectId };
}

/**
 * 0x0229 — ZC_STATE_CHANGE3: an entity's OPTION/effectState changed. This is how
 * summons (Falcon 0x10, Warg 0x100000) and NPC visibility (cloakonnpc/hideonnpc
 * toggle OPTION_HIDE 0x2 / OPTION_CLOAK 0x4) change DURING a recording — a spawn
 * packet only has the state at spawn time. Full 32-bit effectState.
 *   AID u32, bodyState u16, healthState u16, effectState u32, isPKModeON u8
 */
export function decodeStateChange0229(reader: ByteReader, time: number): OptionChangeEvent {
  const aid = reader.u32();
  reader.skip(2 + 2); // bodyState, healthState
  const option = reader.u32(); // effectState — the OPTION bitmask
  return { time, aid, option };
}

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

/**
 * 0x0091 — ZC_NPCACK_MAPMOVE: the server has placed the client at a cell after
 * a map change. mapname[16], x i16, y i16. Carries the local player's
 * authoritative spawn cell — the local player never self-spawns via an entity
 * packet, so this is often the only position the recording has for them.
 */
export function decodeMapChange(reader: ByteReader, time: number): MapChange {
  const map = readKoreanZ(reader.bytes(16));
  const gx = reader.i16();
  const gy = reader.i16();
  return { time, map, gx, gy };
}
