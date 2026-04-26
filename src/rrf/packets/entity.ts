import { ByteReader, readEntityName } from "../reader.js";
import type { EntityKind } from "../types.js";

export type EntityPacket = {
  aid: number;
  gid: number;
  view: number; // job/mob id
  kind: EntityKind;
  name: string;
  isBoss: boolean;
  level: number;
  maxHp: number;
  hp: number;
};

function classifyObjectType(t: number): EntityKind {
  switch (t) {
    case 0x0:
      return "pc";
    case 0x5:
      return "mob";
    case 0x6:
      return "npc";
    case 0x7:
      return "pet";
    case 0x8:
      return "homun";
    case 0x9:
      return "merc";
    case 0xa:
      return "elem";
    default:
      return "unknown";
  }
}

/**
 * 0x09fe — packet_idle_unit_spawn (variable-length).
 * Layout (after 2-byte packetType already consumed):
 *   PacketLength i16
 *   objecttype u8
 *   AID u32, GID u32
 *   speed i16, bodyState i16, healthState i16, effectState i32
 *   job i16
 *   ...trailing fields skipped...
 *   maxHP i32 @ +70 from start of payload-after-pktlen
 *   HP    i32 @ +74
 *   isBoss u8 @ +78
 *   body  u16 @ +79
 *   name  cp949 zero-terminated until packet length
 */
export function decodeIdleSpawn(reader: ByteReader): EntityPacket {
  const pktLen = reader.u16();
  return readEntity(reader, pktLen, /* hasState */ false, /* hasMoveStart */ false);
}

/** 0x09ff — packet_idle_unit (has extra `state` byte after ySize). */
export function decodeIdle(reader: ByteReader): EntityPacket {
  const pktLen = reader.u16();
  return readEntity(reader, pktLen, /* hasState */ true, /* hasMoveStart */ false);
}

/** 0x0915 — packet_unit_walking (has moveStartTime + 6-byte MoveData instead of PosDir+state). */
export function decodeWalking(reader: ByteReader): EntityPacket {
  const pktLen = reader.u16();
  return readEntity(reader, pktLen, /* hasState */ false, /* hasMoveStart */ true);
}

function readEntity(
  reader: ByteReader,
  pktLen: number,
  hasState: boolean,
  hasMoveStart: boolean,
): EntityPacket {
  const start = reader.position - 4; // back to packet ID start

  const objectType = reader.u8();
  const aid = reader.u32();
  const gid = reader.u32();
  reader.skip(2 + 2 + 2 + 4); // speed, bodyState, healthState, effectState
  const job = reader.i16();
  reader.skip(2); // head
  reader.skip(4 + 4); // weapon, shield
  reader.skip(2); // accessory
  if (hasMoveStart) reader.skip(4); // moveStartTime
  reader.skip(2 + 2); // accessory2, accessory3
  reader.skip(2 + 2 + 2); // headpalette, bodypalette, headDir
  reader.skip(2); // robe
  reader.skip(4); // GUID
  reader.skip(2 + 2 + 4); // GEmblemVer, honor, virtue
  reader.skip(1 + 1); // isPKModeON, sex

  if (hasMoveStart) {
    reader.skip(6); // MoveData
  } else {
    reader.skip(3); // PosDir
  }

  reader.skip(1 + 1); // xSize, ySize
  if (hasState) reader.skip(1); // state

  const level = reader.i16();
  reader.skip(2); // font
  const maxHp = reader.i32();
  const hp = reader.i32();
  const isBoss = reader.u8() !== 0;
  reader.skip(2); // body

  // Trailing name fills the rest of the packet payload.
  const consumed = reader.position - start;
  const remaining = pktLen - consumed;
  const name = remaining > 0 ? readEntityName(reader.bytes(Math.max(0, remaining))) : "";

  return {
    aid,
    gid,
    view: job,
    kind: classifyObjectType(objectType),
    name,
    isBoss,
    level,
    maxHp,
    hp,
  };
}
