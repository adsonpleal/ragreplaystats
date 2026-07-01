// Little-endian binary cursor over an ArrayBuffer, shared by the map-format
// parsers (gat/gnd/rsw/rsm). RO stores strings as EUC-KR (Korean) — the same
// charset the offline extractor decodes — so resource names match the manifest
// keys (tools/roformat.ts normName: lowercased, forward-slash).
//
// These formats are little-endian throughout; `long` in the RO sources means a
// 32-bit int. Ported from roBrowser's Utils/BinaryReader.

const EUCKR = new TextDecoder("euc-kr");

export class BinaryReader {
  private view: DataView;
  private bytes: Uint8Array;
  offset = 0;

  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
  }

  get length(): number {
    return this.bytes.length;
  }
  get eof(): boolean {
    return this.offset >= this.bytes.length;
  }

  seek(n: number): void {
    this.offset += n;
  }

  u8(): number {
    return this.bytes[this.offset++];
  }
  i8(): number {
    return this.view.getInt8(this.offset++);
  }
  u16(): number {
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }
  i16(): number {
    const v = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }
  i32(): number {
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }
  f32(): number {
    const v = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return v;
  }

  /** Fixed-length, NUL-terminated string field (EUC-KR). */
  str(n: number): string {
    let end = this.offset;
    const lim = this.offset + n;
    while (end < lim && this.bytes[end] !== 0) end++;
    const s = EUCKR.decode(this.bytes.subarray(this.offset, end));
    this.offset += n;
    return s;
  }

  /** Length-prefixed string (modern RSW/RSM 2.x): a u32 length then the bytes. */
  lstr(): string {
    return this.str(this.u32());
  }

  /** A view onto `n` raw bytes at the cursor, advancing past them. */
  bytesView(n: number): Uint8Array {
    const v = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return v;
  }
}

/** Resource-name key shared by the manifest and the parsers: lowercase,
 *  forward-slash, no leading slash. Must match tools/roformat.mjs `normName`. */
export function normName(name: string): string {
  return name.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
}
