// Async loader + cache for the map viewer's skill/world effects. ragassets
// serves roBrowser's effect data as JSON + textures; this module fetches the two
// lookup tables (SkillEffect skill-map + EffectTable) once, then resolves an
// `effectId` to its loaded .str animations (parsed keyframes + GPU textures),
// memoized so the many casts that reuse the same effect only pay the network hit
// once. The three.js rendering of the result lives in ./strEffect.ts.
//
// v1 handles only `type:"STR"` effect entries (the bulk of skill visuals). SPR/
// CYLINDER/FUNC entries are logged and skipped so we can prioritise follow-ups.

import {
  ClampToEdgeWrapping,
  LinearFilter,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
  TextureLoader,
} from "three";
import {
  effectSkillMapUrl,
  effectStrUrl,
  effectTableUrl,
  effectTextureUrl,
} from "../ragassets";

/** One STR keyframe — the raw /effect/str shape (color 0–255, srcalpha/destalpha
 *  are D3DBLEND ints; the renderer normalizes/maps them). */
interface StrAnim {
  frame: number;
  type: number; // 0 = absolute snapshot, 1 = per-frame velocity (morph)
  pos: number[]; // [x, y]
  uv: number[]; // [8] (unused in v1 — full texture)
  xy: number[]; // [8]: x of 4 corners then y of 4 corners (offsets from pos)
  aniframe: number; // texture index within the layer
  anitype: number; // texture-frame advance mode (0 none, 2 stop, 3 loop, 4 reverse)
  delay: number; // per-frame texture step (anitype 2/3/4)
  angle: number; // degrees
  color: number[]; // [r, g, b, a] 0–255
  srcalpha: number; // D3DBLEND src factor
  destalpha: number; // D3DBLEND dst factor
  mtpreset: number;
}

/** One additive draw layer: its candidate textures (loaded, null if a name
 *  failed) and its keyframe track. */
export interface StrLayer {
  textures: (Texture | null)[];
  animations: StrAnim[];
}

/** A parsed + texture-loaded .str, ready for StrEffect to sample. */
export interface LoadedStr {
  fps: number;
  maxKey: number;
  layers: StrLayer[];
  /** Delay (ms) after the spawn before this part starts playing. Multi-part
   *  modern effects stage their waves (Arrow Storm: strikes, then the rain
   *  canopy); the client EXE hardcodes the stagger, we carry it per part. */
  startDelayMs?: number;
}

/** A parsed + texture-loaded CYLINDER, ready for CylinderEffect to draw. Sizes
 *  are in tiles (world units = size * cellSize); colour/alpha 0–1. */
export interface LoadedCylinder {
  texture: Texture | null;
  totalCircleSides: number;
  circleSides: number;
  topSize: number;
  bottomSize: number;
  height: number;
  alphaMax: number;
  blendMode: number;
  fade: boolean;
  rotate: boolean;
  animation: number;
  duration: number;
  angleX: number;
  angleY: number;
  angleZ: number;
  repeat: boolean;
  repeatTextureX: number;
  rotateWithCamera: boolean;
  color: [number, number, number];
  /** Part stagger (ms) — same staging role as LoadedStr.startDelayMs. */
  startDelayMs?: number;
}

/** A parsed + texture-loaded "3D" billboard particle, fully resolved for one
 *  duplicate instance (randoms sampled, `*Delta` applied) — ThreeDEffect just
 *  plays it. Positions are in tiles; sizes in sprite-px (× UNITS_PER_PX at draw). */
