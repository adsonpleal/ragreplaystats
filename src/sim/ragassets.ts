// ragassets gateway: URL builders for the sprite billboards and the map asset
// server. The map sim fetches map binaries (gat/gnd/rsw/rsm + textures) from
// the maps/ tree and renders character/mob sprites by hitting /image with the
// build params (job, gender, head, gear, action, etc.). This module is the
// single place those URLs are constructed.

import { SPRITE_CANVAS } from "./sprite";

export const RAGASSETS_BASE = "https://assets.latam-tools.com.br";

/** Map asset root. Each map dir holds manifest.json plus the binary/textures
 *  the scene builder reads. Override via VITE_MAPS_URL for local testing. */
export const MAPS_ROOT =
  (import.meta as unknown as { env?: { VITE_MAPS_URL?: string } }).env?.VITE_MAPS_URL ??
  "https://assets.latam-tools.com.br/maps/";

/** Player build snapshot the URL builder needs. `null` for a palette means
 *  "use the sprite's own palette" (omit the param). View ids are sprite ids
 *  (the client's ClassNum), NOT item ids. */
export type PlayerLook = {
  jobView: number;
  sex: 0 | 1;
  hairStyle: number;
  hairColor: number; // palette index; 0 = default
  clothesColor: number;
  headgear: number[];
  garment: number | null;
  weapon: number | null;
  shield: number | null;
  /** Mado Gear body, when the player is riding one: 0 = robot, 2 = suit; null =
   *  not on a Mado Gear. The gateway's `madogearType` composites the mech body.
   *  (Peco mounts come through `jobView`; dragon/warg have no gateway param.) */
  madogear?: 0 | 2 | null;
};

// Gender-locked classes (Bard/Dancer line + Kagerou/Oboro). The replay's sex
// byte is frequently missing for the local player, which would default these to
// male and render a wrong/broken sprite — so the job id decides instead (e.g.
// 4076 Musa/Wanderer is female-only).
const GENDER_LOCKED_FEMALE = new Set([20, 4021, 4043, 4069, 4076, 4105, 4212]);
const GENDER_LOCKED_MALE = new Set([19, 4020, 4042, 4068, 4075, 4104, 4211]);

/** Sprite sex (0 = female, 1 = male) for a job view id: gender-locked classes
 *  are forced regardless of the reported byte; everyone else honours it and
 *  defaults to male when absent. Shared by the paper-doll viewer and the map
 *  viewer's billboard so they never disagree on the same character. */
export function resolveSex(jobView: number, reported?: number): 0 | 1 {
  if (GENDER_LOCKED_FEMALE.has(jobView)) return 0;
  if (GENDER_LOCKED_MALE.has(jobView)) return 1;
  return reported === 0 ? 0 : 1;
}

/** Build the /image URL for one specific frame of a player sprite. Used by the
 *  billboard to cycle frames manually (a hidden/covered APNG is paused by the
 *  browser). */
export function playerFrameUrl(
  look: PlayerLook,
  action: number,
  dir: number,
  frame: number,
  headdir = 0,
  canvas: string = SPRITE_CANVAS,
): string {
  const p = playerParams(look);
  p.set("action", String(action * 8 + dir));
  p.set("frame", String(frame));
  p.set("headdir", String(headdir));
  p.set("canvas", canvas);
  return `${RAGASSETS_BASE}/image?${p.toString()}`;
}

/** Minimal animated render whose only purpose is to read the composited frame
 *  count (the APNG acTL) for a pose. Pinned south with a 2px canvas so the
 *  URL stays stable across direction. */
export function playerFrameProbeUrl(look: PlayerLook, action: number): string {
  const p = playerParams(look);
  p.set("action", String(action * 8));
  p.set("headdir", "0");
  p.set("canvas", "2x2+1+1");
  return `${RAGASSETS_BASE}/image?${p.toString()}`;
}

function playerParams(look: PlayerLook): URLSearchParams {
  const p = new URLSearchParams();
  p.set("job", String(look.jobView));
  p.set("gender", look.sex === 0 ? "female" : "male");
  p.set("head", String(look.hairStyle || 1));
  if (look.hairColor) p.set("headPalette", String(look.hairColor));
  if (look.clothesColor) p.set("bodyPalette", String(look.clothesColor));
  if (look.headgear.length) p.set("headgear", look.headgear.join(","));
  if (look.garment != null) p.set("garment", String(look.garment));
  if (look.weapon != null) p.set("weapon", String(look.weapon));
  if (look.shield != null) p.set("shield", String(look.shield));
  if (look.madogear != null) p.set("madogearType", String(look.madogear));
  return p;
}

