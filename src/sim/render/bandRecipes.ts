// The CAST AURAS, as bands of ribbon round a caster's feet — the client's own
// recipe rather than roBrowser's.
//
// roBrowser has no DRAWABLE row for the 3rd/4th-class casting auras: they are
// built in client code, so the gateway's EffectTable has no entry for 23 of the
// 25 below, a sound-only row for Aura Blade (367) and a `FUNC` row we do not
// render for Tetra Vortex's (805). Either way nothing was drawn. The rule in
// effectAssets.ts is "nothing in the table resolved to a renderer", not "the
// table has no row" — so the day the gateway starts serving a supported type
// for 367 or 805, its band aura stops and the gateway's row takes over.
//
// The client builds each from the same primitive — a BAND: an arc of 20
// quads standing round the feet, its foot `radius` out on the ground, leaning
// `lean` degrees back from vertical, `height` tall at its tallest, at an alpha of
// 0-255. Four of them (sometimes two sets of four) with the right radius/lean/
// alpha curve over time are the whole effect.
//
// This module is that math and nothing else: no three.js, no textures, no clock.
// bandedEffect.ts renders what `bandsAt` returns. Ported from rustnarok-client's
// `src/fx/effects.rs` (MIT OR Apache-2.0) — which reads the client's own
// behaviour — keeping its names so the two can be diffed.
//
// UNITS. Radii and heights are the client's own units, 7 screen pixels each
// (upstream's PIXELS_PER_UNIT). The renderer converts; nothing here knows about
// world space.
//
// SCOPE. Only the effects the gateway cannot already draw are listed in
// BAND_EFFECTS, and only those recipes are ported. The client also builds Heal's
// walls (312/313/325), Safety Wall (315), the undead heal (320), the teleport
// (304), the logout (314) and the arrival (344) out of bands — but the gateway
// serves CYLINDER/3D rows for every one of those, so they already render and
// replacing them is a judgement call, not a gap. Their recipes are deliberately
// left out rather than ported and shadowed.

/** One band: an arc (degrees, 360 = closed) from `turn`, its foot `radius` out on
 *  the ground, leaning `lean` degrees up from the ground, `height` tall at most,
 *  alpha 0-255. 0 degrees points north (+z) and turns run toward the east. */
export interface Band {
  arc: number;
  turn: number;
  radius: number;
  lean: number;
  height: number;
  alpha: number;
}

/** Quads along a band — so 21 points, `s` = 0..20. */
export const BAND_QUADS = 20;

const DEG = Math.PI / 180;
const sinDeg = (deg: number): number => Math.sin(deg * DEG);

// The client's named cast auras, by effect id.
const HOMUN_CASTING = 564;
const COUPLE_CASTING = 342;
const BLUE_CASTING = 441;
const GREEN_CASTING = 911;
const TETRA_CASTING = 805;
const SHADOW_CAST = 826;
/** Not in BAND_EFFECTS — the gateway draws it — but the client floors its cast
 *  at 56 ticks, so `auraTicks` has to know about it. */
const DARK_CASTING = 454;
const BUBBLE_CAST = 830;
const COMET_CAST = 1418;
const MAELSTROM_CAST = 1556;
const CLEARANCE_CAST = 1560;
const VARETYR_CAST = 1565;
const EARTH_CAST = 1664;
const CART_CAST = 1677;
const EARTH_DRIVE_CAST = 1709;
const FRAMI_CAST = 1932;
/** Aura Blade (367): a bloom, but a buff rather than a cast — 60 ticks, two
 *  textures. */
export const AURA_BLADE = 367;

/** The bubble cast (Spirit Sphere's cast): its cone picture moves every tick. */
export const BUBBLE_CAST_EFFECT = BUBBLE_CAST;

/** The bubble cast's (830) cone pictures, W_bubble01-27, one per tick. */
export const BUBBLE_TEXTURES: string[] = Array.from(
  { length: 27 },
  (_, i) => `W_bubble${String(i + 1).padStart(2, "0")}.tga`,
);

