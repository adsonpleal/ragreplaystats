export class ByteReader {
  private view: DataView;
  position = 0;

  constructor(public data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get length() {
    return this.data.byteLength;
  }

  get remaining() {
    return this.data.byteLength - this.position;
  }

  u8(): number {
    return this.view.getUint8(this.position++);
  }
  i8(): number {
    return this.view.getInt8(this.position++);
  }
  u16(): number {
    const v = this.view.getUint16(this.position, true);
    this.position += 2;
    return v;
  }
  i16(): number {
    const v = this.view.getInt16(this.position, true);
    this.position += 2;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.position, true);
    this.position += 4;
    return v;
  }
  i32(): number {
    const v = this.view.getInt32(this.position, true);
    this.position += 4;
    return v;
  }
  i64(): bigint {
    const v = this.view.getBigInt64(this.position, true);
    this.position += 8;
    return v;
  }

  bytes(n: number): Uint8Array {
    const out = this.data.subarray(this.position, this.position + n);
    this.position += n;
    return out;
  }

  skip(n: number) {
    this.position += n;
  }

  seek(n: number) {
    this.position = n;
  }
}

// Korean clients store names as cp949/euc-kr; western/Brazilian forks use
// Windows-1252. Try cp949 first; if the bytes aren't a valid cp949 sequence,
// fall back to Windows-1252 (which never fails for any byte sequence).
const cp949Strict = (() => {
  try {
    return new TextDecoder("euc-kr", { fatal: true });
  } catch {
    return null;
  }
})();
const latin1 = new TextDecoder("windows-1252", { fatal: false });

function decodeName(bytes: Uint8Array): string {
  if (cp949Strict) {
    try {
      return cp949Strict.decode(bytes);
    } catch {
      // fall through
    }
  }
  return latin1.decode(bytes);
}

/** Decode a null-terminated string from a fixed-length window. */
export function readKoreanZ(buf: Uint8Array): string {
  let end = buf.length;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      end = i;
      break;
    }
  }
  return decodeName(buf.subarray(0, end));
}

/**
 * Newer Ragnarok clients sometimes prepend extra bytes (clan/title/state IDs)
 * before the trailing entity name. Skip leading bytes that aren't plausible
 * starts of a printable name, then null-terminate as usual.
 */
export function readEntityName(buf: Uint8Array): string {
  let start = 0;
  while (
    start < buf.length &&
    (buf[start] === 0x00 || buf[start] === 0xff)
  ) {
    start++;
  }
  let end = buf.length;
  for (let i = start; i < buf.length; i++) {
    if (buf[i] === 0) {
      end = i;
      break;
    }
  }
  return decodeName(buf.subarray(start, end));
}