export interface LoadedThreeD {
  texture: Texture | null;
  overlay: boolean;
  blendMode: number;
  duration: number;
  alphaMax: number;
  red: number;
  green: number;
  blue: number;
  posxStart: number; posxEnd: number; posxSmooth: boolean;
  posyStart: number; posyEnd: number; posySmooth: boolean;
  poszStart: number; poszEnd: number; poszSmooth: boolean;
  rotatePosX: number; rotatePosY: number; nbOfRotation: number;
  rotateLate: number; rotationClockwise: boolean;
  retreat: number; arc: number;
  sizeStartX: number; sizeEndX: number;
  sizeStartY: number; sizeEndY: number;
  sizeSmooth: boolean;
  angle: number; toAngle: number; rotate: boolean; rotateWithCamera: boolean;
  fadeIn: boolean; fadeOut: boolean;
  sparkling: boolean; sparkNumber: number;
  /** 2D variant: offsets rotate with the camera (screen-facing overlay). */
  twoD: boolean;
  /** Duplicate stagger (ms) — same staging role as LoadedStr.startDelayMs. */
  startDelayMs?: number;
}

/** An effect resolves to a list of these — each renders as its own StrEffect,
 *  CylinderEffect or ThreeDEffect, all anchored together. A single effectId can
 *  mix them (e.g. a ground ring plus a keyframe flash plus a mote cloud). */
export type LoadedPart =
  | { kind: "str"; str: LoadedStr }
  | { kind: "cylinder"; cyl: LoadedCylinder }
  | { kind: "threeD"; three: LoadedThreeD };

/** A skill's effect ids from the SkillEffect table. */
interface SkillEffectEntry {
  effectId?: number;
  hitEffectId?: number;
  groundEffectId?: number;
}

/** One EffectTable row entry. `type:"STR"` (keyframe files) and `type:"CYLINDER"`
 *  (procedural ground rings) render; SPR/FUNC/3D and sound-only rows are ignored.
 *  Cylinder fields mirror roBrowser's Cylinder effect attributes. */
interface EffectTableEntry {
  type?: string; // "STR" | "CYLINDER" | "SPR" | "FUNC" | "3D" | undefined (sound-only)
  file?: string; // STR file name; may contain a "%d" variant placeholder
  rand?: number[]; // [min, max] for the "%d" variant (client picks one)
  // --- CYLINDER attributes (all optional; defaults applied on load) ----------
  textureName?: string;
  topSize?: number;
  bottomSize?: number;
  height?: number;
  alphaMax?: number;
  blendMode?: number;
  fade?: boolean;
  rotate?: boolean;
  animation?: number;
  duration?: number;
  totalCircleSides?: number;
  circleSides?: number;
  angleX?: number;
  angleY?: number;
  angleZ?: number;
  angleXRandom?: number;
  angleYRandom?: number;
  angleZRandom?: number;
  repeat?: boolean;
  repeatTextureX?: number;
  rotateWithCamera?: boolean;
  red?: number;
  green?: number;
  blue?: number;
}

// --- Skill map (skillId → effect ids) ------------------------------------
// Fetched once and kept in a module singleton so the per-event drain can read it
// synchronously (skillEntry). Until the fetch lands, skillEntry returns
// undefined and the caller simply spawns no effect (graceful — a few early casts
// on open may be silent).
let skillMap: Record<string, SkillEffectEntry> | null = null;
let skillMapPromise: Promise<void> | null = null;

/** Kick off (once) the skill-map fetch. Safe to call repeatedly. `cache:"no-store"`
 *  because this lookup table is regenerated on the gateway when its skill/effect
 *  data grows, yet is served `immutable, max-age=1yr` — without this, a returning
 *  user keeps a stale (smaller) map cached and never sees newly-covered skills.
 *  It's memoized in-memory below, so this is one fresh fetch per viewer open. The
 *  per-effect STR + texture assets ARE content-immutable (keyed by file name), so
 *  those keep the browser cache. */
export function preloadSkillMap(): Promise<void> {
  if (!skillMapPromise) {
    skillMapPromise = fetch(effectSkillMapUrl(), { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(`skill-map HTTP ${r.status}`);
        return r.json();
      })
      .then((json) => {
        skillMap = json as Record<string, SkillEffectEntry>;
      })
      .catch((err) => {
        console.warn("[effects] skill-map load failed", err);
        skillMap = {}; // cache the failure so we don't retry every frame
      });
  }
  return skillMapPromise;
}