/** A band effect's texture (relative to data\texture\effect), colour and whether
 *  it adds on rather than blending. */
export interface AuraLook {
  texture: string;
  color: [number, number, number];
  additive: boolean;
}

const LOOKS: Record<number, AuraLook> = {
  [AURA_BLADE]: { texture: "ring_white.tga", color: [0xa4, 0xcd, 0xfe], additive: true },
  [TETRA_CASTING]: { texture: "ring_white.tga", color: [0xff, 0xff, 0xff], additive: true },
  [HOMUN_CASTING]: { texture: "ring_red.tga", color: [0xff, 0x59, 0xb6], additive: true },
  [SHADOW_CAST]: { texture: "ring_black.tga", color: [0x32, 0x32, 0x32], additive: false },
  [BUBBLE_CAST]: { texture: "ring_white.tga", color: [0xff, 0xff, 0xff], additive: true },
  [COUPLE_CASTING]: { texture: "ring_red.tga", color: [0xff, 0x59, 0xb6], additive: true },
  [BLUE_CASTING]: { texture: "ring_blue.tga", color: [0x64, 0x64, 0xff], additive: true },
  [GREEN_CASTING]: { texture: "ring_white.tga", color: [0x64, 0xff, 0x64], additive: true },
  [COMET_CAST]: {
    texture: "new_comet\\new_comet_cast_ring\\ring_rainbow.tga",
    color: [0x0a, 0x42, 0x72],
    additive: true,
  },
  [MAELSTROM_CAST]: { texture: "ring_blue.tga", color: [0x0a, 0x42, 0x72], additive: true },
  [CLEARANCE_CAST]: { texture: "ring_white.tga", color: [0xa4, 0xcd, 0xfe], additive: true },
  [VARETYR_CAST]: { texture: "ring_yellow.tga", color: [0x54, 0xa9, 0xcd], additive: true },
  [EARTH_CAST]: { texture: "ring_yellow.tga", color: [0xff, 0xff, 0xff], additive: false },
  [EARTH_DRIVE_CAST]: {
    texture: "new_earthdrive\\ring_brown.tga",
    color: [0xff, 0xff, 0xff],
    additive: false,
  },
  [CART_CAST]: { texture: "ring_white.tga", color: [0xf4, 0xbb, 0x7c], additive: true },
  1923: { texture: "ring_red.tga", color: [0xb4, 0x37, 0x1e], additive: false },
  [FRAMI_CAST]: { texture: "new_pramen\\ring_blue.tga", color: [0x64, 0x64, 0xff], additive: true },
  1938: { texture: "new_battle_w\\abr_battle_warior.tga", color: [0xff, 0xff, 0xff], additive: true },
  1959: {
    texture: "pneumaticusprocella\\pneumaticusprocella_cast\\ring_yellow.tga",
    color: [0xff, 0xff, 0xff],
    additive: true,
  },
  1963: { texture: "ring_white.tga", color: [0x41, 0x8d, 0xe7], additive: true },
  1986: { texture: "ring_white.tga", color: [0xa4, 0x2f, 0x1d], additive: true },
  1998: { texture: "ring_white.tga", color: [0xac, 0x9a, 0x38], additive: true },
  2240: { texture: "ring_white.tga", color: [0x50, 0x14, 0x14], additive: true },
  2249: { texture: "ring_white.tga", color: [0xc8, 0x82, 0x54], additive: true },
  2255: { texture: "ring_white.tga", color: [0xff, 0xc6, 0x5b], additive: true },
};

/** Every effect this module draws.
 *
 *  It is NOT every band effect the client has, by two cuts. One: an effect the
 *  gateway already serves a drawable row for is left alone (see SCOPE above) —
 *  so no plain `turning` aura (12, 54-59) is here, only the blooming ones and
 *  Earth Grave's pair. Two: four of the client's auras name a texture the
 *  gateway has no file for — Jack Frost's cast (1449, `ring_ice`) and the three
 *  ABR casts (1902, 1910, 1918) — and an aura drawn with the wrong picture is
 *  worse than one that stays dark, so they are out until the asset exists. */
