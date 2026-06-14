/** A macrotask yield (not rAF — rAF doesn't fire in a backgrounded tab). */
export const delay = (ms = 0) => new Promise<void>((res) => setTimeout(res, ms));

/**
 * Deep-clone a node for the print report, replacing every live <canvas> (uPlot
 * charts) with a static <img> of its current pixels. Cloning a canvas yields a
 * blank element and a live canvas can be blanked by uPlot's ResizeObserver once
 * it lands in the report — the snapshot sidesteps both and prints reliably.
 */
export function snapshotNode(node: Node): Node {
  if (node instanceof HTMLCanvasElement) {
    try {
      const img = document.createElement("img");
      img.src = node.toDataURL("image/png");
      const w = node.style.width || (node.clientWidth ? `${node.clientWidth}px` : "");
      const h = node.style.height || (node.clientHeight ? `${node.clientHeight}px` : "");
      if (w) img.style.width = w;
      if (h) img.style.height = h;
      return img;
    } catch {
      return node.cloneNode(true);
    }
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return node.cloneNode(true);
  const clone = node.cloneNode(false);
  for (const child of node.childNodes) clone.appendChild(snapshotNode(child));
  return clone;
}

/** Resolve once every <img> under `root` has loaded (or errored), or on timeout. */
export function waitForImages(root: HTMLElement | null, timeoutMs = 4000): Promise<void> {
  if (!root) return Promise.resolve();
  const pending = [...root.querySelectorAll("img")].filter((img) => !img.complete);
  if (!pending.length) return Promise.resolve();
  return new Promise((resolve) => {
    let remaining = pending.length;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const one = () => {
      if (--remaining <= 0) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    for (const img of pending) {
      img.addEventListener("load", one, { once: true });
      img.addEventListener("error", one, { once: true });
    }
  });
}