/** The effect ids for a skill, or undefined if the map isn't loaded / the skill
 *  has no mapped effect. Synchronous — call preloadSkillMap() at setup. */
export function skillEntry(skillId: number): SkillEffectEntry | undefined {
  return skillMap ? skillMap[String(skillId)] : undefined;
}

// --- Effect table (effectId → STR files) ---------------------------------
let tablePromise: Promise<Record<string, EffectTableEntry[]>> | null = null;

function effectTable(): Promise<Record<string, EffectTableEntry[]>> {
  if (!tablePromise) {
    // no-store for the same reason as the skill-map: a mutable table served with
    // an immutable cache header (see preloadSkillMap).
    tablePromise = fetch(effectTableUrl(), { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(`effect-table HTTP ${r.status}`);
        return r.json();
      })
      .catch((err) => {
        console.warn("[effects] effect-table load failed", err);
        return {} as Record<string, EffectTableEntry[]>;
      });
  }
  return tablePromise;
}

// --- Textures (shared across effects) ------------------------------------
const textureLoader = new TextureLoader();
const textureCache = new Map<string, Texture>();

function loadEffectTexture(name: string, wrapRepeat = false): Texture {
  // Cylinders with repeatTextureX>1 tile the texture around the ring (wrapS =
  // Repeat); everything else clamps. Cache per (name, wrap) so the two modes of
  // the same file don't clobber each other's wrap setting.
  const key = wrapRepeat ? `${name}|repeat` : name;
  let tex = textureCache.get(key);
  if (!tex) {
    tex = textureLoader.load(effectTextureUrl(name), undefined, undefined, () =>
      console.debug("[effects] texture failed", name),
    );
    tex.colorSpace = SRGBColorSpace;
    // NPOT effect PNGs: linear, no mipmaps (smooth glow, no seams).
    tex.wrapS = wrapRepeat ? RepeatWrapping : ClampToEdgeWrapping;
    tex.wrapT = ClampToEdgeWrapping;
    tex.minFilter = tex.magFilter = LinearFilter;
    tex.generateMipmaps = false;
    textureCache.set(key, tex);
  }
  return tex;
}

// --- Effect loading (effectId → LoadedPart[]) ----------------------------
const effectCache = new Map<number, Promise<LoadedPart[]>>();

/** One STR file that makes up (part of) an effect, with an optional stagger
 *  before it starts. Multi-part modern effects list several. */
interface EffectPart {
  file: string;
  delayMs?: number;
}

/** Load a list of STR parts (client override / modern rework — both STR-only),
 *  stamping each with its stagger delay and wrapping as a LoadedPart. A part
 *  that fails to load is dropped (logged) rather than sinking the whole effect. */
function loadParts(parts: EffectPart[]): Promise<LoadedPart[]> {
  return Promise.all(
    parts.map(async (part): Promise<LoadedPart | null> => {
      try {
        const str = await loadStrFile(part.file);
        str.startDelayMs = part.delayMs;
        return { kind: "str", str };
      } catch (err) {
        console.warn("[effects] part load failed", part.file, err);
        return null;
      }
    }),
  ).then((a) => a.filter((x): x is LoadedPart => x != null));
}

/** Modern-client effect rework: kRO redesigned many skill visuals (~2020) as
 *  "new_*" STR compositions in per-effect GRF subdirs, hardcoded in the client
 *  EXE. The gateway's effect table comes from roBrowserLegacy, which still maps
 *  those skills to their PRE-rework flat .str (e.g. Arrow Storm → the old gold
 *  streaks instead of the green new_arrowstorm the live client plays). Until the
 *  gateway table learns the reworked compositions, override per effectId here
 *  with the actual multi-part STR file list (verified against in-game footage).
 *  Each part renders as its own StrEffect, all anchored together; `delayMs`
 *  staggers a part's start — the waves' relative timing is hardcoded in the
 *  client EXE, so it's reproduced here from footage. */
