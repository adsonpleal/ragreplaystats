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
  decodeSkillEntry09ca,
  decodeSkillNoDamage011a,
  decodeSkillNoDamage09cb,
  type GroundSkillEntry,
} from "./skill.js";
import { decodeMapChange, decodeMobHp, decodeVanish } from "./misc.js";
import {
  decodeItemAdd,
  decodeItemDelete,
  decodeItemUseAck,
  type ItemUseAckPacket,
} from "./inventory.js";
import { decodeParamChange32, decodeParamChange64 } from "./stats.js";
import {
  decodeStatus0196,
  decodeStatus043f,
  decodeStatus0983,
} from "./status.js";
import { decodeSelfChat } from "./chat.js";
import type {
  ChatEvent,
  DamageEvent,
  ItemAddEvent,
  ItemDeleteEvent,
  MapChange,
  MobHpUpdate,
  ParamChangeEvent,
  SkillCast,
  SkillUse,
  StatusEvent,
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
  ITEM_DELETE: 0x07fa,
  ITEM_ADD: 0x0a37,
  ITEM_USE_ACK: 0x01c8,
  PARAM_CHANGE_32: 0x00b0,
  PARAM_CHANGE_64: 0x0b1b,
  STATUS_0196: 0x0196,
  STATUS_043F: 0x043f,
  STATUS_0983: 0x0983,
  GROUND_SKILL_ENTRY: 0x09ca,
  SELF_CHAT: 0x008e,
} as const;

export type DecodedPacket =
  | { type: "entity"; data: EntityPacket }
  | { type: "vanish"; data: VanishEvent }
  | { type: "mobHp"; data: MobHpUpdate }
  | { type: "damage"; data: DamageEvent }
  | { type: "skillUse"; data: SkillUse }
  | { type: "skillCast"; data: SkillCast }
  | { type: "mapChange"; data: MapChange }
  | { type: "itemDelete"; data: ItemDeleteEvent }
  | { type: "itemAdd"; data: ItemAddEvent }
  | { type: "itemUseAck"; data: ItemUseAckPacket }
  | { type: "paramChange"; data: ParamChangeEvent }
  | { type: "status"; data: StatusEvent }
  | { type: "groundSkillEntry"; data: GroundSkillEntry }
  | { type: "chat"; data: ChatEvent };

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
      case PacketIds.ITEM_DELETE:
        return { type: "itemDelete", data: decodeItemDelete(reader, time) };
      case PacketIds.ITEM_ADD:
        return { type: "itemAdd", data: decodeItemAdd(reader, time) };
      case PacketIds.ITEM_USE_ACK:
        return { type: "itemUseAck", data: decodeItemUseAck(reader, time) };
      case PacketIds.PARAM_CHANGE_32:
        return { type: "paramChange", data: decodeParamChange32(reader, time) };
      case PacketIds.PARAM_CHANGE_64:
        return { type: "paramChange", data: decodeParamChange64(reader, time) };
      case PacketIds.STATUS_0196:
        return { type: "status", data: decodeStatus0196(reader, time) };
      case PacketIds.STATUS_043F:
        return { type: "status", data: decodeStatus043f(reader, time) };
      case PacketIds.STATUS_0983:
        return { type: "status", data: decodeStatus0983(reader, time) };
      case PacketIds.GROUND_SKILL_ENTRY:
        return { type: "groundSkillEntry", data: decodeSkillEntry09ca(reader, time) };
      case PacketIds.SELF_CHAT:
        return { type: "chat", data: decodeSelfChat(raw, time) };
      default:
        return null;
    }
  } catch {
    return null;
  }
}