export const BAND_EFFECTS: readonly number[] = [
  AURA_BLADE,
  TETRA_CASTING,
  HOMUN_CASTING,
  SHADOW_CAST,
  BUBBLE_CAST,
  COUPLE_CASTING,
  BLUE_CASTING,
  GREEN_CASTING,
  COMET_CAST,
  MAELSTROM_CAST,
  CLEARANCE_CAST,
  VARETYR_CAST,
  EARTH_CAST,
  EARTH_DRIVE_CAST,
  CART_CAST,
  1923,
  FRAMI_CAST,
  1938,
  1959,
  1963,
  1986,
  1998,
  2240,
  2249,
  2255,
];

export function auraLook(effect: number): AuraLook | null {
  return LOOKS[effect] ?? null;
}

/** How many sets of bands an aura draws with their OWN texture: Aura Blade's
 *  second set is ring_yellow, the bubble cast's and Maelstrom's second differ in
 *  colour and blending. */
export function auraSets(effect: number): number {
  return effect === AURA_BLADE || effect === BUBBLE_CAST || effect === MAELSTROM_CAST ? 2 : 1;
}

/** The texture set `set` of an aura is drawn with. */
export function auraSetTexture(effect: number, set: number): string | null {
  if (effect === AURA_BLADE && set === 1) return "ring_yellow.tga";
  return auraLook(effect)?.texture ?? null;
}

/** Whether set `set` of an aura adds on. The bubble cast's first set adds and its
 *  second blends. */
export function auraSetAdditive(effect: number, set: number): boolean {
  if (effect === BUBBLE_CAST) return set === 0;
  return auraLook(effect)?.additive ?? true;
}

/** Set `set`'s colour at an aura's age, 0-255 per channel. Fixed for all but two:
 *  Maelstrom's second set of cones is a lighter blue, the bubble cast's first is
 *  blue and its second white, and Tetra Vortex's cast cycles blue, red, green and
 *  pale yellow 25 ticks each. */
export function auraColour(effect: number, set: number, age: number): [number, number, number] {
  if (effect === BUBBLE_CAST) return set === 0 ? [100, 100, 255] : [255, 255, 255];
  if (effect === MAELSTROM_CAST && set === 1) return [0x23, 0x92, 0xb9];
  if (effect === TETRA_CASTING) {
    return [
      [0x64, 0x64, 0xff],
      [0xff, 0x64, 0x64],
      [0x64, 0xff, 0x64],
      [0xff, 0xff, 0xaa],
    ][Math.floor(((age + 1) % 100) / 25)] as [number, number, number];
  }
  return auraLook(effect)?.color ?? [255, 255, 170];
}

/** The auras the client floors at 56 ticks, transcribed from its list verbatim
 *  — including the handful that BAND_EFFECTS leaves out, so the floor stays
 *  right for any caller. Spelled out rather than derived from `isBloom`: the two
 *  sets are nearly the same but NOT the same (Aura Blade, 367, blooms and is
 *  still floored at 70), and deriving one from the other is a divergence that
 *  only shows up on a cast long enough to matter. */
const SHORT_FLOOR = new Set([
  12, 58, TETRA_CASTING, SHADOW_CAST, DARK_CASTING, COUPLE_CASTING, BLUE_CASTING,
  GREEN_CASTING, COMET_CAST, MAELSTROM_CAST, CLEARANCE_CAST, VARETYR_CAST,
  CART_CAST, 1872, 1876, 1902, 1910, 1918, 1923, FRAMI_CAST, 1938, 1959, 1963,
  1986, 1998, 2240, 2249, 2255,
]);

/** How long a cast's aura lasts in 16 ms ticks: the cast time, but never under
 *  the floor the client gives its kind. */
export function auraTicks(effect: number, castMs: number): number {
  const floor =
    effect === BUBBLE_CAST
      ? 100
      : effect === HOMUN_CASTING
        ? 60
        : SHORT_FLOOR.has(effect)
          ? 56
          : 70;
  return Math.max(Math.floor(castMs / 16), floor);
}

