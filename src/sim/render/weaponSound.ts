// Auto-attack swing sound, resolved from the attacker's weapon sprite-view id
// (roBrowser's `ClassNum` — the same id space `resolveItemView`/`PlayerLook.weapon`
// already produces elsewhere in this codebase, e.g. Entities.ts's attackActionType).
// Ported from roBrowserLegacy's DB/Items/WeaponType.js + WeaponTypeExpansion.js +
// WeaponSoundTable.js (github.com/MrAntares/roBrowserLegacy) — the client's own
// weapon→sound tables, not a guess. All referenced .wav names were verified served
// by the gateway (bare root names, e.g. GET /effect/sound?file=attack_sword).
//
// Two-step resolve, mirroring the client:
//   1. A weapon item's view id is either already a "base type" (0-30: the 24
//      generic categories + 6 dual-wield combos) or an "extended" id (31-102: a
//      named unique-weapon reskin, e.g. Katana/Saber/Kaiser Knuckle) that must
//      collapse to its base type first (WEAPON_TYPE_EXPANSION).
//   2. The base type indexes WEAPON_SWING_SOUNDS — a weapon with more than one
//      candidate (short sword, bow) picks one at random per swing, same as the
//      client and matching this codebase's existing %d-variant precedent.
// A base type with no extracted sound (guns — their real sound names are
// Korean/unreadable in the source table and not yet in the extracted set)
// resolves to [] → no sound, never a wrong stand-in.

// Base WeaponType values 0-24 (roBrowser's WeaponType.js) + 25-30 (dual-wield
// combos). Keys double as comments via the WeaponType name.
const WEAPON_SWING_SOUNDS: Record<number, string[]> = {
  0: ["attack_fist"], // NONE (bare hands)
  1: ["attack_short_sword", "attack_short_sword_"], // SHORTSWORD (dagger)
  2: ["attack_sword"], // SWORD
  3: ["attack_twohand_sword"], // TWOHANDSWORD
  4: ["attack_spear"], // SPEAR
  5: ["attack_spear"], // TWOHANDSPEAR
  6: ["attack_axe"], // AXE
  7: ["attack_axe"], // TWOHANDAXE
  8: ["attack_mace"], // MACE
  9: ["attack_mace"], // TWOHANDMACE
  10: ["attack_rod"], // ROD
  11: ["attack_bow1", "attack_bow2"], // BOW
  12: ["attack_fist"], // KNUKLE
  13: ["attack_mace"], // INSTRUMENT
  14: ["attack_whip"], // WHIP
  15: ["attack_book"], // BOOK
  16: ["attack_katar"], // KATAR
  // 17-21: GUN_HANDGUN/RIFLE/GATLING/SHOTGUN/GRANADE — no extracted sound.
  22: ["attack_sword"], // SYURIKEN
  23: ["attack_rod"], // TWOHANDROD
  24: ["attack_fist"], // LAST
  25: ["attack_mace"], // SHORTSWORD_SHORTSWORD (dual-wield)
  26: ["attack_mace"], // SWORD_SWORD
  27: ["attack_mace"], // AXE_AXE
  28: ["attack_mace"], // SHORTSWORD_SWORD
  29: ["attack_mace"], // SHORTSWORD_AXE
  30: ["attack_mace"], // SWORD_AXE
};

// Extended (named-unique-weapon) view ids 31-102 → their base WeaponType, ported
// verbatim from WeaponTypeExpansion.js. Every named RO weapon reskin (Katana,
// Saber, Kaiser Knuckle, ...) resolves through here before hitting the table
// above, so an item with an extended view id still gets the right swing sound.
const WEAPON_TYPE_EXPANSION: Record<number, number> = {
  31: 1, 32: 1, 33: 1, 34: 1, 35: 1, 36: 1, 37: 1, 38: 1, // Main_Gauche..Lacma → SHORTSWORD
  39: 2, 40: 2, 41: 2, 42: 2, 43: 2, 44: 2, 45: 2, 46: 2, 47: 2, // Tsurugi..Priest_Sword → SWORD
  48: 3, 49: 3, 50: 3, 51: 3, // Katana..Violet_Fear → TWOHANDSWORD
  52: 4, 53: 4, 54: 4, 55: 4, 56: 4, 57: 4, // Lance..Zephyrus → SPEAR
  58: 6, 59: 6, 60: 6, 61: 6, // Hammer..Right_Epsilon → AXE
  62: 8, 63: 8, 64: 8, 65: 8, 66: 8, 67: 8, 68: 8, // Mace..Spanner → MACE
  69: 10, 70: 10, 71: 10, 72: 10, // Arc_Wand..Bone_Wand → ROD
  73: 11, 74: 11, 75: 11, 76: 11, 77: 11, // CrossBow..Bow_Of_Rudra → BOW
  78: 12, 79: 12, 80: 12, 81: 12, 82: 12, 83: 12, 84: 12, 85: 12, // Waghnakh..Berserk → KNUKLE
  86: 14, 87: 14, 88: 14, // Rante..Whip → WHIP
  89: 15, 90: 15, 91: 15, 92: 15, 93: 15, 94: 15, 95: 15, // Bible..Girls_Diary → BOOK
  96: 23, 97: 23, // Staff_Of_Soul, Wizardy_Staff → TWOHANDROD
  98: 8, // Spoon → MACE
  99: 10, 100: 10, 101: 10, 102: 10, // FOXTAIL_*, CandyCaneRod → ROD
};

/** Resolve a weapon's base WeaponType (0-30) from its sprite-view id, collapsing
 *  an extended named-weapon id through WEAPON_TYPE_EXPANSION. `null`/`0`/unarmed
 *  resolves to NONE (fist). An id this table has never seen (shouldn't happen —
 *  the expansion table is complete through 102) passes through unchanged, which
 *  simply misses WEAPON_SWING_SOUNDS below → silence, not a wrong sound. */
function baseWeaponType(weaponView: number | null): number {
  if (!weaponView) return 0;
  return WEAPON_TYPE_EXPANSION[weaponView] ?? weaponView;
}

/** The ONE swing sound to play for an auto-attack with this weapon (random pick
 *  among the weapon's candidates — a bow alternates two variants, matching the
 *  client). `null` when the weapon view resolves to a type with no extracted
 *  sound (guns) — silence, never a wrong stand-in. */
export function weaponSwingSound(weaponView: number | null): string | null {
  const candidates = WEAPON_SWING_SOUNDS[baseWeaponType(weaponView)];
  if (!candidates?.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}
