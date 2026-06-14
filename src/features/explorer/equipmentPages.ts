import type { ReferenceDb } from "../../db/loader";
import { t } from "../../i18n";
import type { Replay } from "../../rrf/types";
import { resolveItemName } from "./resolvers";

/**
 * Bit → label mapping for the `equipped` (equipLocation) bitmask, following
 * rAthena's `e_equip_pos`. Array index doubles as the slot order (grid layout +
 * Equip/Especial grouping). An item occupies EVERY slot whose bit is set, so a
 * two-handed weapon (HAND_R | HAND_L) fills both weapon and shield slots.
 *
 * NOTE: index order is mirrored by `SLOT` in ui/CharacterViewer.tsx — keep them
 * in sync.
 */
export const EQUIP_SLOTS: Array<readonly [bit: number, label: () => string]> = [
  [256, () => t.slotHeadTop],
  [512, () => t.slotHeadMid],
  [1, () => t.slotHeadLow],
  [16, () => t.slotArmor],
  [2, () => t.slotWeapon],
  [32, () => t.slotShield],
  [4, () => t.slotGarment],
  [64, () => t.slotShoes],
  [8, () => t.slotAccLeft],
  [128, () => t.slotAccRight],
  [32768, () => t.slotAmmo],
  [1024, () => t.slotCostumeHeadTop],
  [2048, () => t.slotCostumeHeadMid],
  [4096, () => t.slotCostumeHeadLow],
  [8192, () => t.slotCostumeGarment],
  [65536, () => t.slotShadowArmor],
  [131072, () => t.slotShadowWeapon],
  [262144, () => t.slotShadowShield],
  [524288, () => t.slotShadowShoes],
  [1048576, () => t.slotShadowAccRight],
  [2097152, () => t.slotShadowAccLeft],
];

export const NORMAL_SLOT_ORDERS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export const ESPECIAL_SLOT_ORDERS = [11, 12, 13, 15, 16, 17, 14, 18, 20, 19] as const;

export type EquippedRow = {
  slotOrder: number;
  slotLabel: string;
  itemId: number;
  itemName: string;
  refine: number;
  cards: number[];
};

export type EquipPage = {
  /** ms into the session this set became active (0 = recording start). */
  timeMs: number;
  rows: EquippedRow[];
  /** slotOrder values whose item changed to reach this page (for highlight). */
  changedSlots: Set<number>;
};

// Near-simultaneous equip events collapse into one page so a single outfit
// change reads as one step.
const EQUIP_PAGE_GROUP_MS = 250;

/** All display slots an equipLocation mask occupies, in slot order. */
export function occupiedEquipSlots(mask: number): Array<{ order: number; label: string }> {
  const out: Array<{ order: number; label: string }> = [];
  for (let i = 0; i < EQUIP_SLOTS.length; i++) {
    const [bit, label] = EQUIP_SLOTS[i];
    if (mask & bit) out.push({ order: i, label: label() });
  }
  if (!out.length) out.push({ order: EQUIP_SLOTS.length, label: t.slotOther });
  return out;
}

/**
 * Walk `replay.equipChanges` to produce the equipment timeline: page 0 is the
 * set worn at recording start, then one page per (grouped) change showing the
 * full worn set at that moment.
 */
export function buildEquipmentPages(replay: Replay, db: ReferenceDb | null): EquipPage[] {
  const rowFor = (
    order: number,
    label: string,
    itemId: number,
    refine: number,
    cards: number[],
  ): EquippedRow => ({
    slotOrder: order,
    slotLabel: label,
    itemId,
    itemName: resolveItemName(db, itemId),
    refine,
    cards: cards.filter((c) => c > 0),
  });

  const worn = new Map<number, EquippedRow>();
  const wear = (mask: number, itemId: number, refine: number, cards: number[]): number[] => {
    const slots = occupiedEquipSlots(mask);
    for (const { order, label } of slots) worn.set(order, rowFor(order, label, itemId, refine, cards));
    return slots.map((s) => s.order);
  };
  const takeOff = (mask: number): number[] => {
    const orders = occupiedEquipSlots(mask).map((s) => s.order);
    for (const order of orders) worn.delete(order);
    return orders;
  };

  for (const inv of replay.initialInventory.values()) {
    if (!inv.equipped || !inv.itemId) continue;
    wear(inv.equipped, inv.itemId, inv.refine, inv.cards);
  }
  const snapshot = () => [...worn.values()].sort((a, b) => a.slotOrder - b.slotOrder);

  const pages: EquipPage[] = [{ timeMs: 0, rows: snapshot(), changedSlots: new Set() }];

  const changes = [...replay.equipChanges].sort((a, b) => a.time - b.time);
  let i = 0;
  while (i < changes.length) {
    const start = changes[i].time;
    const changedSlots = new Set<number>();
    let last = start;
    while (i < changes.length && changes[i].time - last <= EQUIP_PAGE_GROUP_MS) {
      const c = changes[i];
      const orders = c.equipped ? wear(c.location, c.itemId, c.refine, c.cards) : takeOff(c.location);
      for (const order of orders) changedSlots.add(order);
      last = c.time;
      i++;
    }
    pages.push({ timeMs: start, rows: snapshot(), changedSlots });
  }
  return pages;
}
