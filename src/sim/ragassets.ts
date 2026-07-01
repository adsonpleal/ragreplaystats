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

/** Build the /image URL for one specific frame of a player sprite. Used by the
 *  billboard to cycle frames manually (a hidden/covered APNG is paused by the
 *  browser). */
export function playerFrameUrl(
  look: PlayerLook,
  action: number,
  dir: number,
  frame: number,
  headdir = 0,
): string {
  const p = playerParams(look);
  p.set("action", String(action * 8 + dir));
  p.set("frame", String(frame));
  p.set("headdir", String(headdir));
  p.set("canvas", SPRITE_CANVAS);
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

/** Mob/monster billboard canvas. Sized like the latamvisuais pet canvas — the
 *  largest tameable monster extends ~189px up / 46px down / 114px sideways. */
export const MOB_SPRITE = { w: 248, h: 256, anchorX: 124, anchorY: 200 } as const;
const MOB_CANVAS = `${MOB_SPRITE.w}x${MOB_SPRITE.h}+${MOB_SPRITE.anchorX}+${MOB_SPRITE.anchorY}`;

/** One frame of a mob sprite (job=<mobId>, no gender/gear). */
export function mobFrameUrl(mob: number, action: number, dir: number, frame: number): string {
  const p = new URLSearchParams();
  p.set("job", String(mob));
  p.set("action", String(action * 8 + dir));
  p.set("frame", String(frame));
  p.set("headdir", "0");
  p.set("canvas", MOB_CANVAS);
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
