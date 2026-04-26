import { ByteReader } from "../reader.js";
import type { SkillCast, SkillUse } from "../types.js";

/** 0x011a — clif_skill_nodamage (older, 15 bytes incl. pkt id). */
export function decodeSkillNoDamage011a(reader: ByteReader, time: number): SkillUse {
  const skillId = reader.u16();
  const skillLevel = reader.u16();
  const target = reader.u32();
  const source = reader.u32();
  // result byte ignored
  return { time, source, target, skillId, skillLevel };
}

/** 0x09cb — clif_skill_nodamage (newer, 17 bytes — skillLevel is i32). */
export function decodeSkillNoDamage09cb(reader: ByteReader, time: number): SkillUse {
  const skillId = reader.u16();
  const skillLevel = reader.i32();
  const target = reader.u32();
  const source = reader.u32();
  // result byte ignored
  return { time, source, target, skillId, skillLevel };
}

/** 0x013e — ZC_USESKILL_ACK (cast started). */
export function decodeSkillCast(reader: ByteReader, time: number): SkillCast {
  const source = reader.u32();
  const target = reader.u32();
  reader.skip(2 + 2); // x, y
  const skillId = reader.u16();
  reader.skip(4); // element
  const castMs = reader.u32();
  return { time, source, target, skillId, castMs };
}
