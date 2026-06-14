import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import { CHEVRON_LEFT, CHEVRON_RIGHT, ChevronButton } from "./ChevronButton";
import { attackActionType } from "./weapon-action";

// ragassets/zrenderer gateway. zrenderer encodes body direction AND animation
// type into one number: action = animationType * 8 + bodyDirection (0=S…7=SE).
// Gear params take sprite "view" ids (the client's ClassNum), NOT item ids.
const RAGASSETS_BASE = "https://ragassets.duckdns.org";
const DEFAULT_HEAD = 1; // hairstyle id
// Fixed render canvas so the sprite's ground point always lands on the same
// pixel (feet stay aligned across pose/direction changes). URLSearchParams
// encodes the "+" separators as %2B, which the gateway expects.
const CANVAS = "200x169+100+124";

// Slot orders (indices into EQUIP_SLOTS) for visually-rendered pieces.
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

// Gender-locked classes (Bard/Dancer line + Kagerou/Oboro). The replay's sex
// byte is frequently missing for the local player, which would default these
// to male and render a wrong/broken sprite — so the job id decides instead.
// (e.g. 4076 Musa/Wanderer is female-only.)
const GENDER_LOCKED_FEMALE = new Set([20, 4021, 4043, 4069, 4076, 4105, 4212]);
const GENDER_LOCKED_MALE = new Set([19, 4020, 4042, 4068, 4075, 4104, 4211]);

function resolveSex(jobView: number, reported?: number): 0 | 1 {
  if (GENDER_LOCKED_FEMALE.has(jobView)) return 0;
  if (GENDER_LOCKED_MALE.has(jobView)) return 1;
  // Otherwise honour the replay's sex byte; default male when absent.
  return reported === 0 ? 0 : 1;
}

// We cycle head straight → right → left. The public gateway currently renders
// headdir as a no-op, but we still send the documented param.
const HEAD_DIRS = [0, 1, 2] as const;
// Head rotation only makes sense for idle (0) and sit (2); elsewhere the head
// follows the body, so the arrows disable and the head is forced straight.
const HEAD_ROTATE_STATES = new Set([0, 2]);
// Sentinel: the real attack animation type comes from the equipped weapon.
const ATTACK = -1;

const STATE_LIST: ReadonlyArray<{ type: number; label: string }> = [
  { type: 0, label: t.characterStates.idle },
  { type: 1, label: t.characterStates.walk },
  { type: 2, label: t.characterStates.sit },
  { type: 3, label: t.characterStates.pickup },
  { type: 4, label: t.characterStates.standby },
  { type: ATTACK, label: t.characterStates.attack },
  { type: 12, label: t.characterStates.casting },
  { type: 6, label: t.characterStates.hurt },
  { type: 7, label: t.characterStates.frozen },
  { type: 8, label: t.characterStates.dead },
  { type: 9, label: t.characterStates.frozen2 },
];

export type EquippedSlot = { slotOrder: number; itemId: number };

type Gear = { headgear: number[]; garment: number | null; weapon: number | null; shield: number | null };

function deriveGear(
  rows: ReadonlyArray<EquippedSlot>,
  resolveItemView: (id: number) => number | null,
): Gear {
  const byOrder = new Map<number, number>();
  for (const r of rows) if (r.itemId) byOrder.set(r.slotOrder, r.itemId);
  const viewOf = (order: number): number | null => {
    const id = byOrder.get(order);
    return id ? resolveItemView(id) : null;
  };
  // Costume piece wins over the normal piece for each visual slot.
  const pick = (costume: number, normal: number) => viewOf(costume) ?? viewOf(normal);
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
  return {
    headgear: headgear.slice(0, 3),
    garment: pick(SLOT.costumeGarment, SLOT.garment),
    weapon: viewOf(SLOT.weapon),
    // A two-handed weapon fills the shield slot with the SAME item — don't draw twice.
    shield: shieldId && shieldId !== weaponId ? viewOf(SLOT.shield) : null,
  };
}

