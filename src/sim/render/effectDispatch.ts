// WHICH effect a skill plays, WHERE and WHEN — the dispatch half of the effect
// pipeline, next to effectAssets.ts's "what does effect N look like" half.
//
// The ragassets gateway's roBrowser-derived skill-map answers three questions:
// a skill's main effect, its hit effect, its ground effect. The client asks six
// more — the cast aura, the caster's flash on a damaging hit, the per-hit pair
// on the target, an extra "struck" effect on either side, what a no-damage skill
// shows, and what a ground skill shows at its cell. public/db/effect-dispatch.json
// (built by tools/build-effect-dispatch.mjs from rustnarok-client's effects.txt)
// holds those six, and this module reads them.
//
// Measured against what our renderers can actually draw, these six give a visual
// to ~380 skills that previously drew nothing — with no new renderer and no new
// assets, since every effect id they name already resolves through the gateway.
//
// A SEVENTH KIND IS KEYED DIFFERENTLY. Everything above is keyed by skill id.
// The ground-unit rows — `unit`, `unitArea`, `unitModel` — are keyed by the
// unit's TYPE, rathena's UNT_ number, because that is what the client itself
// keys a ground unit's visual off. We read that number straight off 0x09ca
// (`GroundSkillUnit.unitType`), where before we only had the `skillId` beside
// it, which rrfparser CORRELATES from the caster's latest cast and reports as 0
// when it cannot attribute one. A type the table does not know is normal — real
// recordings carry 21292 — so `unitVisual` returns null and the caller falls
// back to the skill's own ground effect.
//
// ABSENT IS NOT NONE. The client's default caster/cast effect is 16 (Bash's
// burst); a table row of `-1` SUPPRESSES it, and arrives here as `null`. So
// `caster[skill] === null` means "this skill shows nothing", while a missing key
// means "fall through to the default 16". Collapsing the two would flash a burst
// on hundreds of skills that the client leaves bare, which is why every accessor
// below checks presence with `hasOwn` rather than truthiness.

import { dbUrl } from "../../db/manifest";

/** A side an effect plays on: caster, target, or the ground cell. */
export type Side = "c" | "t" | "g";

interface DispatchTable {
  /** Cast aura by the cast packet's element index; index 0 = neutral. */
  castAuras: number[];
  /** Every effect that is a SUSTAINED cast aura rather than a one-off flash. */
  castAuraEffects: number[];
  /** What a damaging skill shows on its caster when no row says otherwise. */
  defaultCaster: number;
  /** Inclusive skill-id ranges whose casts/casters show nothing at all. */
  noCasterEffect: [number, number][];
  /** skill → the two per-hit effects on the target (`null` = none). */
  hit: Record<string, [number | null, number | null]>;
  /** skill → [aura, ...effects that start alongside it]. */
  cast: Record<string, (number | null)[]>;
  /** skill → the caster's effect on a damage packet (`null` = none). */
  caster: Record<string, number | null>;
  /** skill → ordered [side, effect] pairs. */
  used: Record<string, [Side, number][]>;
  struck: Record<string, [Side, number][]>;
  ground: Record<string, [Side, number][]>;
  /** effect → its own run length in 16 ms client ticks. */
  length: Record<string, number>;
  /** unit TYPE → the effect it shows at its cell while it stands. */
  unit: Record<string, number>;
  /** The unit types whose effect is placed once rather than restarted. */
  unitOnce: number[];
  /** unit TYPE → the GRF model path it stands as. */
  unitModel: Record<string, string>;
  /** unit TYPE → [effect, lift] covering the unit's whole area. */
  unitArea: Record<string, [number, number]>;
}

/** What the client draws for a ground skill unit of a given type.
 *
 *  The parts are independent because the table's are: 92 types name an effect at
 *  the cell, 4 name one over the whole area (never both — they are disjoint in
 *  the data), 23 stand as a model, and exactly two of those also show an effect.
 *  So this is a record of optional parts, not a choice between them. */
