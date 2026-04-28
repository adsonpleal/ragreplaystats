import { ByteReader } from "../reader.js";
import type { DamageEvent, HitType } from "../types.js";

/**
 * Classify the damage event from rAthena's `e_damage_type` byte. Reference:
 * `src/map/clif.cpp` `enum e_damage_type`.
 *
 *   0  DMG_NORMAL                normal hit
 *   5  DMG_SPLASH                splash / multi-target hit
 *   6  DMG_SINGLE                single-target skill hit
 *   7  DMG_REPEAT                repeated hit (chained)
 *   8  DMG_MULTI_HIT             multi-hit (e.g., Double Attack)
 *   9  DMG_MULTI_HIT_ENDURE      multi-hit while target endures
 *   10 DMG_CRITICAL              critical
 *   11 DMG_LUCY_DODGE            attacker rolled a miss / lucky-dodged
 *   12 DMG_TOUCH                 touch skill
 *   13 DMG_MULTI_HIT_CRITICAL    multi-hit attack that crit
 *
 * Note: not every server reports crits. The Latam Event Horizon recordings
 * we tested never set action=10 or 13 — crits exist mechanically but the
 * server keeps the action byte at the non-crit value. The UI hides crit
 * columns when the whole replay has no action-10/13 events.
 *
 * Damage-event "miss" classification combines two signals:
 *  - DMG_LUCY_DODGE (11), OR
 *  - non-skill action with `damage = 0` (target dodged a normal swing).
 * The caller passes `damage` so we can do the second check.
 */
export function classifyHit(action: number, damage: number): HitType {
  if (action === 11) return "miss"; // explicit lucky dodge
  if (action === 10 || action === 13) return "critical";
  if (action === 8 || action === 9) return "double";
  // damage=0 on a normal-style action means the swing missed.
  if (damage <= 0 && (action === 0 || action === 5 || action === 6 || action === 7)) {
    return "miss";
  }
  return "normal";
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

  const hitType = classifyHit(action, damage);
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
    rawAction: action,
  };
}

/**
 * 0x08c8 — ZC_NOTIFY_ACT3 (newer 34-byte variant). Adds an `isSPDamage` u8
 * after `damage`, which shifts every subsequent field by one byte. The
 * Latam server uses this packet on newer clients (PACKETVER >= 20131223).
 *
 * Layout (after pkt id):
 *   srcID u32, dstID u32, startTime u32,
 *   attackMT i32, attackedMT i32, damage i32,
 *   isSPDamage u8, count i16, action u8, leftDamage i32
 */
export function decodeAutoAttack08c8(
  reader: ByteReader,
  time: number,
): DamageEvent {
  const source = reader.u32();
  const target = reader.u32();
  reader.skip(4); // startTime
  reader.skip(4); // attackMT
  reader.skip(4); // attackedMT
  const damage = reader.i32();
  reader.skip(1); // isSPDamage — irrelevant for the dashboards
  const hits = reader.i16();
  const action = reader.u8();
  // leftDamage follows — ignored.

  const hitType = classifyHit(action, damage);
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
    rawAction: action,
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

  const hitType = classifyHit(action, damage);
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
    rawAction: action,
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

  const hitType = classifyHit(action, damage);
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
    rawAction: action,
  };
}
