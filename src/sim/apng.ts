// APNG playback helpers for the sim. The byte parser lives in core/apng (shared
// with the costume preview); here we add the network fetch and the frame-timing
// used to drive the billboard. The sim drives the sprite frame-by-frame (a
// covered/hidden APNG is paused by the browser, so it can't animate natively
// into the WebGL texture), which is why it needs the real frame count AND the
// per-frame delays: an animated costume (e.g. a 24-frame wing garment) makes a
// pose longer than the bare body, and the delays make playback match the
// paper-doll's native APNG speed. ragassets sends `Access-Control-Allow-Origin:
// *`, so the bytes are readable cross-origin.

import { parseApng, type ApngInfo } from "./coreApng";

export type { ApngInfo };

/** Fetch a rendered (A)PNG and read its frame count + delays; on any failure
 *  returns a single static frame so the caller can fall back to ACTION_FRAMES. */
export async function fetchApngInfo(url: string): Promise<ApngInfo> {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return parseApng(await r.arrayBuffer());
  } catch {
    return { count: 1, delays: [] };
  }
}

/** Default per-frame delay (seconds) when an animation's real delays are unknown
 *  (probe failed) — a reasonable RO-ish frame interval. */
export const DEFAULT_FRAME_DELAY = 0.15;

/** Frame index to show at elapsed time `clock`, replicating native APNG looping:
 *  each frame is held for its own delay, then the sequence repeats. Falls back to
 *  a uniform delay when per-frame delays are missing. */
export function frameAt(clock: number, info: ApngInfo): number {
  const n = info.count;
  if (n <= 1) return 0;
  if (info.delays.length !== n) {
    const d = info.delays[0] || DEFAULT_FRAME_DELAY;
    return Math.floor(clock / d) % n;
  }
  let total = 0;
  for (const d of info.delays) total += d;
  if (total <= 0) return 0;
  let t = clock % total;
  for (let f = 0; f < n; f++) {
    t -= info.delays[f];
    if (t < 0) return f;
  }
  return n - 1;
}