function buildUrl(
  jobView: number,
  sex: 0 | 1,
  gear: Gear,
  stateType: number,
  bodyDir: number,
  headDir: number,
): string {
  const p = new URLSearchParams();
  p.set("job", String(jobView));
  p.set("gender", sex === 0 ? "female" : "male");
  p.set("head", String(DEFAULT_HEAD));
  if (gear.headgear.length) p.set("headgear", gear.headgear.join(","));
  if (gear.garment != null) p.set("garment", String(gear.garment));
  if (gear.weapon != null) p.set("weapon", String(gear.weapon));
  if (gear.shield != null) p.set("shield", String(gear.shield));
  const animType = stateType === ATTACK ? attackActionType(jobView, gear.weapon, sex) : stateType;
  p.set("action", String(animType * 8 + bodyDir));
  p.set("headdir", String(headDir));
  p.set("canvas", CANVAS);
  return `${RAGASSETS_BASE}/image?${p.toString()}`;
}

/**
 * Renders the local player's sprite (with equipped gear) via the ragassets
 * gateway. The animation comes back as APNG the browser plays natively, so no
 * animation library is needed. Body/head rotation + animation state are local
 * UI state; gear comes from the current equipment page (`rows`).
 */
export function CharacterViewer({
  jobView,
  sex: sexProp,
  resolveItemView,
  rows,
}: {
  jobView: number;
  sex?: number;
  resolveItemView: (id: number) => number | null;
  rows: ReadonlyArray<EquippedSlot>;
}) {
  const sex: 0 | 1 = resolveSex(jobView, sexProp);
  const [bodyDir, setBodyDir] = useState(0);
  const [headDirIdx, setHeadDirIdx] = useState(0);
  const [stateType, setStateType] = useState(1); // walk, per requirements
  const [src, setSrc] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  const gear = useMemo(() => deriveGear(rows, resolveItemView), [rows, resolveItemView]);
  const headAllowed = HEAD_ROTATE_STATES.has(stateType);
  const headDir = HEAD_DIRS[headAllowed ? headDirIdx : 0];
  const url = useMemo(
    () => buildUrl(jobView, sex, gear, stateType, bodyDir, headDir),
    [jobView, sex, gear, stateType, bodyDir, headDir],
  );

  // Preload off-screen, then swap once decoded — avoids a blank flash and reuses
  // ragassets' immutable cache.
  const lastUrlRef = useRef("");
  useEffect(() => {
    lastUrlRef.current = url;
    const pre = new Image();
    pre.onload = () => {
      if (lastUrlRef.current !== url) return;
      setSrc(url);
      setLoaded(true);
      setError(false);
    };
    pre.onerror = () => {
      if (lastUrlRef.current !== url) return;
      setError(true);
    };
    pre.src = url;
  }, [url]);

  return (
    <div className="character-viewer">
      <div className="character-stage">
        <img
          className={loaded ? "character-sprite is-loaded" : "character-sprite"}
          src={src || undefined}
          alt=""
          decoding="async"
        />
        <div className="character-error" hidden={!error}>
          {t.characterViewerError}
        </div>
      </div>
      <div className="character-controls">
        <div className="character-control-row">
          <span className="character-control-label">{t.characterBodyLabel}</span>
          <ChevronButton
            path={CHEVRON_LEFT}
            label={t.characterRotatePrev}
            onClick={() => setBodyDir((d) => (d + 7) % 8)}
          />
          <ChevronButton
            path={CHEVRON_RIGHT}
            label={t.characterRotateNext}
            onClick={() => setBodyDir((d) => (d + 1) % 8)}
          />
        </div>
        <div className="character-control-row">
          <span className="character-control-label">{t.characterHeadLabel}</span>
          <ChevronButton
            path={CHEVRON_LEFT}
            label={t.characterRotatePrev}
            disabled={!headAllowed}
            onClick={() => setHeadDirIdx((i) => (i + HEAD_DIRS.length - 1) % HEAD_DIRS.length)}
          />
          <ChevronButton
            path={CHEVRON_RIGHT}
            label={t.characterRotateNext}
            disabled={!headAllowed}
            onClick={() => setHeadDirIdx((i) => (i + 1) % HEAD_DIRS.length)}
          />
        </div>
        <div className="character-control-row">
          <label className="character-control-label" htmlFor="character-state">
            {t.characterStateLabel}
          </label>
          <select
            id="character-state"
            className="character-state-select"
            value={stateType}
            onChange={(e) => setStateType(Number(e.target.value))}
          >
            {STATE_LIST.map((s) => (
              <option key={s.type} value={s.type}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