const MODERN_EFFECT_OVERRIDES: Record<number, EffectPart[]> = {
  // EF_ARROWSTORM (746) — RA_ARROWSTORM. In-game: _00 = repeated arrow strikes
  // + ground shocks; _01 = the big rain wave (glow canopy + long vertical arrow
  // streaks + rings), whose final frames hold the arrows planted in the ground.
  // The live client sustains the storm ~1.4s by overlapping an instance per
  // damage wave — reproduced here as two staggered pairs (timed from footage).
  746: [
    { file: "new_arrowstorm/new_arrowstorm_00/new_arrowstorm_00" },
    { file: "new_arrowstorm/new_arrowstorm_00/new_arrowstorm_00", delayMs: 450 },
    { file: "new_arrowstorm/new_arrowstorm_01/new_arrowstorm_01", delayMs: 650 },
    { file: "new_arrowstorm/new_arrowstorm_01/new_arrowstorm_01", delayMs: 950 },
  ],
};

/** Client-side skill → STR overrides for skills the gateway's skill-map doesn't
 *  cover at all — chiefly the 4th-job Windhawk skills, which post-date the
 *  roBrowserLegacy tables the gateway is built from, so `skillEntry()` returns
 *  nothing and no effect would spawn. Keyed by skillId (not effectId, since there
 *  is no effect-table row to key off). The STR file names come from the client's
 *  GRF effect dirs (data/texture/effect/<name>). Verified to render + roughly
 *  timed here; the client EXE's exact stagger isn't available, so delays are
 *  eyeballed from the parts' own durations. All anchor on the target (like every
 *  other main effect today). */
const SKILL_STR_OVERRIDES: Record<number, EffectPart[]> = {
  // WH_HAWKRUSH (5326) — a single quick slash as the hawk rushes the target.
  5326: [{ file: "hawkrush/hawkrush/hawkrush" }],
  // WH_GALESTORM (5330) — arrow tornado: the swirling column, a ring of loosed
  // arrows, then the impact flash.
  5330: [
    { file: "galestorm/galestorm/galestorm" },
    { file: "galestorm/galestorm_arrow/galestorm_arrow", delayMs: 150 },
    { file: "galestorm/galestorm_hit/galestorm_hit", delayMs: 250 },
  ],
  // WH_CRESCIVE_BOLT (5334) — a charged bolt into the target, then its burst.
  5334: [
    { file: "crescivebolt/crescivebolt/crescivebolt" },
    { file: "crescivebolt/crescivebolt_hit/crescivebolt_hit", delayMs: 300 },
  ],
};

const skillOverrideCache = new Map<number, Promise<LoadedPart[]>>();

/** Whether a skill has ANY main effect we can render — a client STR override or
 *  a gateway skill-map effectId. Synchronous (reads the memoized skill-map).
 *  Lets the spawn path skip the dedup bookkeeping for skills that draw nothing. */
export function hasSkillEffect(skillId: number): boolean {
  return SKILL_STR_OVERRIDES[skillId] != null || skillEntry(skillId)?.effectId != null;
}

/** Resolve a skill's MAIN effect to loaded STR parts: a client override wins
 *  (covers skills the gateway lacks / would render with a stale asset), else the
 *  gateway skill-map's effectId. Resolves to [] when neither applies. Memoized. */
export function loadSkillMainEffect(skillId: number): Promise<LoadedPart[]> {
  const override = SKILL_STR_OVERRIDES[skillId];
  if (override) {
    let p = skillOverrideCache.get(skillId);
    if (!p) {
      p = loadParts(override);
      skillOverrideCache.set(skillId, p);
    }
    return p;
  }
  const eff = skillEntry(skillId);
  if (eff?.effectId != null) return loadEffect(eff.effectId);
  return Promise.resolve([]);
}

