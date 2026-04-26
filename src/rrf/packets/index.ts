import { ByteReader } from "../reader.js";
import {
  decodeIdle,
  decodeIdleSpawn,
  decodeWalking,
  type EntityPacket,
} from "./entity.js";
import {
  decodeAutoAttack,
  decodeAutoAttackLegacy,
  decodeSkillDamage,
} from "./damage.js";
import {
  decodeSkillCast,
  decodeSkillNoDamage011a,
  decodeSkillNoDamage09cb,
} from "./skill.js";
import { decodeMapChange, decodeMobHp, decodeVanish } from "./misc.js";
import type {
  DamageEvent,
  MapChange,
  MobHpUpdate,
  SkillCast,
  SkillUse,
  VanishEvent,
} from "../types.js";

export const PacketIds = {
  NEW_ENTRY: 0x09fd,
  IDLE_SPAWN: 0x09fe,
  IDLE: 0x09ff,
  WALKING: 0x0915,
  VANISH: 0x0080,
  MOB_HP: 0x0977,
  AUTO_ATTACK: 0x02e1,
  AUTO_ATTACK_LEGACY: 0x008a,
  SKILL_DAMAGE: 0x01de,
  SKILL_NODMG_OLD: 0x011a,
  SKILL_NODMG_NEW: 0x09cb,
  SKILL_CAST: 0x013e,
  MAP_CHANGE: 0x0091,
} as const;

export type DecodedPacket =
  | { type: "entity"; data: EntityPacket }
  | { type: "vanish"; data: VanishEvent }
  | { type: "mobHp"; data: MobHpUpdate }
  | { type: "damage"; data: DamageEvent }
  | { type: "skillUse"; data: SkillUse }
  | { type: "skillCast"; data: SkillCast }
  | { type: "mapChange"; data: MapChange };

/**
 * Decode a packet whose 2-byte header has already been consumed externally?
 * No — actually consumers pass the full chunk bytes here; we re-read the header to dispatch.
 */
export function decodePacket(
  raw: Uint8Array,
  time: number,
): DecodedPacket | null {
  if (raw.byteLength < 2) return null;
  const reader = new ByteReader(raw);
  const id = reader.u16();

  try {
    switch (id) {
      case PacketIds.IDLE_SPAWN:
        return { type: "entity", data: decodeIdleSpawn(reader) };
      case PacketIds.IDLE:
        return { type: "entity", data: decodeIdle(reader) };
      case PacketIds.WALKING:
      case PacketIds.NEW_ENTRY:
        // 0x09fd is the renewal "new entry" / walking spawn — same layout
        // as 0x0915 (moveStartTime + 6-byte MoveData rather than PosDir[3]).
        return { type: "entity", data: decodeWalking(reader) };
      case PacketIds.AUTO_ATTACK_LEGACY:
        return { type: "damage", data: decodeAutoAttackLegacy(reader, time) };
      case PacketIds.VANISH:
        return { type: "vanish", data: decodeVanish(reader, time) };
      case PacketIds.MOB_HP:
        return { type: "mobHp", data: decodeMobHp(reader, time) };
      case PacketIds.AUTO_ATTACK:
        return { type: "damage", data: decodeAutoAttack(reader, time) };
      case PacketIds.SKILL_DAMAGE:
        return { type: "damage", data: decodeSkillDamage(reader, time) };
      case PacketIds.SKILL_NODMG_OLD:
        return { type: "skillUse", data: decodeSkillNoDamage011a(reader, time) };
      case PacketIds.SKILL_NODMG_NEW:
        return { type: "skillUse", data: decodeSkillNoDamage09cb(reader, time) };
      case PacketIds.SKILL_CAST:
        return { type: "skillCast", data: decodeSkillCast(reader, time) };
      case PacketIds.MAP_CHANGE:
        return { type: "mapChange", data: decodeMapChange(reader, time) };
      default:
        return null;
    }
  } catch {
    // Truncated / malformed packet — skip silently.
    return null;
  }
}
