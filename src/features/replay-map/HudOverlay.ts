// DOM overlays on top of the WebGL canvas: hover-tooltip and the local
// player's HP/SP/AP bars. We keep these in the DOM (not as billboards) because
// they're 2D UI: crisp text at any zoom, native tooltips positioning, and no
// GPU billboard math for something the camera-facing quad would only mimic.
//
// The elements are children of the overlay wrapper; each frame the render
// loop projects the world anchor into screen space and updates the element's
// transform. When there's no anchor (actor unseen), the element hides.

import type { PerspectiveCamera } from "three";
import { Vector3 } from "three";

const HP_MAX_WIDTH_PX = 42;
const CAST_BAR_WIDTH_PX = 60;

export class HoverTooltip {
  readonly el: HTMLDivElement;
  private lastShown = false;
  private lastText = "";
  constructor(parent: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "replay-map-tooltip";
    this.el.style.display = "none";
    parent.appendChild(this.el);
  }

  /** Show the name pinned at the actor's projected feet point. The caller
   *  projects the world anchor once — we position at (x, y) and horizontally
   *  centre with a -50% self-translate (nested into translate3d so we stay
   *  on the GPU-composited path per frame). */
  showAt(text: string, x: number, y: number): void {
    if (this.lastText !== text) {
      this.el.textContent = text;
      this.lastText = text;
    }
    if (!this.lastShown) {
      this.el.style.display = "";
      this.lastShown = true;
    }
    this.el.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, 0)`;
  }

  hide(): void {
    if (!this.lastShown) return;
    this.el.style.display = "none";
    this.lastShown = false;
  }

  dispose(): void {
    this.el.remove();
  }
}

/** HP / SP / AP triple-bar pinned to the player's projected screen position.
 *  Each bar is a coloured fill inside a bordered track; the fill width is a
 *  fraction of the max. `updateValues` sets the fractions, `updatePosition`
 *  moves the whole widget to the projected 2D point per frame. */
export class VitalBars {
  readonly el: HTMLDivElement;
  private readonly hp: HTMLDivElement;
  private readonly sp: HTMLDivElement;
  private readonly ap: HTMLDivElement;
  private hpFrac = 1;
  private spFrac = 1;
  private apFrac = 0;

  constructor(parent: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "replay-map-vitals";
    this.el.style.display = "none";
    const mkRow = (bar: "hp" | "sp" | "ap"): { row: HTMLDivElement; fill: HTMLDivElement } => {
      const row = document.createElement("div");
      row.className = `replay-map-vitals-row replay-map-vitals-${bar}`;
      const fill = document.createElement("div");
      fill.className = "replay-map-vitals-fill";
      row.appendChild(fill);
      return { row, fill };
    };
    const hpRow = mkRow("hp");
    const spRow = mkRow("sp");
    const apRow = mkRow("ap");
    this.hp = hpRow.fill;
    this.sp = spRow.fill;
    this.ap = apRow.fill;
    // Always show the AP bar (empty when the replay pre-dates 4th job); user
    // asked for a consistent three-row layout regardless of the recording.
    this.el.appendChild(hpRow.row);
    this.el.appendChild(spRow.row);
    this.el.appendChild(apRow.row);
    parent.appendChild(this.el);
  }

  setValues(hp: number, maxHp: number, sp: number, maxSp: number, ap: number, maxAp: number): void {
    const hpFrac = maxHp > 0 ? clamp01(hp / maxHp) : 1;
    const spFrac = maxSp > 0 ? clamp01(sp / maxSp) : 1;
    const apFrac = maxAp > 0 ? clamp01(ap / maxAp) : 0;
    if (hpFrac !== this.hpFrac) {
      this.hp.style.width = `${hpFrac * HP_MAX_WIDTH_PX}px`;
      this.hpFrac = hpFrac;
    }
    if (spFrac !== this.spFrac) {
      this.sp.style.width = `${spFrac * HP_MAX_WIDTH_PX}px`;
      this.spFrac = spFrac;
    }
    if (apFrac !== this.apFrac) {
      this.ap.style.width = `${apFrac * HP_MAX_WIDTH_PX}px`;
      this.apFrac = apFrac;
    }
    // AP row is always visible now — no per-frame show/hide.
  }

  setVisible(v: boolean): void {
    this.el.style.display = v ? "" : "none";
  }

  setScreenXY(x: number, y: number): void {
    // translate3d = GPU-composited fast path; append a translate(-50%, 0) so
    // the widget centres horizontally on the projected foot pixel (CSS-only
    // `transform: translate(-50%, 0)` would be overwritten by this per-frame
    // set, so we bake it inline).
    this.el.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, 0)`;
  }

  dispose(): void {
    this.el.remove();
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** DOM cast bar (skill-cast progress) pinned above an actor's projected screen
 *  point. Pooled — active bars indexed by AID; casting a second skill before
 *  the first finishes replaces the bar rather than stacking. Position is set
 *  per frame by whoever owns it. */
export class CastBarLayer {
  private readonly parent: HTMLElement;
  private readonly byAid = new Map<number, CastBar>();
  private readonly pool: CastBar[] = [];

  constructor(parent: HTMLElement) {
    this.parent = parent;
  }

  private acquire(): CastBar {
    const free = this.pool.find((b) => !b.active);
    if (free) return free;
    const b = new CastBar(this.parent);
    this.pool.push(b);
    return b;
  }

  spawn(aid: number, nowMs: number, castMs: number): void {
    let b = this.byAid.get(aid);
    if (!b || !b.active) {
      b = this.acquire();
      this.byAid.set(aid, b);
    }
    b.start(nowMs, castMs);
  }

  update(
    nowMs: number,
    project: (aid: number, out: { x: number; y: number }) => boolean,
  ): void {
    const out = tmpXY;
    for (const [aid, b] of this.byAid) {
      if (b.expiresAtMs <= nowMs) {
        b.hide();
        this.byAid.delete(aid);
        continue;
      }
      if (!project(aid, out)) {
        b.hide();
        continue;
      }
      b.setScreenXY(out.x, out.y);
      b.setProgress((nowMs - b.startedAtMs) / (b.expiresAtMs - b.startedAtMs));
      b.setVisible(true);
    }
  }

  dispose(): void {
    for (const b of this.pool) b.dispose();
    this.pool.length = 0;
    this.byAid.clear();
  }
}

class CastBar {
  readonly el: HTMLDivElement;
  private readonly fill: HTMLDivElement;
  active = false;
  startedAtMs = 0;
  expiresAtMs = 0;
  private lastProgress = -1;
  private lastVisible = false;

  constructor(parent: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "replay-map-castbar";
    this.el.style.display = "none";
    this.fill = document.createElement("div");
    this.fill.className = "replay-map-castbar-fill";
    this.el.appendChild(this.fill);
    parent.appendChild(this.el);
  }

  start(nowMs: number, castMs: number): void {
    this.startedAtMs = nowMs;
    this.expiresAtMs = nowMs + Math.max(200, castMs);
    this.active = true;
    this.lastProgress = -1;
  }

  setProgress(p: number): void {
    const clamped = clamp01(p);
    if (Math.abs(clamped - this.lastProgress) < 0.01) return;
    this.lastProgress = clamped;
    this.fill.style.width = `${clamped * CAST_BAR_WIDTH_PX}px`;
  }

  setScreenXY(x: number, y: number): void {
    // translate3d = GPU-composited; append -50% self-translate so the bar
    // centres on the projected screen pixel (any CSS `transform:` we set
    // here per frame would win over the class rule, so we bake it inline).
    this.el.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, 0)`;
  }

  setVisible(v: boolean): void {
    if (v === this.lastVisible) return;
    this.lastVisible = v;
    this.el.style.display = v ? "" : "none";
  }

  hide(): void {
    this.active = false;
    this.setVisible(false);
  }

  dispose(): void {
    this.el.remove();
  }
}

const tmpXY = { x: 0, y: 0 };

/** DOM skill-name banner shown above the cast bar during a cast. Same lifetime
 *  and per-actor pooling as CastBarLayer; the two draw stacked (name above,
 *  bar below) at the caster's projected screen point. */
export class CastNameLayer {
  private readonly parent: HTMLElement;
  private readonly byAid = new Map<number, CastName>();
  private readonly pool: CastName[] = [];

  constructor(parent: HTMLElement) {
    this.parent = parent;
  }

  private acquire(): CastName {
    const free = this.pool.find((n) => !n.active);
    if (free) return free;
    const n = new CastName(this.parent);
    this.pool.push(n);
    return n;
  }

  spawn(aid: number, text: string, nowMs: number, castMs: number): void {
    let n = this.byAid.get(aid);
    if (!n || !n.active) {
      n = this.acquire();
      this.byAid.set(aid, n);
    }
    n.start(text, nowMs, castMs);
  }

  update(
    nowMs: number,
    project: (aid: number, out: { x: number; y: number }) => boolean,
  ): void {
    const out = tmpXY;
    for (const [aid, n] of this.byAid) {
      if (n.expiresAtMs <= nowMs) {
        n.hide();
        this.byAid.delete(aid);
        continue;
      }
      if (!project(aid, out)) {
        n.hide();
        continue;
      }
      n.setScreenXY(out.x, out.y);
      n.setVisible(true);
    }
  }

  dispose(): void {
    for (const n of this.pool) n.dispose();
    this.pool.length = 0;
    this.byAid.clear();
  }
}

class CastName {
  readonly el: HTMLDivElement;
  active = false;
  expiresAtMs = 0;
  private lastText = "";
  private lastVisible = false;

  constructor(parent: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "replay-map-castname";
    this.el.style.display = "none";
    parent.appendChild(this.el);
  }

  start(text: string, nowMs: number, castMs: number): void {
    if (text !== this.lastText) {
      this.el.textContent = text;
      this.lastText = text;
    }
    this.expiresAtMs = nowMs + Math.max(200, castMs);
    this.active = true;
  }

  setScreenXY(x: number, y: number): void {
    this.el.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, 0)`;
  }

  setVisible(v: boolean): void {
    if (v === this.lastVisible) return;
    this.lastVisible = v;
    this.el.style.display = v ? "" : "none";
  }

  hide(): void {
    this.active = false;
    this.setVisible(false);
  }

  dispose(): void {
    this.el.remove();
  }
}

/** Project a world point onto the wrap's client rectangle, in wrap-relative
 *  pixels. Returns null when the point is behind the camera. */
export function projectToScreen(
  world: Vector3,
  camera: PerspectiveCamera,
  wrapWidth: number,
  wrapHeight: number,
  out: { x: number; y: number },
): boolean {
  tmp.copy(world).project(camera);
  if (tmp.z > 1) return false; // behind the near plane
  out.x = (tmp.x * 0.5 + 0.5) * wrapWidth;
  out.y = (-tmp.y * 0.5 + 0.5) * wrapHeight;
  return true;
}

const tmp = new Vector3();
