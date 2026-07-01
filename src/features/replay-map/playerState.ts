// Derive the player look (job, sex, hair, gear views) for the map viewer from
// the replay's session info + equipment timeline. Mirrors the resolution logic
// CharacterViewer.tsx uses for the paper-doll viewer, so the in-world billboard
// and the static viewer pick the same costume pieces for the same moment.
//
// The replay's equipChanges are time-stamped, so the URL builder reflects the
// gear the player actually had on at a given playback time `t`. (v1 only uses
// the recording-start look — see `lookAtStart`. Live re-equip during playback
// can be layered on by walking equipChanges with a cursor in the viewer.)

import type { ReferenceDb } from "../../db/loader";
import { EQUIP_SLOTS } from "../explorer/equipmentPages";
import type { Entity, Replay } from "../../rrf/types";
import type { PlayerLook } from "../../sim/ragassets";

// Slot ORDER indices (into EQUIP_SLOTS) for the visual pieces — matches
// CharacterViewer.tsx's SLOT constant.
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

// Gender-locked classes (Bard/Dancer line + Kagerou/Oboro) — the recording's
// sex byte is sometimes missing; the job decides instead.
const GENDER_LOCKED_FEMALE = new Set([20, 4021, 4043, 4069, 4076, 4105, 4212]);
const GENDER_LOCKED_MALE = new Set([19, 4020, 4042, 4068, 4075, 4104, 4211]);

// OPTION bit for riding a Mado Gear (Mechanic) in the spawn packet's effectState.
const OPTION_MADOGEAR = 0x20000000;

function resolveSex(jobView: number, reported?: number): 0 | 1 {
  if (GENDER_LOCKED_FEMALE.has(jobView)) return 0;
  if (GENDER_LOCKED_MALE.has(jobView)) return 1;
  return reported === 0 ? 0 : 1;
}

/** Walk the initial inventory (and the player entity's recorded look) into a
 *  PlayerLook the ragassets URL builders consume. v1 freezes the look at
 *  recording start; the engine cache is keyed by these fields so re-equipping
 *  later can be hooked in without rewriting the billboard. */
export function lookAtStart(replay: Replay, player: Entity, db: ReferenceDb | null): PlayerLook {
  const jobView = player.view || 0;
  const sex = resolveSex(jobView, player.sex);

  // Bitmask → slot-order, mirroring buildEquipmentPages: the worn item with the
  // matching bit wins. Costume pieces override their normal counterpart per
  // visual slot.
  const byOrder = new Map<number, number>();
  for (const inv of replay.initialInventory.values()) {
    if (!inv.equipped || !inv.itemId) continue;
    for (let i = 0; i < EQUIP_SLOTS.length; i++) {
      const [bit] = EQUIP_SLOTS[i];
      if (inv.equipped & bit) byOrder.set(i, inv.itemId);
    }
  }

  const viewOf = (order: number): number | null => {
    const id = byOrder.get(order);
    if (!id) return null;
    return db?.resolveItemView(id) ?? null;
  };
  const pick = (costume: number, normal: number) => viewOf(costume) ?? viewOf(normal);

  const headgear = [
    pick(SLOT.costumeHeadTop, SLOT.headTop),
    pick(SLOT.costumeHeadMid, SLOT.headMid),
    pick(SLOT.costumeHeadLow, SLOT.headLow),
  ].filter((v): v is number => v != null);
  // Dedupe multi-slot pieces — they'd otherwise stack on the same head twice.
  const headgearUnique: number[] = [];
  for (const v of headgear) if (!headgearUnique.includes(v)) headgearUnique.push(v);

  const weaponId = byOrder.get(SLOT.weapon);
  const shieldId = byOrder.get(SLOT.shield);
  // Two-handed weapons fill the shield slot with the same item id — don't draw twice.
  const shield = shieldId && shieldId !== weaponId ? viewOf(SLOT.shield) : null;

  return {
    jobView,
    sex,
    hairStyle: player.hairStyle ?? 0,
    hairColor: player.hairColor ?? 0,
    clothesColor: player.clothesColor ?? 0,
    headgear: headgearUnique.slice(0, 3),
    garment: pick(SLOT.costumeGarment, SLOT.garment),
    weapon: viewOf(SLOT.weapon),
    shield,
  };
}

/**
 * Build the look for a REMOTE player from the appearance the spawn packet
 * carried (see Entity.weaponView etc.). The fields are a MIX of id spaces, a
 * known RO spawn-packet quirk verified against the gateway:
 *   - weapon / shield  → item ids (nameid); resolve to a sprite view like the
 *     local player's inventory gear does.
 *   - headgear / robe  → already accessory / robe VIEW ids; feed verbatim.
 * Falls back to sensible defaults (0/none) for anything the spawn omitted.
 */
export function lookFromEntity(entity: Entity, db: ReferenceDb | null): PlayerLook {
  const jobView = entity.view || 0;
  const sex = resolveSex(jobView, entity.sex);
  // Headgear slots (top/mid/low) → deduped list of the non-empty accessory
  // views, matching the paper-doll's top-first order.
  const headgear: number[] = [];
  for (const v of [entity.headTopView, entity.headMidView, entity.headLowView]) {
    if (v && !headgear.includes(v)) headgear.push(v);
  }
  const weaponItem = entity.weaponView || 0;
  const shieldItem = entity.shieldView || 0;
  const weapon = weaponItem ? (db?.resolveItemView(weaponItem) ?? null) : null;
  // A two-handed weapon reports the same item in the shield slot — don't draw twice.
  const shield =
    shieldItem && shieldItem !== weaponItem ? (db?.resolveItemView(shieldItem) ?? null) : null;
  return {
    jobView,
    sex,
    hairStyle: entity.hairStyle ?? 0,
    hairColor: entity.hairColor ?? 0,
    clothesColor: entity.clothesColor ?? 0,
    headgear: headgear.slice(0, 3),
    garment: entity.robeView || null,
    weapon,
    shield,
    // Mado Gear is the only mount the gateway can composite (madogearType).
    // Peco riders arrive as a mounted job id in `jobView` (renders as-is);
    // dragon/warg have no gateway param, so they fall back to the base sprite.
    madogear: (entity.option ?? 0) & OPTION_MADOGEAR ? 0 : null,
  };
}