/** Status-effect (buff/debuff) icon, keyed by the client's EFST id — the same
 *  id the status-change packets carry. ragassets serves a 32×32 transparent PNG
 *  per icon'd EFST; ids without an icon 404 (the caller drops those, matching
 *  the RO client which only shows icon'd statuses). */
export function statusIconUrl(efstId: number): string {
  return `${RAGASSETS_BASE}/icons/status/${efstId}.png`;
}

// --- Skill/world effect gateway (STR renderer) ---------------------------
// The /effect/* endpoints serve roBrowser's effect data + textures so the client
// renders skill visuals itself (blend fidelity — see src/sim/render/strEffect.ts).
// All are immutable + CORS-enabled; fetch the tables once and cache (effectAssets).

/** roBrowser's SkillEffect table: skillId → { effectId?, hitEffectId?,
 *  groundEffectId? }. One fetch for the whole map. */
export function effectSkillMapUrl(): string {
  return `${RAGASSETS_BASE}/effect/skill-map`;
}

/** roBrowser's EffectTable: effectId → array of effect entries (STR/SPR/…). One
 *  fetch for the whole table. */
export function effectTableUrl(): string {
  return `${RAGASSETS_BASE}/effect/table`;
}

/** Parsed .str keyframe animation for one effect file (name relative to the
 *  GRF's data/, with the %d variant already substituted by the caller). */
export function effectStrUrl(file: string): string {
  return `${RAGASSETS_BASE}/effect/str?file=${encodeURIComponent(file)}`;
}

/** One .str layer texture as an RGBA PNG (colorkey already applied). `file` is
 *  the texture name relative to data/texture/effect/. */
export function effectTextureUrl(file: string): string {
  return `${RAGASSETS_BASE}/effect/texture?file=${encodeURIComponent(file)}`;
}

/** A played-sprite (.spr/.act) effect bundle: /effects/sprites/<key>/sprite.json =
 *  { frames: [{ img, delay, offset:[x,y] }] }. Pre-composited by extract-grf.mjs
 *  (buildSpriteEffect). `key` is the URL-safe slug the bundle is served under. */
export function effectSpriteUrl(key: string): string {
  return `${RAGASSETS_BASE}/effects/sprites/${encodeURIComponent(key)}/sprite.json`;
}

/** One composited frame PNG of a played-sprite effect bundle. */
export function effectSpriteFrameUrl(key: string, img: string): string {
  return `${RAGASSETS_BASE}/effects/sprites/${encodeURIComponent(key)}/${img}`;
}

/** Mob/monster billboard canvas. Sized like the latamvisuais pet canvas — the
 *  largest tameable monster extends ~189px up / 46px down / 114px sideways. */
export const MOB_SPRITE = { w: 248, h: 256, anchorX: 124, anchorY: 200 } as const;
const MOB_CANVAS = `${MOB_SPRITE.w}x${MOB_SPRITE.h}+${MOB_SPRITE.anchorX}+${MOB_SPRITE.anchorY}`;

/** One frame of a mob sprite (job=<mobId>, no gender/gear). `shadow=false` drops
 *  the baked ground shadow — used for the flying falcon, which shouldn't cast a
 *  shadow floating in the air with it. */
export function mobFrameUrl(
  mob: number,
  action: number,
  dir: number,
  frame: number,
  shadow = true,
): string {
  const p = new URLSearchParams();
  p.set("job", String(mob));
  p.set("action", String(action * 8 + dir));
  p.set("frame", String(frame));
  p.set("headdir", "0");
  p.set("canvas", MOB_CANVAS);
  if (!shadow) p.set("enableShadow", "false");
  return `${RAGASSETS_BASE}/image?${p.toString()}`;
}

/** Frame-count probe for a mob pose (see playerFrameProbeUrl). */
export function mobFrameProbeUrl(mob: number, action: number): string {
  const p = new URLSearchParams();
  p.set("job", String(mob));
  p.set("action", String(action * 8));
  p.set("headdir", "0");
  p.set("canvas", "2x2+1+1");
  return `${RAGASSETS_BASE}/image?${p.toString()}`;
}
