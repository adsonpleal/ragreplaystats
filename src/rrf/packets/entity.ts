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
  /** 0 = female, 1 = male, -1 = unknown (not in this packet variant). */
  sex: number;
  /** The OPTION/effectState bitmask (mounts, cloaking, falcon, etc.). 0 when
   *  the layout doesn't carry it. Used to detect mounts for the map viewer. */
  option: number;
  /** Position decoded from the spawn's PosDir / MoveData (idle = stationary
   *  cell, walking = current step's source). Null when the layout has no
   *  position field. */
  pos: { gx: number; gy: number; dir: number } | null;
  /** Walking path from the spawn's MoveData (0x0915 / 0x09fd only): the entity
   *  is already mid-step from `from` to `to`. */
  walk: { from: { gx: number; gy: number }; to: { gx: number; gy: number } } | null;
  /** Appearance carried by the full spawn packets (0x09fe/0x09ff/0x0915). These
   *  are the client's sprite VIEW/look ids — hairstyle, palettes, weapon/shield
   *  looks, headgear accessory ids, robe — ready to hand straight to the
   *  ragassets URL builder for other players (no item→view lookup needed).
   *  Null for the stripped 0x0857 snapshot, which doesn't carry them. */
  look: EntityLook | null;
};

export type EntityLook = {
  hairStyle: number;
  hairColor: number; // headpalette
  clothesColor: number; // bodypalette
  weapon: number;
  shield: number;
  headTop: number;
  headMid: number;
  headLow: number;
  robe: number;
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

/** PosDir (3 bytes, packed): x (10 bits), y (10 bits), dir (4 bits). */
export function readPosDir(b: Uint8Array): { gx: number; gy: number; dir: number } {
  const gx = (b[0] << 2) | (b[1] >> 6);
  const gy = ((b[1] & 0x3f) << 4) | (b[2] >> 4);
  const dir = b[2] & 0x0f;
  return { gx, gy, dir };
}

/** MoveData (6 bytes, packed): fromX/fromY (10 bits each), toX/toY (10 bits
 *  each), sx/sy (4 bits each, sub-tile offsets — currently ignored). */
export function readMoveData(b: Uint8Array): {
  from: { gx: number; gy: number };
  to: { gx: number; gy: number };
} {
  const fromX = (b[0] << 2) | (b[1] >> 6);
  const fromY = ((b[1] & 0x3f) << 4) | (b[2] >> 4);
  const toX = ((b[2] & 0x0f) << 6) | (b[3] >> 2);
  const toY = ((b[3] & 0x03) << 8) | b[4];
  return { from: { gx: fromX, gy: fromY }, to: { gx: toX, gy: toY } };
}

/** Facing (0..7, RO convention) from a step's (dx, dy). */
function dirFromStep(dx: number, dy: number): number {
  const sx = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const sy = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  // roBrowser table indexed by [sx+1][sy+1].
  const TBL = [
    [1, 2, 3],
    [0, 0, 4],
    [7, 6, 5],
  ];
  return TBL[sx + 1][sy + 1];
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

/**
 * 0x0857 — initial-state spawn snapshot stored in container 15. A
 * stripped-down 0x09ff variant: no GID, no HP/maxHP/isBoss block. The
 * fields we care about sit at fixed offsets that don't depend on
 * objType, so we just hop to them directly.
 *
 *   pktLen u16   @ 2
 *   objType u8   @ 4
 *   AID u32      @ 5
 *   view i16     @ 19
 *   appearance block @ 21 (head/weapon/shield/accessories/palettes/robe — same
 *                        fields as the full spawn, so remote players present
 *                        only at recording start still get their gear)
 *   sex u8       @ 58
 *   PosDir (3)   @ 59   (recording-start cell for entities that never moved
 *                        after spawning — without this dummies/NPCs stay
 *                        invisible in the map viewer)
 *   name var     @ 69   (UTF-8 / cp949, fills the remaining bytes)
 *
 * The block between view@19 and PosDir@59 (both verified anchors) holds exactly
 * the standard appearance fields + guild/sex, so the offsets are deterministic
 * (they don't depend on objType or name length).
 */
export function decodeInitialSpawn0857(reader: ByteReader): EntityPacket {
  const pktLen = reader.u16(); // pos 4
  const objectType = reader.u8(); // pos 5
  const aid = reader.u32(); // pos 9
  reader.skip(2 + 2 + 2); // speed/bodyState/healthState (no GID here) -> pos 15
  const option = reader.u32(); // effectState/OPTION bitmask -> pos 19
  const view = reader.i16(); // pos 21
  // Appearance — identical layout to readEntity (weapon/shield 4-byte).
  const head = reader.u16(); // pos 23
  const weapon = reader.u32(); // pos 27
  const shield = reader.u32(); // pos 31
  const accessory = reader.u16(); // headLow, pos 33
  const accessory2 = reader.u16(); // headTop, pos 35
  const accessory3 = reader.u16(); // headMid, pos 37
  const headpalette = reader.u16(); // hairColor, pos 39
  const bodypalette = reader.u16(); // clothesColor, pos 41
  reader.skip(2); // headDir -> pos 43
  const robe = reader.u16(); // garment, pos 45
  reader.skip(4 + 2 + 2 + 4); // GUID, GEmblemVer, honor, virtue -> pos 57
  reader.skip(1); // isPKModeON -> pos 58
  const sex = reader.u8(); // pos 59
  const pos = readPosDir(reader.bytes(3)); // pos 62
  reader.skip(69 - 62); // xSize/ySize/state -> jump to name @69
  const remaining = pktLen - 69;
  const name = remaining > 0 ? readEntityName(reader.bytes(Math.max(0, remaining))) : "";

  return {
    aid,
    gid: 0,
    view,
    kind: classifyObjectType(objectType),
    name,
    isBoss: false,
    level: 0,
    maxHp: 0,
    hp: 0,
    sex,
    option,
    pos,
    walk: null,
    look: {
      hairStyle: head,
      hairColor: headpalette,
      clothesColor: bodypalette,
      weapon,
      shield,
      headTop: accessory2,
      headMid: accessory3,
      headLow: accessory,
      robe,
    },
  };
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
  reader.skip(2 + 2 + 2); // speed, bodyState, healthState
  const option = reader.u32(); // effectState — the OPTION bitmask (mounts/cloak/etc.)
  const job = reader.i16();
  // Appearance block — all client sprite VIEW/look ids. Byte sizes are exactly
  // the old skips (weapon/shield are 4-byte here), so `sex`/`pos` below still
  // land where they did before. head=hairstyle, accessory=headLow,
  // accessory2=headTop, accessory3=headMid, headpalette/bodypalette=colors.
  const head = reader.u16();
  const weapon = reader.u32();
  const shield = reader.u32();
  const accessory = reader.u16();
  if (hasMoveStart) reader.skip(4); // moveStartTime
  const accessory2 = reader.u16();
  const accessory3 = reader.u16();
  const headpalette = reader.u16();
  const bodypalette = reader.u16();
  reader.skip(2); // headDir
  const robe = reader.u16();
  reader.skip(4); // GUID
  reader.skip(2 + 2 + 4); // GEmblemVer, honor, virtue
  reader.skip(1); // isPKModeON
  const sex = reader.u8();

  let pos: { gx: number; gy: number; dir: number } | null = null;
  let walk: { from: { gx: number; gy: number }; to: { gx: number; gy: number } } | null = null;
  if (hasMoveStart) {
    const md = readMoveData(reader.bytes(6));
    walk = md;
    const dx = md.to.gx - md.from.gx;
    const dy = md.to.gy - md.from.gy;
    pos = { gx: md.from.gx, gy: md.from.gy, dir: dx === 0 && dy === 0 ? 0 : dirFromStep(dx, dy) };
  } else {
    pos = readPosDir(reader.bytes(3));
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
    sex,
    option,
    pos,
    walk,
    look: {
      hairStyle: head,
      hairColor: headpalette,
      clothesColor: bodypalette,
      weapon,
      shield,
      headTop: accessory2,
      headMid: accessory3,
      headLow: accessory,
      robe,
    },
  };
}
