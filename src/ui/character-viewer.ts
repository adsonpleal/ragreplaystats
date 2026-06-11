// Character viewer — renders the local player's sprite (with their equipped
// gear) using ragassets (https://github.com/adsonpleal/ragassets), a caching
// HTTP gateway over zrenderer (https://github.com/zhad3/zrenderer). A single
// `<img>` pointed at `/image?...` does everything: animations come back as APNG
// that the browser plays natively, so no animation library is needed.
//
// zrenderer encodes body direction AND animation type into one number:
//     action = animationType * 8 + bodyDirection   (0=S, 1=SW … 7=SE)
// `headdir` rotates only the head. Gear params (headgear/garment/weapon/shield)
// take sprite "view" ids (the client's ClassNum), NOT item ids — see
// resolveItemView in the DB loader.

import { t } from "../i18n.js";
import { CHEVRON_LEFT, CHEVRON_RIGHT, chevronButton } from "./controls.js";
import { attackActionType } from "./weapon-action.js";

/** Base URL of the ragassets gateway. Point this at a self-hosted instance for
 *  heavy use — the public one has no SLA. */
const RAGASSETS_BASE = "https://ragassets.duckdns.org";

// Defaults for appearance the replay doesn't capture.
const DEFAULT_HEAD = 1; // hairstyle id
// Fixed render canvas (WxH+anchorX+anchorY), identical for EVERY state/direction:
// the sprite's origin (its ground point) always lands on the same canvas pixel, so
// the feet stay aligned when switching walk/sit/dead and nothing resizes while
// rotating. 124px above the origin fits standing bodies + headgear; 45px below fits
// the poses that extend under the ground line (sit and dead both measured ≲41px).
const CANVAS = "200x169+100+124";

// Slot orders (indices into main.ts's EQUIP_SLOTS) for the visually-rendered
// pieces. Costume orders take precedence over their normal counterparts.
const SLOT = {
  headTop: 0,
  headMid: 1,
  headLow: 2,
  weapon: 4,
  shield: 5,
  garment: 6,
  costumeHeadTop: 11,
  costumeHeadMid: 12,
  costumeHeadLow: 13,
  costumeGarment: 14,
} as const;

// zrenderer headdir values. We cycle straight → right → left.
// NOTE: the public ragassets instance currently renders `headdir` as a no-op
// (every value yields an identical image), so the head-rotation buttons won't
// visibly turn the head until head direction is enabled gateway/zrenderer-side.
// We still send the documented param so it "just works" once that's fixed.
const HEAD_DIRS = [0, 1, 2] as const;

// Head rotation only makes sense for the idle and sit poses; in every other
// state the head follows the body, so the controls are disabled and the head is
// forced straight. Animation types: 0 = idle, 2 = sit.
const HEAD_ROTATE_STATES = new Set([0, 2]);

// Sentinel for the single "Atacar" entry: the real attack animation type is
// resolved from the equipped weapon at render time (see attackActionType).
const ATTACK = -1;

// Ordered states for the dropdown. `type` is the zrenderer animation type, or
// ATTACK for the weapon-driven attack.
const STATE_LIST: ReadonlyArray<{ type: number; label: string }> = [
  { type: 0, label: t.characterStates.idle },
  { type: 1, label: t.characterStates.walk },
  { type: 2, label: t.characterStates.sit },
  { type: 3, label: t.characterStates.pickup },
  { type: 4, label: t.characterStates.standby },
  { type: ATTACK, label: t.characterStates.attack },
  { type: 12, label: t.characterStates.casting }, // zrenderer SKILL action
  { type: 6, label: t.characterStates.hurt },
  { type: 7, label: t.characterStates.frozen },
  { type: 8, label: t.characterStates.dead },
  { type: 9, label: t.characterStates.frozen2 },
];

export type EquippedSlot = { slotOrder: number; itemId: number };

export type CharacterViewerOptions = {
  /** The local player's job/class id (entity.view). */
  jobView: number;
  /** 0 = female, 1 = male. Auto-detected from the replay; defaults to male. */
  sex?: number;
  /** Item id → sprite view id (ClassNum); `null` when unknown. */
  resolveItemView: (itemId: number) => number | null;
};

type Gear = {
  headgear: number[];
  garment: number | null;
  weapon: number | null;
  shield: number | null;
};

export type CharacterViewer = {
  el: HTMLElement;
  /** Recompute the rendered gear from the currently-shown equipment page. */
  update(rows: ReadonlyArray<EquippedSlot>): void;
};

/** Label + `<` `>` chevron pair, one row of the viewer's control stack. */
function rotateRow(
  label: string,
  onPrev: () => void,
  onNext: () => void,
): { row: HTMLDivElement; prev: HTMLButtonElement; next: HTMLButtonElement } {
  const row = document.createElement("div");
  row.className = "character-control-row";
  const lbl = document.createElement("span");
  lbl.className = "character-control-label";
  lbl.textContent = label;
  const prev = chevronButton(CHEVRON_LEFT, t.characterRotatePrev);
  const next = chevronButton(CHEVRON_RIGHT, t.characterRotateNext);
  prev.addEventListener("click", onPrev);
  next.addEventListener("click", onNext);
  row.append(lbl, prev, next);
  return { row, prev, next };
}

