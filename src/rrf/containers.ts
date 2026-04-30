import { type CryptKeys, decryptChunk } from "./crypt.js";

export const ContainerType = {
  None: 0,
  PacketStream: 1,
  ReplayData: 2,
  Session: 3,
  Status: 4,
  Quests: 6,
  GroupAndFriends: 7,
  Items: 8,
  UnknownContainingPet: 9,
  InitialPackets: 14,
  /**
   * Snapshot of entities visible at recording start, stored as 0x0857 spawn
   * packets (one per chunk, chunk id=210). Bracketed by chunks with ids
   * 10000 / 10001 of length 0 as begin/end markers.
   */
  InitialEntities: 15,
  Efst: 17,
} as const;

export type PacketChunk = {
  id: number;
  /** Milliseconds from session start. */
  time: number;
  length: number;
  /** Decrypted packet bytes (starts with the 2-byte packet header). */
  data: Uint8Array;
  /** First two bytes interpreted as little-endian u16. */
  packetId: number;
};

export type GenericChunk = {
  id: number;
  length: number;
  data: Uint8Array;
};

export type Container = {
  type: number;
  declaredLength: number;
  offset: number;
  realLength: number;
};

export type PacketStreamContainer = Container & {
  kind: "packetStream";
  chunks: PacketChunk[];
};

export type GenericContainer = Container & {
  kind: "generic";
  chunks: GenericChunk[];
};

export type AnyContainer = PacketStreamContainer | GenericContainer;

const CONTAINER_COUNT = 24;
const DESCRIPTOR_BYTES = 10;

export function readContainers(
  buf: ArrayBuffer,
  tableOffset: number,
  keys: CryptKeys,
): AnyContainer[] {
  const view = new DataView(buf);
  const fileSize = buf.byteLength;
  const containers: AnyContainer[] = [];

  for (let i = 0; i < CONTAINER_COUNT; i++) {
    const descOffset = tableOffset + i * DESCRIPTOR_BYTES;
    const type = view.getUint16(descOffset, true);
    const declaredLength = view.getInt32(descOffset + 2, true);
    const offset = view.getInt32(descOffset + 6, true);

    let realLength = declaredLength;
    if (realLength === 0 && offset > 0) {
      realLength = fileSize - offset;
    }

    const base: Container = { type, declaredLength, offset, realLength };

    // Empty / unused slot.
    if (offset === 0 && declaredLength === 0) {
      containers.push({ ...base, kind: "generic", chunks: [] });
      continue;
    }

    if (offset < 0 || offset >= fileSize || offset + realLength > fileSize) {
      throw new Error(
        `Container ${i} (type ${type}) has invalid bounds offset=${offset} length=${realLength} (filesize=${fileSize}).`,
      );
    }

    const body = new Uint8Array(buf, offset, realLength);

    if (type === ContainerType.PacketStream) {
      containers.push({
        ...base,
        kind: "packetStream",
        chunks: parsePacketStream(body, keys),
      });
    } else {
      containers.push({
        ...base,
        kind: "generic",
        chunks: parseGenericContainer(body, declaredLength, keys),
      });
    }
  }

  return containers;
}

function parsePacketStream(body: Uint8Array, keys: CryptKeys): PacketChunk[] {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const chunks: PacketChunk[] = [];
  let ptr = 0;
  while (ptr + 10 <= body.byteLength) {
    const id = view.getInt32(ptr, true);
    const time = view.getInt32(ptr + 4, true);
    const length = view.getUint16(ptr + 8, true);
    const dataStart = ptr + 10;
    const dataEnd = dataStart + length;
    if (dataEnd > body.byteLength) {
      // Truncated final chunk — bail out cleanly.
      break;
    }
    const encrypted = body.subarray(dataStart, dataEnd);
    const decrypted = decryptChunk(encrypted, length, keys);
    const packetId =
      decrypted.length >= 2 ? decrypted[0] | (decrypted[1] << 8) : 0;

    chunks.push({ id, time, length, data: decrypted, packetId });
    ptr = dataEnd;
  }
  return chunks;
}

function parseGenericContainer(
  body: Uint8Array,
  declaredLength: number,
  keys: CryptKeys,
): GenericChunk[] {
  if (declaredLength <= 0) return [];

  // The reference parser passes `container.Length` (declared, not real) to Crypt.
  // Bytes past `declaredLength` (i.e., the tail when realLength > declaredLength)
  // are not decrypted — copy them through as-is.
  const decrypted = decryptChunk(body, declaredLength, keys);

  const view = new DataView(
    decrypted.buffer,
    decrypted.byteOffset,
    decrypted.byteLength,
  );

  const chunks: GenericChunk[] = [];
  let ptr = 0;
  while (ptr + 6 <= declaredLength) {
    const id = view.getInt16(ptr, true);
    const length = view.getInt32(ptr + 2, true);
    const dataStart = ptr + 6;
    const dataEnd = dataStart + length;
    if (length < 0 || dataEnd > decrypted.byteLength) break;
    chunks.push({
      id,
      length,
      data: decrypted.subarray(dataStart, dataEnd),
    });
    ptr = dataEnd;
  }
  return chunks;
}