export interface UnitVisual {
  /** The effect at the unit's cell, or null when the unit is a model only. */
  effectId: number | null;
  /** True when the effect is placed ONCE and left to stand. False means the
   *  client restarts it for as long as the unit is there — the difference
   *  between Sanctuary's square, laid down once, and a Fire Wall's flame, which
   *  burns for the wall's whole life. A one-shot STR on a looping unit would
   *  flash once under an effect that lasts seconds. */
  once: boolean;
  /** Set when the effect covers the unit's whole AREA rather than its one cell,
   *  lifted this many units off the ground. Sized by the unit's radius, which
   *  0x09ca carries. Null for a per-cell effect. */
  areaLift: number | null;
  /** The GRF model path (Korean, backslash-separated) the unit stands as, or
   *  null. Reading one needs a gateway route that can serve an arbitrary model,
   *  which does not exist yet — so a model-only type still draws nothing, and
   *  that is the correct nothing rather than a stand-in. */
  model: string | null;
}

/** One client tick. An effect's `length` is counted in these. */
const TICK_MS = 16;

let table: DispatchTable | null = null;
let tablePromise: Promise<void> | null = null;

/** Kick off (once) the dispatch-table fetch. Safe to call repeatedly. Until it
 *  lands every accessor behaves as if the table were empty — i.e. only the
 *  client's documented defaults apply — so a few early casts can miss their
 *  aura rather than throwing. */
