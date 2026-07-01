// Animated mouse cursor driven from the render loop. RO's cursors.act gives each
// cursor a frame sequence — the default arrow periodically sparkles, and the
// rotate-drag cursor is the two-curvy-arrows. CSS `cursor: url(...)` can't animate
// on its own, so we swap the element's cursor URL through the frames on a
// fixed-fps clock (only writing style when the displayed frame actually changes).
//
// Each frame is inlined as a `data:` URL fetched once: a CSS cursor pointed at a
// file URL re-hits the network on every swap (the browser doesn't cache cursor
// image fetches reliably), so cycling the animation would request the PNGs over
// and over. Data URLs are in-document, so there are zero requests after load.

import type { CursorAnim } from "./render/scene";

// Frame URL → data: URL, fetched once and kept for the whole session.
const dataUrlCache = new Map<string, string>();

function toDataUrl(url: string): Promise<string> {
  const cached = dataUrlCache.get(url);
  if (cached) return Promise.resolve(cached);
  return fetch(url)
    .then((res) => res.blob())
    .then(
      (blob) =>
        new Promise<string>((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result as string);
          fr.onerror = () => reject(fr.error);
          fr.readAsDataURL(blob);
        }),
    )
    .then((data) => {
      dataUrlCache.set(url, data);
      return data;
    });
}

export class CursorAnimator {
  private defs = new Map<string, CursorAnim>();
  private active: string | null = null;
  private clock = 0;
  private step = -1;

  constructor(
    private readonly el: HTMLElement,
    private readonly base: string,
  ) {}

  /** Register a named cursor and inline its frames as data URLs (fetched once),
   *  so animating/swapping the CSS cursor never re-requests the images. */
  add(name: string, def?: CursorAnim): void {
    if (!def?.frames?.length) return;
    this.defs.set(name, def);
    for (const f of def.frames) {
      toDataUrl(this.base + f)
        .then(() => {
          if (this.active === name) this.apply(); // swap the live cursor to the cached data URL
        })
        .catch(() => {});
    }
  }

  /** Switch the active cursor (no-op if unchanged or not registered). */
  set(name: string): void {
    if (this.active === name || !this.defs.has(name)) return;
    this.active = name;
    this.clock = 0;
    this.step = -1;
    this.apply();
  }

  /** Advance the animation; call once per frame with delta seconds. */
  update(dt: number): void {
    const def = this.active ? this.defs.get(this.active) : undefined;
    if (!def || def.seq.length < 2) return;
    this.clock += dt;
    const step = Math.floor(this.clock * def.fps) % def.seq.length;
    if (step !== this.step) {
      this.step = step;
      this.apply();
    }
  }

  private apply(): void {
    const def = this.active ? this.defs.get(this.active) : undefined;
    if (!def) {
      this.el.style.cursor = "default";
      return;
    }
    const idx = def.seq[this.step < 0 ? 0 : this.step] ?? def.seq[0];
    const file = def.frames[idx] ?? def.frames[0];
    const full = this.base + file;
    // Prefer the cached data URL; fall back to the file URL only until it loads.
    const url = dataUrlCache.get(full) ?? full;
    const [hx, hy] = def.hotspot;
    this.el.style.cursor = `url("${url}") ${hx} ${hy}, ${def.fallback}`;
  }
}