export function buildCharacterViewer(
  opts: CharacterViewerOptions,
): CharacterViewer {
  // ---- state ----
  let bodyDir = 0; // 0..7
  let headDirIdx = 0; // index into HEAD_DIRS
  let stateType = 1; // 1 = walk (initial animation, per requirements)
  // Sex is auto-detected from the replay (0 = female, 1 = male; default male).
  const sex: 0 | 1 = opts.sex === 0 ? 0 : 1;
  let gear: Gear = { headgear: [], garment: null, weapon: null, shield: null };
  let lastUrl = "";

  // ---- DOM ----
  const el = document.createElement("div");
  el.className = "character-viewer";

  const stage = document.createElement("div");
  stage.className = "character-stage";
  const sprite = document.createElement("img");
  sprite.className = "character-sprite";
  sprite.alt = "";
  sprite.decoding = "async";
  const errorEl = document.createElement("div");
  errorEl.className = "character-error";
  errorEl.textContent = t.characterViewerError;
  errorEl.hidden = true;
  stage.append(sprite, errorEl);

  const body = rotateRow(
    t.characterBodyLabel,
    () => { bodyDir = (bodyDir + 7) % 8; render(); },
    () => { bodyDir = (bodyDir + 1) % 8; render(); },
  );
  const head = rotateRow(
    t.characterHeadLabel,
    () => {
      headDirIdx = (headDirIdx + HEAD_DIRS.length - 1) % HEAD_DIRS.length;
      render();
    },
    () => {
      headDirIdx = (headDirIdx + 1) % HEAD_DIRS.length;
      render();
    },
  );

  // State dropdown
  const stateRow = document.createElement("div");
  stateRow.className = "character-control-row";
  const stateLabel = document.createElement("label");
  stateLabel.className = "character-control-label";
  stateLabel.textContent = t.characterStateLabel;
  const stateSelect = document.createElement("select");
  stateSelect.className = "character-state-select";
  for (const s of STATE_LIST) {
    const opt = document.createElement("option");
    opt.value = String(s.type);
    opt.textContent = s.label;
    stateSelect.appendChild(opt);
  }
  stateSelect.value = String(stateType);
  const stateId = "character-state-" + Math.random().toString(36).slice(2, 8);
  stateSelect.id = stateId;
  stateLabel.htmlFor = stateId;
  stateSelect.addEventListener("change", () => {
    stateType = Number(stateSelect.value);
    syncHeadControls();
    render();
  });
  stateRow.append(stateLabel, stateSelect);

  const controls = document.createElement("div");
  controls.className = "character-controls";
  controls.append(body.row, head.row, stateRow);

  el.append(stage, controls);

  // Enable the head arrows only for idle/sit; otherwise disable them and snap
  // the head back to straight so the URL never carries a stale headdir.
  function syncHeadControls() {
    const allowed = HEAD_ROTATE_STATES.has(stateType);
    head.prev.disabled = !allowed;
    head.next.disabled = !allowed;
    if (!allowed) headDirIdx = 0;
  }

  function buildUrl(): string {
    const p = new URLSearchParams();
    p.set("job", String(opts.jobView));
    p.set("gender", sex === 0 ? "female" : "male");
    p.set("head", String(DEFAULT_HEAD));
    if (gear.headgear.length) p.set("headgear", gear.headgear.join(","));
    if (gear.garment != null) p.set("garment", String(gear.garment));
    if (gear.weapon != null) p.set("weapon", String(gear.weapon));
    if (gear.shield != null) p.set("shield", String(gear.shield));
    // "Atacar" resolves to the attack animation the equipped weapon uses; every
    // other state is its own animation type. `action = type*8 + bodyDir`.
    const animType =
      stateType === ATTACK
        ? attackActionType(opts.jobView, gear.weapon, sex)
        : stateType;
    p.set("action", String(animType * 8 + bodyDir));
    p.set("headdir", String(HEAD_DIRS[headDirIdx]));
    p.set("canvas", CANVAS);
    return `${RAGASSETS_BASE}/image?${p.toString()}`;
  }

  // Preload off-screen, then swap the visible sprite once decoded — avoids a
  // blank flash between frames (and reuses ragassets' immutable cache).
  function render() {
    const url = buildUrl();
    if (url === lastUrl) return;
    lastUrl = url;
    const pre = new Image();
    pre.onload = () => {
      if (lastUrl !== url) return; // a newer render superseded this one
      sprite.src = url;
      sprite.classList.add("is-loaded");
      errorEl.hidden = true;
    };
    pre.onerror = () => {
      if (lastUrl !== url) return;
      errorEl.hidden = false;
    };
    pre.src = url;
  }

  function update(rows: ReadonlyArray<EquippedSlot>): void {
    const byOrder = new Map<number, number>();
    for (const r of rows) if (r.itemId) byOrder.set(r.slotOrder, r.itemId);
    const viewOf = (order: number): number | null => {
      const id = byOrder.get(order);
      return id ? opts.resolveItemView(id) : null;
    };
    // Costume piece wins over the normal piece for each visual slot.
    const pick = (costume: number, normal: number) =>
      viewOf(costume) ?? viewOf(normal);

    // A headgear occupying several head slots resolves to the same accessory
    // view in each — dedupe so it isn't sent (and drawn) more than once.
    const headgear = [
      ...new Set(
        [
          pick(SLOT.costumeHeadTop, SLOT.headTop),
          pick(SLOT.costumeHeadMid, SLOT.headMid),
          pick(SLOT.costumeHeadLow, SLOT.headLow),
        ].filter((v): v is number => v != null),
      ),
    ];

    const weaponId = byOrder.get(SLOT.weapon);
    const shieldId = byOrder.get(SLOT.shield);
    gear = {
      headgear: headgear.slice(0, 3),
      garment: pick(SLOT.costumeGarment, SLOT.garment),
      weapon: viewOf(SLOT.weapon),
      // A two-handed weapon fills the shield slot with the SAME item — don't
      // render it twice.
      shield: shieldId && shieldId !== weaponId ? viewOf(SLOT.shield) : null,
    };
    render();
  }

  syncHeadControls(); // initial state is walk → head arrows start disabled
  render(); // initial base-character frame before any gear is supplied
  return { el, update };
}