/** How long a band effect that is NOT a cast lasts, in ticks. Aura Blade's bloom
 *  runs 60. */
export function bandedTicks(effect: number): number {
  return effect === AURA_BLADE ? 60 : 100;
}

// --- The blooming auras --------------------------------------------------

/** The blooming bands' first alphas (two sets of four), heights and turns. */
const BLOOM_ALPHAS: [number[], number[]] = [
  [180, 135, 90, 45],
  [160, 115, 70, 25],
];
const BLOOM_HEIGHTS = [20, 19, 18, 17];
/** Clearance's cones stand 5 lower. */
const CLEARANCE_HEIGHTS = [15, 14, 13, 12];
const BLOOM_TURNS = [180, 270, 0, 90];

/** The auras made of blooming cones rather than turning arcs. Scoped to
 *  BAND_EFFECTS: within that set everything blooms except Earth Grave's and
 *  Earth Drive's casts, so this reads off LOOKS rather than repeating the
 *  client's full list (which also names ids the gateway already draws). */
export function isBloom(effect: number): boolean {
  return effect !== EARTH_CAST && effect !== EARTH_DRIVE_CAST && effect in LOOKS;
}

/** How many sets of cones a blooming aura makes: Comet's and Frami's only the
 *  first, the others both. */
export function bloomSets(effect: number): number {
  return effect === COMET_CAST || effect === FRAMI_CAST ? 1 : 2;
}

/** The first alphas of set `set` of a blooming aura's cones; Frami's one set is
 *  brighter. */
function bloomAlphas(effect: number, set: number): number[] {
  return effect === FRAMI_CAST ? [225, 180, 135, 90] : BLOOM_ALPHAS[set];
}

/** Blooming band `band` of set `set`, `age` ticks into an aura of `ticks`.
 *
 *  Each tick the cone widens 0.07 and leans 1 degree less (at 10 it is gone),
 *  gaining 10 alpha while under radius 4 and losing 3 from there; gone, it starts
 *  again at 3.37 leaning 74 while the aura still has more than 30 ticks to run.
 *  An aura of 60 ticks or less (the usual short cast) starts every band at alpha
 *  0 and band k five ticks late, so the cones bloom in sequence instead of all
 *  at once. Clearance's gain 5 alpha a tick, not 10, and restart at 64 degrees.
 *
 *  Null before the band starts and while it is gone. The walk is iterative
 *  because the restart depends on the whole history, which is also why the radius
 *  and lean are integers here (hundredths of a unit) — the 0.07 steps have to
 *  meet 4.00 exactly or a band never gains alpha. */
export function bloom(
  effect: number,
  set: number,
  band: number,
  ticks: number,
  age: number,
): Band | null {
  const clearance = effect === CLEARANCE_CAST;
  const gain = clearance ? 5 : 10;
  const restart = clearance ? 64 : 74;
  const short = ticks <= 60;
  const late = short ? 5 * band : 0;
  if (age < late) return null;
  const since = age - late;
  let radius = 410;
  let lean = 80;
  let alpha = short ? 0 : bloomAlphas(effect, set)[band];
  for (let tick = 0; tick <= since; tick++) {
    alpha = radius < 400 ? alpha + gain : Math.max(alpha - 3, 0);
    radius += 7;
    lean -= 1;
    if (lean <= 10) alpha = 0;
    if (alpha === 0 && late + tick + 30 < ticks) {
      radius = 337;
      lean = restart;
    }
  }
  if (alpha <= 0) return null;
  return {
    arc: 360,
    turn: BLOOM_TURNS[band],
    radius: radius / 100,
    lean,
    // The bubble cast's cones stand 10 higher.
    height: (clearance ? CLEARANCE_HEIGHTS : BLOOM_HEIGHTS)[band] + (effect === BUBBLE_CAST ? 10 : 0),
    alpha,
  };
}

/** A blooming band's top waving along it: h(1 + 0.3 sin 9s sin t), with t =
 *  age + 90k degrees for bands 0-1 and 2(age + 45k) for bands 2-3. */