/** Substitute a "%d" file variant using the entry's `rand` range (the client
 *  picks one at random per cast). */
function resolveFileName(file: string, rand?: number[]): string {
  if (!file.includes("%d")) return file;
  const lo = rand && rand.length ? rand[0] : 1;
  const hi = rand && rand.length > 1 ? rand[1] : lo;
  const n = lo + Math.floor(Math.random() * (hi - lo + 1));
  return file.replace("%d", String(n));
}

async function loadStrEntry(entry: EffectTableEntry): Promise<LoadedPart | null> {
  if (!entry.file) return null;
  try {
    const str = await loadStrFile(resolveFileName(entry.file, entry.rand));
    return { kind: "str", str };
  } catch (err) {
    console.warn("[effects] str load failed", entry.file, err);
    return null;
  }
}

const num = (v: number | undefined, dflt: number): number =>
  typeof v === "number" && !isNaN(v) ? v : dflt;

/** Parse one CYLINDER table entry into a LoadedCylinder, kicking off its texture
 *  load. Defaults follow roBrowser's Cylinder constructor (20 sides, alphaMax 1,
 *  white). Random angle jitter is resolved once here (per instance). */
function loadCylinderEntry(entry: EffectTableEntry): LoadedPart {
  const total = num(entry.totalCircleSides, 20);
  const repeatTextureX = num(entry.repeatTextureX, 1);
  const cyl: LoadedCylinder = {
    texture: entry.textureName
      ? loadEffectTexture(entry.textureName, repeatTextureX > 1)
      : null,
    totalCircleSides: total,
    circleSides: num(entry.circleSides, total),
    topSize: num(entry.topSize, 0),
    bottomSize: num(entry.bottomSize, 0),
    height: num(entry.height, 10),
    alphaMax: entry.alphaMax && entry.alphaMax > 0 ? entry.alphaMax : 1,
    blendMode: num(entry.blendMode, 0),
    fade: !!entry.fade,
    rotate: !!entry.rotate,
    animation: num(entry.animation, 0),
    duration: num(entry.duration, 1000),
    angleX: num(entry.angleX, 0) + Math.floor(Math.random() * num(entry.angleXRandom, 0)),
    angleY: num(entry.angleY, 0) + Math.floor(Math.random() * num(entry.angleYRandom, 0)),
    angleZ: num(entry.angleZ, 0) + Math.floor(Math.random() * num(entry.angleZRandom, 0)),
    repeat: !!entry.repeat,
    repeatTextureX,
    rotateWithCamera: !!entry.rotateWithCamera,
    color: [num(entry.red, 1), num(entry.green, 1), num(entry.blue, 1)],
  };
  return { kind: "cylinder", cyl };
}

// roBrowser randBetween (3-dp clamp to max), used to sample the 3D pos/size
// jitter fields once at load (per duplicate instance).
function randBetween(min: number, max: number): number {
  return parseFloat(Math.min(min + Math.random() * (max - min), max).toFixed(3));
}

// roBrowser getRandomIntInclusive — the 2D variant's integer jitter (angle,
// circle radius). Inclusive of both bounds.
function randInt(min: number, max: number): number {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min + 1) + min);
}

/** Resolve one "3D" (or "2D") table entry into `duplicate` LoadedThreeD instances,
 *  faithfully porting roBrowser ThreeDEffect/TwoDEffect's constructor (pos/size
 *  variant collapse, random jitter, `*Delta` scaling by duplicateID) and
 *  EffectManager's duplicate stagger (`timeBetweenDupli*id`). `twoD` selects the 2D
 *  variant: its offsets rotate with the camera (screen-facing overlay), sizeRand is
 *  +100-based, and `circlePattern` lays duplicates around a ring. Advanced 3D paths
 *  not yet ported — projectile travel (fromSrc/toSrc, needs a target position),
 *  soulStrike/drainPattern, and sprite-textured effects (spriteName/absoluteSpriteName/
 *  shadowTexture, need .spr/.act) — are skipped: the part still renders its base
 *  `file` billboard, or nothing if it has no plain texture (never a wrong stand-in). */
