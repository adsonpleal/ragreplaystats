import type { RecordedAt } from "./crypt.js";

export type ReplayHeader = {
  version: number;
  sig: string;
  recordedAt: RecordedAt;
  /** Byte offset where the ChunkContainer descriptor table begins. */
  containerTableOffset: number;
};

const HEADER_PREFIX_BYTES = 100;

export function readHeader(buf: ArrayBuffer): ReplayHeader {
  if (buf.byteLength < 112) {
    throw new Error(
      `File too small: ${buf.byteLength} bytes (need at least 112).`,
    );
  }

  const view = new DataView(buf);
  const ascii = new TextDecoder("ascii").decode(
    new Uint8Array(buf, 0, Math.min(40, buf.byteLength)),
  );
  if (!ascii.startsWith("<< Ragnarok Replay File Version")) {
    throw new Error("Not a Ragnarok replay file (magic mismatch).");
  }

  let offset = HEADER_PREFIX_BYTES;
  const version = view.getUint8(offset);
  offset += 1;

  if (version !== 5) {
    throw new Error(`Unsupported replay version 0x${version.toString(16)} (expected 5 / "0.05").`);
  }

  const sig = new TextDecoder("ascii").decode(new Uint8Array(buf, offset, 3));
  offset += 3;

  const year = view.getInt16(offset, true);
  offset += 2;
  const month = view.getUint8(offset);
  offset += 1;
  const day = view.getUint8(offset);
  offset += 1;
  // Padding / unused byte (DateUnused in the reference parser).
  offset += 1;
  const hour = view.getUint8(offset);
  offset += 1;
  const minute = view.getUint8(offset);
  offset += 1;
  const second = view.getUint8(offset);
  offset += 1;

  return {
    version,
    sig,
    recordedAt: { year, month, day, hour, minute, second },
    containerTableOffset: offset,
  };
}