export function bloomHeight(band: number, height: number, age: number, s: number): number {
  const k = band;
  const theta = band < 2 ? age + 90 * k : 2 * (age + 45 * k);
  return height * (1 + 0.3 * sinDeg(9 * s) * sinDeg(theta));
}

// --- The turning auras (Earth Grave's and Earth Drive's casts) -----------

/** The turning bands: three open 315-degree arcs and a faint column, `age` ticks
 *  into an aura of `ticks`. The arcs turn 3, 4 and 5 degrees a tick; over the
 *  last 40 ticks everything fades, 5 alpha a tick (the column 2).
 *
 *  This is the shape behind the elemental cast auras (54-59) too — the gateway
 *  draws those with its own CYLINDER rows, so here it only serves as the base
 *  Earth Grave's pair varies. */
export function turning(band: number, ticks: number, age: number): Band {
  const fading = Math.max(0, age - Math.max(0, ticks - 40));
  if (band === 3) {
    const alpha = age === 0 ? 70 : 60;
    return {
      arc: 360,
      turn: 0,
      radius: 4,
      lean: 89,
      height: 250,
      alpha: Math.max(0, alpha - 2 * fading),
    };
  }
  const k = band;
  return {
    arc: 315,
    turn: 90 * k + (3 + k) * age,
    radius: 4.5 + 0.5 * k,
    lean: [70, 57, 45][band],
    height: [25, 22, 19][band],
    alpha: Math.max(0, 180 - 5 * fading),
  };
}

/** A turning band's top along it: h sin 9s, rising with sin(age) over the first
 *  90 ticks. */
export function turningHeight(_band: number, height: number, age: number, s: number): number {
  return height * sinDeg(9 * s) * sinDeg(Math.min(age, 90));
}

/** Earth Grave's sheet's rim at its age n (from 1), as a share of its hump: sin n
 *  over the first 90 ticks, then breathing between 0.1 and 1.0 with a 360-tick
 *  period. */
export function earthSheetRim(n: number): number {
  return n <= 90 ? sinDeg(n) : 0.55 + 0.45 * sinDeg(n % 360);
}

/** Earth Grave's bands' tops: the crescents' as the other turning auras', the
 *  sheet's with its breathing rim. */
export function earthHeight(band: number, height: number, age: number, s: number): number {
  if (band < 3) return turningHeight(band, height, age, s);
  return height * sinDeg(9 * s) * earthSheetRim(age + 1);
}

/** Earth Grave's turning bands (its n counts from 1): the other turning auras'
 *  arcs and sheet, fading 5 alpha a tick (the sheet 3) over the last 40 ticks,
 *  the sheet's alpha starting at 70 and gaining 8 a tick to 100. */
export function earthTurning(band: number, ticks: number, age: number): Band {
  const n = age + 1;
  const fading = Math.max(0, n + 41 - ticks);
  const shape = turning(band, ticks, age);
  const alpha =
    band === 3
      ? Math.min(70 + 8 * Math.min(n, 20), 100) - 3 * fading
      : 180 - 5 * fading;
  return { ...shape, alpha: Math.max(0, alpha) };
}

// --- What to draw at a tick ---------------------------------------------

/** A band plus the height of each of its 21 points. */
export interface ShapedBand {
  band: Band;
  heights: number[];
  /** Which of the aura's texture sets it belongs to. */
  set: number;
}

/** Every band of an aura at `age`, with the height along each. */
export function bandsAt(effect: number, ticks: number, age: number): ShapedBand[] {
  if (isBloom(effect)) {
    const out: ShapedBand[] = [];
    for (let set = 0; set < bloomSets(effect); set++) {
      for (let band = 0; band < 4; band++) {
        const shape = bloom(effect, set, band, ticks, age);
        if (!shape) continue;
        out.push({
          band: shape,
          set,
          heights: heightsOf(band, shape.height, age, bloomHeight),
        });
      }
    }
    return out;
  }
  // Earth Grave (1664) and Earth Drive (1709): turning arcs with their own alpha
  // curve and a breathing sheet.
  const out: ShapedBand[] = [];
  for (let band = 0; band < 4; band++) {
    const shape = earthTurning(band, ticks, age);
    out.push({ band: shape, set: 0, heights: heightsOf(band, shape.height, age, earthHeight) });
  }
  return out;
}