function loadThreeDEntry(entry: EffectTableEntry, twoD = false): LoadedPart[] {
  const e = entry as unknown as Record<string, number | number[] | boolean | string | undefined>;
  const n = (k: string, d: number): number => {
    const v = e[k];
    return typeof v === "number" && !isNaN(v) ? v : d;
  };
  const has = (k: string): boolean => typeof e[k] === "number";
  const b = (k: string): boolean => !!e[k];
  // The table's 3D `file` is GRF-relative ("effect/ac_center2.tga"), but the
  // gateway's texture endpoint is already rooted at data/texture/effect/ (STR
  // texture names arrive bare) — so strip the leading "effect/" or the URL
  // double-roots and 404s.
  const rawFile = typeof e.file === "string" ? e.file : undefined;
  const file = rawFile?.replace(/^effect[/\\]/i, "");
  // Sprite-textured 3D isn't supported yet → no texture (renders nothing, not wrong).
  const texture = file && !e.spriteName && !e.absoluteSpriteName && !e.shadowTexture
    ? loadEffectTexture(file)
    : null;

  let duplicate = n("duplicate", 1);
  if (duplicate === -1) duplicate = 999;
  duplicate = Math.max(1, Math.min(duplicate, 999));
  const timeBetweenDupli = n("timeBetweenDupli", 200);

  const out: LoadedPart[] = [];
  for (let id = 0; id < duplicate; id++) {
    // --- size variants → start/end X/Y (roBrowser order) --------------------
    let sizeStartX = 1, sizeStartY = 1, sizeEndX = 1, sizeEndY = 1;
    if (has("size")) { const s = n("size", 1); sizeStartX = sizeStartY = sizeEndX = sizeEndY = s; }
    if (has("sizeDelta")) { const d = n("sizeDelta", 0) * id; sizeStartX += d; sizeStartY += d; sizeEndX += d; sizeEndY += d; }
    if (has("sizeStart")) { sizeStartX = sizeStartY = n("sizeStart", 1); }
    if (has("sizeEnd")) { sizeEndX = sizeEndY = n("sizeEnd", 1); }
    if (has("sizeX")) { sizeStartX = sizeEndX = n("sizeX", 1); }
    if (has("sizeY")) { sizeStartY = sizeEndY = n("sizeY", 1); }
    if (has("sizeStartX")) sizeStartX = n("sizeStartX", 1);
    if (has("sizeStartY")) sizeStartY = n("sizeStartY", 1);
    if (has("sizeEndX")) sizeEndX = n("sizeEndX", 1);
    if (has("sizeEndY")) sizeEndY = n("sizeEndY", 1);
    if (has("sizeRand")) {
      // 2D jitters around 100 with integer steps; 3D jitters around `size`.
      const s = twoD
        ? randInt(-n("sizeRand", 0), n("sizeRand", 0)) + 100
        : n("size", 0) + randBetween(-n("sizeRand", 0), n("sizeRand", 0));
      sizeStartX = sizeStartY = sizeEndX = sizeEndY = s;
    }
    if (has("sizeRandX")) { const m = n("sizeRandXMiddle", 100); sizeStartX = sizeEndX = randBetween(m - n("sizeRandX", 0), m + n("sizeRandX", 0)); }
    if (has("sizeRandY")) { const m = n("sizeRandYMiddle", 100); sizeStartY = sizeEndY = randBetween(m - n("sizeRandY", 0), m + n("sizeRandY", 0)); }
    // 2D per-corner size ranges (roBrowser TwoDEffect; a lens flare grows from a
    // small start rect into a long streak). Arrays of [min,max].
    if (Array.isArray(e.sizeRandStartX)) sizeStartX = randInt(e.sizeRandStartX[0], e.sizeRandStartX[1]);
    if (Array.isArray(e.sizeRandStartY)) sizeStartY = randInt(e.sizeRandStartY[0], e.sizeRandStartY[1]);
    if (Array.isArray(e.sizeRandEndX)) sizeEndX = randInt(e.sizeRandEndX[0], e.sizeRandEndX[1]);
    if (Array.isArray(e.sizeRandEndY)) sizeEndY = randInt(e.sizeRandEndY[0], e.sizeRandEndY[1]);

    // --- one axis's start/end position variant collapse ---------------------
    const axis = (ax: "x" | "y" | "z"): [number, number] => {
      let start = n(`pos${ax}Start`, 0);
      let end = n(`pos${ax}End`, 0);
      if (has(`pos${ax}`)) { start = end = n(`pos${ax}`, 0); }
      if (has(`pos${ax}Rand`)) { start = randBetween(-n(`pos${ax}Rand`, 0), n(`pos${ax}Rand`, 0)); end = start; }
      if (has(`pos${ax}RandDiff`)) { start = randBetween(-n(`pos${ax}RandDiff`, 0), n(`pos${ax}RandDiff`, 0)); end = randBetween(-n(`pos${ax}RandDiff`, 0), n(`pos${ax}RandDiff`, 0)); }
      if (has(`pos${ax}StartRand`)) { const m = n(`pos${ax}StartRandMiddle`, 0); start = randBetween(m - n(`pos${ax}StartRand`, 0), m + n(`pos${ax}StartRand`, 0)); }
      if (has(`pos${ax}EndRand`)) { const m = n(`pos${ax}EndRandMiddle`, 0); end = randBetween(m - n(`pos${ax}EndRand`, 0), m + n(`pos${ax}EndRand`, 0)); }
      return [start, end];
    };
    let [posxStart, posxEnd] = axis("x");
    let [posyStart, posyEnd] = axis("y");
    const [poszStart, poszEnd] = axis("z");

    let alphaMax = has("alphaMax") ? Math.max(Math.min(n("alphaMax", 1), 1), 0) : 1;
    alphaMax = Math.max(Math.min(alphaMax + n("alphaMaxDelta", 0) * id, 1), 0);

    let sparkNumber = 1;
    if (has("sparkNumber")) sparkNumber = n("sparkNumber", 1);
    else if (Array.isArray(e.sparkNumberRand)) sparkNumber = randBetween(e.sparkNumberRand[0], e.sparkNumberRand[1]);

    let angle = n("angle", 0);
    let toAngle = n("toAngle", 0);
    if (twoD) {
      if (has("angleDelta")) { const d = n("angleDelta", 0) * id; angle += d; toAngle += d; }
      if (Array.isArray(e.angleRand)) angle = randInt(e.angleRand[0], e.angleRand[1]);
      // circlePattern: fan the duplicates onto a ring, each flying inner→outer along
      // its own angle (roBrowser TwoDEffect).
      if (b("circlePattern") && Array.isArray(e.circleOuterSizeRand)) {
        const dist = randInt(e.circleOuterSizeRand[0], e.circleOuterSizeRand[1]);
        const inner = n("circleInnerSize", 0);
        const rad = (angle * Math.PI) / 180;
        posxStart = Math.sin(rad) * inner;
        posyStart = Math.cos(rad) * inner;
        posxEnd = Math.sin(rad) * dist;
        posyEnd = Math.cos(rad) * dist;
      }
    }
    const duration = Array.isArray(e.durationRand)
      ? randBetween(e.durationRand[0], e.durationRand[1])
      : n("duration", 1000);

    const rotateLate = n("rotateLate", 0) + n("rotateLateDelta", 0) * id;

    out.push({
      kind: "threeD",
      three: {
        texture,
        overlay: b("overlay"),
        blendMode: n("blendMode", 0),
        duration,
        alphaMax,
        red: n("red", 1), green: n("green", 1), blue: n("blue", 1),
        posxStart, posxEnd, posxSmooth: b("posxSmooth"),
        posyStart, posyEnd, posySmooth: b("posySmooth"),
        poszStart, poszEnd, poszSmooth: b("poszSmooth"),
        rotatePosX: Math.max(0, n("rotatePosX", 0)),
        rotatePosY: Math.max(0, n("rotatePosY", 0)),
        nbOfRotation: n("nbOfRotation", 0) > 0 ? n("nbOfRotation", 1) : 1,
        rotateLate,
        rotationClockwise: b("rotationClockwise"),
        retreat: n("retreat", 0),
        arc: n("arc", 0),
        sizeStartX, sizeEndX, sizeStartY, sizeEndY,
        sizeSmooth: b("sizeSmooth"),
        angle, toAngle, rotate: b("rotate"), rotateWithCamera: b("rotateWithCamera"),
        fadeIn: b("fadeIn"), fadeOut: b("fadeOut"),
        sparkling: b("sparkling"), sparkNumber,
        twoD,
        startDelayMs: (n("delayStart", 0) + timeBetweenDupli * id) || undefined,
      },
    });
  }
  return out;
}

