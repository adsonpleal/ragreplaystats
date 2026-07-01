// Shared in-memory image cache for the sim. Each URL is fetched + decoded once
// and its HTMLImageElement is retained for the whole session, so nothing re-hits
// the network on reuse. Used by:
//  - the animated character sprite frames (drawn into a canvas; cross-origin
//    ragassets, hence crossOrigin="anonymous" to keep the canvas untainted), and
//  - the animated mouse cursor frames (kept warm so CSS `cursor: url(...)` swaps
//    never re-fetch — the throwaway-Image preload they used to do could be GC'd).

const cache = new Map<string, HTMLImageElement>();

export function loadImage(url: string): HTMLImageElement {
  let im = cache.get(url);
  if (!im) {
    im = new Image();
    im.crossOrigin = "anonymous";
    im.decoding = "async";
    im.src = url;
    cache.set(url, im);
  }
  return im;
}