/** The bands of one TEXTURE set — which is not the same thing as a cone set.
 *  A blooming aura makes two sets of four cones; most of them draw all eight in
 *  one pass with one picture (`auraSets` 1), and the three that have a second
 *  picture draw four in each pass. So this returns up to EIGHT bands, and a
 *  caller that assumes four silently throws half the aura away. */
export function bandsInSet(effect: number, ticks: number, age: number, set: number): ShapedBand[] {
  if (auraSets(effect) === 1) return bandsAt(effect, ticks, age);
  return bandsAt(effect, ticks, age).filter((b) => b.set === set);
}

/** The most bands ANY texture set can hold: two cone sets of four. */
export const MAX_BANDS_PER_SET = 8;

/** The most bands one texture set of THIS aura can hold. An aura with a single
 *  texture draws both cone sets in that one pass and needs all eight; one with
 *  two textures filters by cone set, so each pass needs only four. A renderer
 *  that sizes a pass below this drops cones — which is a silent bug, because
 *  `bandsAt` compacts its result, so the cones that survive shift about as
 *  others fade and restart rather than simply going missing. */
export function maxBandsInSet(effect: number): number {
  return auraSets(effect) === 1 ? MAX_BANDS_PER_SET : MAX_BANDS_PER_SET / 2;
}

function heightsOf(
  band: number,
  height: number,
  age: number,
  wave: (band: number, height: number, age: number, s: number) => number,
): number[] {
  return Array.from({ length: BAND_QUADS + 1 }, (_, s) => wave(band, height, age, s));
}

/** A band's 21 points as a vertex strip, written into `out` as 21 pairs of
 *  (foot, top) xyz — the shape a GPU buffer wants, without the 63 throwaway
 *  objects `bandPoints` makes. `scale` converts the client's units to the
 *  caller's, `mirrorX` flips the x axis. Returns how many floats it wrote. */
export function writeBandStrip(
  band: Band,
  heights: number[],
  out: Float32Array,
  scale = 1,
  mirrorX = 1,
): number {
  const leanSin = sinDeg(band.lean);
  const leanCos = Math.cos(band.lean * DEG);
  let o = 0;
  for (let s = 0; s <= BAND_QUADS; s++) {
    const angle = (band.turn + (s * band.arc) / BAND_QUADS) * DEG;
    const sin = Math.sin(angle);
    const cos = Math.cos(angle);
    const h = heights[s];
    const far = band.radius + h * leanCos;
    out[o++] = mirrorX * sin * band.radius * scale;
    out[o++] = 0;
    out[o++] = cos * band.radius * scale;
    out[o++] = mirrorX * sin * far * scale;
    out[o++] = h * leanSin * scale;
    out[o++] = cos * far * scale;
  }
  return o;
}

/** A band's 21 points from the feet: each its foot on the ground and its top,
 *  `heights[s]` along the lean. In the client's units, x/y/z with y up. The
 *  readable form of `writeBandStrip`, which is what actually runs per frame. */
export function bandPoints(
  band: Band,
  heights: number[],
): { foot: [number, number, number]; top: [number, number, number] }[] {
  const leanSin = sinDeg(band.lean);
  const leanCos = Math.cos(band.lean * DEG);
  return Array.from({ length: BAND_QUADS + 1 }, (_, s) => {
    const angle = (band.turn + (s * band.arc) / BAND_QUADS) * DEG;
    const sin = Math.sin(angle);
    const cos = Math.cos(angle);
    const h = heights[s];
    const out = band.radius + h * leanCos;
    const up = h * leanSin;
    return {
      foot: [sin * band.radius, 0, cos * band.radius] as [number, number, number],
      top: [sin * out, up, cos * out] as [number, number, number],
    };
  });
}
