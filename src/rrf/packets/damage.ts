import { ByteReader } from "../reader.js";
import type { DamageEvent, HitType } from "../types.js";

/**
 * Map the action / hit-type byte to a high-level category.
 * Confirmed against PacketDecoder.cs (case 0x8 / 0x6 / 0x0 / 0x5 / 0xa blocks).
 */
export function classifyHit(action: number): HitType {
  switch (action) {
    case 0x06:
      return "miss";
    case 0x08:
      return "lucky";
    case 0x05:
      return "double";
    case 0x0a:
      return "critical";
    default:
      return "normal";
  }
}

/**
 * 0x02e1 — ZC_NOTIFY_ACT3 (auto-attack damage), 33 bytes.
 * Layout (after pkt id):
 *   srcID u32, dstID u32, startTime u32,
 *   attackMT i32, attackedMT i32, damage i32,
 *   count i16, action u8, leftDamage i32
 */
export function decodeAutoAttack(reader: ByteReader, time: number): DamageEvent {
  const source = reader.u32();
  const target = reader.u32();
  reader.skip(4); // startTime
  reader.skip(4); // attackMT
  reader.skip(4); // attackedMT
  const damage = reader.i32();
  const hits = reader.i16();
  const action = reader.u8();
  // leftDamage follows — ignored; it's part of total damage already in some clients.

  const hitType = classifyHit(action);
  return {
    time,
    source,
    target,
    skillId: 0,
    skillLevel: 0,
    damage: hitType === "miss" ? 0 : Math.max(0, damage),
    hits: Math.max(1, hits),
    hitType,
    source_packet: "auto",
  };
}

/**
 * 0x008a — ZC_NOTIFY_ACT (legacy auto-attack damage), 29 bytes.
 * Layout (after pkt id):
 *   srcID u32, dstID u32, tick u32,
 *   srcSpd i32, dstSpd i32,
 *   damage i16, div i16, type u8, damage2 i16
 */
export function decodeAutoAttackLegacy(
  reader: ByteReader,
  time: number,
): DamageEvent {
  const source = reader.u32();
  const target = reader.u32();
  reader.skip(4); // tick
  reader.skip(4); // srcSpd
  reader.skip(4); // dstSpd
  const damage = reader.i16();
  const hits = reader.i16();
  const action = reader.u8();
  // damage2 i16 follows — ignored.

  const hitType = classifyHit(action);
  return {
    time,
    source,
    target,
    skillId: 0,
    skillLevel: 0,
    damage: hitType === "miss" ? 0 : Math.max(0, damage),
    hits: Math.max(1, hits),
    hitType,
    source_packet: "auto",
  };
}

/**
 * 0x01de — ZC_NOTIFY_SKILL, 33 bytes.
 * Layout:
 *   skillId u16, srcAID u32, targetID u32,
 *   startTime u32, attackMT i32, attackedMT i32, damage i32,
 *   skillLevel i16, count i16, action u8
 */
export function decodeSkillDamage(reader: ByteReader, time: number): DamageEvent {
  const skillId = reader.u16();
  const source = reader.u32();
  const target = reader.u32();
  reader.skip(4); // startTime
  reader.skip(4); // attackMT
  reader.skip(4); // attackedMT
  const damage = reader.i32();
  const skillLevel = reader.i16();
  const hits = reader.i16();
  const action = reader.u8();

  const hitType = classifyHit(action);
  return {
    time,
    source,
    target,
    skillId,
    skillLevel,
    damage: hitType === "miss" ? 0 : Math.max(0, damage),
    hits: Math.max(1, hits),
    hitType,
    source_packet: "skill",
  };
}
