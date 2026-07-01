// Pure (A)PNG chunk reader: the frame count (acTL) and per-frame delays (fcTL)
// of a rendered sprite. Framework-free so both the costume preview
// (hooks/useFrameCount, which only needs the count) and the map sim
// (sim/apng.ts, which also drives playback from the delays) share one parser
// instead of each walking the byte layout. A plain PNG (no acTL) is one frame.

/** Frame count plus per-frame delays (seconds) of a composited (A)PNG. */
export type ApngInfo = { count: number; delays: number[] };

/** Parse the acTL (frame count) and fcTL (per-frame delays) chunks. */
export function parseApng(buf: ArrayBuffer): ApngInfo {
  const b = new DataView(buf);
  if (b.byteLength < 8) return { count: 1, delays: [] };
  let count = 1;
  const delays: number[] = [];
  let i = 8; // skip the 8-byte PNG signature
  while (i + 8 <= b.byteLength) {
    const len = b.getUint32(i);
    const type = String.fromCharCode(b.getUint8(i + 4), b.getUint8(i + 5), b.getUint8(i + 6), b.getUint8(i + 7));
    const data = i + 8;
    if (type === "acTL") {
      count = b.getUint32(data); // num_frames is acTL's first field
    } else if (type === "fcTL") {
      // fcTL: seq(4) w(4) h(4) x(4) y(4) delay_num(u16) delay_den(u16) ...
      const num = b.getUint16(data + 20);
      let den = b.getUint16(data + 22);
      if (den === 0) den = 100; // APNG spec: a 0 denominator means 1/100s
      delays.push(num / den);
    } else if (type === "IEND") {
      break;
    }
    i += 12 + len; // length(4) + type(4) + data + crc(4)
  }
  return { count, delays };
}