/** Fetch + texture-load one parsed .str by gateway file name. Nested STRs (the
 *  modern "new_*" effect rework lives in per-effect subdirs) reference their
 *  textures by bare name relative to the STR's own directory — resolve them
 *  against it. */
export async function loadStrFile(file: string): Promise<LoadedStr> {
  const res = await fetch(effectStrUrl(file));
  if (!res.ok) throw new Error(`str "${file}" HTTP ${res.status}`);
  const json = (await res.json()) as {
    fps: number;
    maxKey: number;
    layers: { textures: (string | null)[]; animations: StrAnim[] }[];
  };
  const slash = file.lastIndexOf("/");
  const dir = slash >= 0 ? file.slice(0, slash + 1) : "";
  const layers: StrLayer[] = json.layers.map((ly) => ({
    animations: ly.animations,
    textures: ly.textures.map((n) => (n ? loadEffectTexture(dir + n) : null)),
  }));
  return { fps: json.fps, maxKey: json.maxKey, layers };
}

/** Resolve an effectId to its loaded parts (STR keyframe files + CYLINDER ground
 *  rings), memoized. SPR/FUNC/3D/sound-only entries are logged and skipped; a
 *  fully unknown/empty effectId resolves to []. STR and CYLINDER parts keep the
 *  table's declared order so a ring under a flash renders in the right sequence. */
