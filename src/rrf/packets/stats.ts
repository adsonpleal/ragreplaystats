import { ByteReader } from "../reader.js";
import type { ParamChangeEvent } from "../types.js";

/**
 * 0x00b0 — ZC_PAR_CHANGE (8 bytes).
 *   type u16, value i32
 *
 * `type` is from rAthena's SP_* enum. Relevant to us:
 *   1  = SP_BASEEXP
 *   2  = SP_JOBEXP
 *   5  = SP_HP
 *   7  = SP_SP
 *   11 = SP_BASELEVEL
 *   12 = SP_JOBLEVEL
 *   20 = SP_ZENY
 *   22 = SP_NEXTBASEEXP
 *   23 = SP_NEXTJOBEXP
 */
export function decodeParamChange32(
  reader: ByteReader,
  time: number,
): ParamChangeEvent {
  const type = reader.u16();
  const value = reader.i32();
  return { time, type, value: BigInt(value) };
}

/**
 * 0x0b1b — ZC_PARAM_CHANGE_USER (renewal i64 variant, 12 bytes).
 *   type u16, value i64
 */
export function decodeParamChange64(
  reader: ByteReader,
  time: number,
): ParamChangeEvent {
  const type = reader.u16();
  const value = reader.i64();
  return { time, type, value };
}