export function preloadEffectDispatch(): Promise<void> {
  if (!tablePromise) {
    tablePromise = dbUrl("effect-dispatch.json")
      .then((url) => fetch(url))
      .then((res) => {
        if (!res.ok) throw new Error(`effect-dispatch HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => {
        table = json as DispatchTable;
      })
      .catch((err) => {
        console.warn("[effects] dispatch table load failed", err);
        // Cache the failure: an absent table degrades to "no extra effects",
        // which is exactly the behaviour before this file existed.
        table = null;
      });
  }
  return tablePromise;
}

const hasOwn = (o: Record<string, unknown>, k: number): boolean =>
  Object.prototype.hasOwnProperty.call(o, String(k));

/** Whether a skill is one of the newest jobs' whose cast and caster show nothing. */
function suppressed(skillId: number): boolean {
  if (!table) return true;
  return table.noCasterEffect.some(([lo, hi]) => skillId >= lo && skillId <= hi);
}

/** The aura that glows under a caster while this skill's cast bar fills, or null
 *  when it shows none. `element` is the cast packet's `property` field: a table
 *  entry of exactly 12 (EF_BEGINSPELL) means "the aura of this cast's element",
 *  so passing 0 (neutral) yields the plain white-blue bands — correct, just not
 *  element-tinted. Any other id is fixed regardless of element. */
export function castAura(skillId: number, element = 0): number | null {
  if (!table) return null;
  const rows = hasOwn(table.cast, skillId) ? table.cast[String(skillId)] : null;
  if (!rows) return suppressed(skillId) ? null : table.defaultCaster;
  const aura = rows[0];
  if (aura == null) return null;
  if (aura !== 12) return aura;
  return table.castAuras[element] ?? table.castAuras[0];
}

/** Whether an effect id is one of the SUSTAINED cast auras — the ones the client
 *  describes as "one a caster has at a time", glowing for as long as a cast bar
 *  fills, as opposed to a one-off flash. The full set is the table's
 *  `castAuraEffects`: EF_BEGINSPELL 12, the elemental 54-59, and the 30-odd
 *  per-school auras from Tetra Vortex's to Comet's.
 *
 *  This matters because the client's fallback cast effect for an unlisted skill
 *  is 16, Bash's burst: a single pop, not an aura. Looping that for a two-second
 *  cast would re-trigger the burst over and over. So the caller loops what this
 *  returns true for and plays everything else once. */
export function isSustainedCastAura(effectId: number): boolean {
  // `?? []`, not `table.castAuraEffects`: this runs inside the per-frame drain,
  // so a table served without the key — a stale cached build of the JSON, say —
  // would throw on every frame and take the whole map down with it. Treating it
  // as empty costs a looped aura, which is the same degradation as not having
  // loaded the table at all.
  return (table?.castAuraEffects ?? []).includes(effectId);
}

/** Effects a cast starts BESIDE its aura (the rows after the first). Empty for
 *  the overwhelming majority of skills. */
export function castAlongside(skillId: number): number[] {
  if (!table || !hasOwn(table.cast, skillId)) return [];
  return table.cast[String(skillId)].slice(1).filter((e): e is number => e != null);
}

/** What a damaging skill flashes on its CASTER as the damage packet lands, or
 *  null for none. Absent from the table → the client's default burst (16). */
export function casterEffect(skillId: number): number | null {
  if (!table) return null;
  if (hasOwn(table.caster, skillId)) return table.caster[String(skillId)];
  return suppressed(skillId) ? null : table.defaultCaster;
}

/** The per-hit effects a damaging skill puts on its TARGET, as the table's PAIR
 *  — `[first, second]`, either of which may be null for "none". The positions
 *  are kept rather than compacted because they are not interchangeable in the
 *  client: the first plays on every hit of the packet and the second only on
 *  the first hit. We spawn once per packet, so both are drawn together today;
 *  keeping the shape is what makes per-hit timing a change to the caller alone.
 *  407 of the 437 rows are a single effect (`[id, null]`).
 *
 *  Returns null when the table has no row for the skill, which the caller
 *  distinguishes from an empty row so it can fall back to the gateway's own
 *  `hitEffectId`. */
export function hitEffects(skillId: number): [number | null, number | null] | null {
  if (!table || !hasOwn(table.hit, skillId)) return null;
  return table.hit[String(skillId)];
}

/** Effects for one dispatch kind, split by the side they play on.
 *  - `used`: a no-damage skill (ZC_USE_SKILL) — caster and/or target
 *  - `struck`: extra effects as a damage packet lands — caster and/or target
 *  - `ground`: a ground skill — at the cell (`ground`) and/or on its caster */
export function sideEffects(
  kind: "used" | "struck" | "ground",
  skillId: number,
): { caster: number[]; target: number[]; ground: number[] } {
  const out = { caster: [] as number[], target: [] as number[], ground: [] as number[] };
  if (!table || !hasOwn(table[kind], skillId)) return out;
  for (const [side, id] of table[kind][String(skillId)]) {
    if (side === "c") out.caster.push(id);
    else if (side === "g") out.ground.push(id);
    else out.target.push(id);
  }
  return out;
}

/** What to draw for a ground skill unit of this type, or null when the client's
 *  table says nothing about it — an unknown type (21292 appears in real
 *  recordings), or UNT_DUMMYSKILL (134), the type every skill with no ground
 *  graphic of its own lands on. A null is the caller's cue to fall back to the
 *  skill's own ground effect, which is all we had before this table.
 *
 *  Type 0 is deliberately never a hit: rrfparser decodes a truncated 0x09ca
 *  with `unitType` 0 rather than dropping the record, because the unit→caster
 *  link still matters for attributing AoE damage. The table has no row for 0
 *  (asserted in the build tool's tests), so such a record falls through here. */
export function unitVisual(unitType: number): UnitVisual | null {
  if (!table) return null;
  const cell = hasOwn(table.unit, unitType) ? table.unit[String(unitType)] : null;
  const area = hasOwn(table.unitArea, unitType) ? table.unitArea[String(unitType)] : null;
  const model = hasOwn(table.unitModel, unitType) ? table.unitModel[String(unitType)] : null;
  if (cell == null && area == null && model == null) return null;
  return {
    effectId: cell ?? area?.[0] ?? null,
    // `?? []` for the same reason as isSustainedCastAura: a stale cached build
    // of the JSON without the key must not throw inside the per-frame drain.
    once: cell != null && (table.unitOnce ?? []).includes(unitType),
    areaLift: area ? area[1] : null,
    model,
  };
}

/** An effect's own run length in ms — the client's authority on how long it
 *  lasts, independent of its STR's keyframe count. Null when the table says
 *  nothing.
 *
 *  Callers pass this to EffectsLayer as a cull cap, which makes it a one-way
 *  clamp: a declared length SHORTER than the animation cuts it off, and one
 *  LONGER never fires because the STR has already ended itself. That asymmetry
 *  is deliberate — the client fills a longer length by holding the last frame or
 *  restarting, and neither of our renderers does that yet, so honouring it
 *  would only keep an invisible effect alive. */
export function effectLengthMs(effectId: number): number | null {
  if (!table || !hasOwn(table.length, effectId)) return null;
  return table.length[String(effectId)] * TICK_MS;
}
