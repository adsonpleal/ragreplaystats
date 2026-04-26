export type RecordedAt = {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export type CryptKeys = { k1: number; k2: number };

export function deriveKeys(d: RecordedAt): CryptKeys {
  const buf = new ArrayBuffer(4);
  const view = new DataView(buf);

  view.setInt16(0, d.year, true);
  view.setUint8(2, d.month);
  view.setUint8(3, d.day);
  const k1 = view.getInt32(0, true) >> 5;

  view.setUint8(0, 0);
  view.setUint8(1, d.hour);
  view.setUint8(2, d.minute);
  view.setUint8(3, d.second);
  const k2 = view.getInt32(0, true) >> 3;

  return { k1, k2 };
}

export function decryptChunk(
  data: Uint8Array,
  size: number,
  keys: CryptKeys,
): Uint8Array {
  const out = new Uint8Array(data.length);
  out.set(data);

  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const wordCount = Math.floor(size / 4);

  for (let cursor = 0; cursor < wordCount; cursor++) {
    const old = view.getInt32(cursor * 4, true);
    const xorVal = Math.imul(keys.k1 + cursor + 1, keys.k2);
    view.setInt32(cursor * 4, old ^ xorVal, true);
  }

  return out;
}