export function loadEffect(effectId: number): Promise<LoadedPart[]> {
  let p = effectCache.get(effectId);
  if (!p) {
    p = (async () => {
      const modern = MODERN_EFFECT_OVERRIDES[effectId];
      if (modern) return loadParts(modern);
      const table = await effectTable();
      const entries = table[String(effectId)] ?? [];
      const SUPPORTED = new Set(["STR", "CYLINDER", "3D", "2D"]);
      const others = entries.filter((e) => e.type && !SUPPORTED.has(e.type));
      if (others.length) {
        console.debug(
          `[effects] effect ${effectId}: skipping unsupported entries`,
          others.map((e) => e.type),
        );
      }
      // Each entry yields 0..n parts (3D expands its `duplicate` instances);
      // flatten, preserving table order so a ground ring under a flash stays below.
      const loaded = await Promise.all(
        entries.map((e): LoadedPart | LoadedPart[] | null | Promise<LoadedPart | null> =>
          e.type === "STR"
            ? loadStrEntry(e)
            : e.type === "CYLINDER"
              ? loadCylinderEntry(e)
              : e.type === "3D"
                ? loadThreeDEntry(e)
                : e.type === "2D"
                  ? loadThreeDEntry(e, true)
                  : null,
        ),
      );
      return loaded.flat().filter((x): x is LoadedPart => x != null);
    })();
    effectCache.set(effectId, p);
  }
  return p;
}
