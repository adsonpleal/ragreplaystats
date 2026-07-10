// A parsed ".str" effect rendered as in-scene camera-facing quads — one per
// layer — so RO's skill visuals (fire bolts, heal sparkles, auras) glow over the
// 3D map with per-keyframe additive blending. Faithful port of roBrowser's
// StrEffect.js (src/Renderer/Effects/StrEffect.js; cross-checked against the
// maintained roBrowserLegacy fork), which our scene descends from.
//
// STR animation model (matches roBrowser exactly):
//  - keyIndex advances at `(elapsedMs / 1000) * fps`; the effect ends at maxKey.
//  - per layer, `from` = the LAST type-0 (snapshot) key with frame <= keyIndex and
//    `to` = the LAST type-1 (velocity) key with frame <= keyIndex. The layer stops
//    once keyIndex passes its last keyframe with no velocity key active
//    (`fromId < 0 || (toId < 0 && lastFrame < keyIndex)`).
//  - the morph applies ONLY when the velocity key is the snapshot's immediate
//    next entry AND shares its frame; then every field drifts linearly:
//        value = from.value + to.value * (keyIndex - from.frame)
//    otherwise the snapshot renders as-is (static).
//  - `xy` holds the quad's 4 corners (x0..x3, y0..y3) relative to `pos` — an
//    arbitrary quadrilateral (arrow streaks are skewed), NOT an axis-aligned
//    rect. roBrowser builds the vertex buffer from the corners directly with
//    hardcoded 0/1 texcoords (the file's `uv` track is unused); we mirror that.
//  - `angle` is stored in 1024ths of a full circle (roBrowser's loader divides
//    by 1024/360 to get degrees). The gateway serves the RAW value, so we
//    convert here. Getting this wrong (treating it as degrees) scrambles
//    multi-layer effects like Arrow Storm.
//  - `color` is 0-255 (the gateway serves raw; normalize here).
//
// Blending: srcalpha/destalpha are raw D3DBLEND ints mapped to three's blend
// factors on a per-frame CustomBlending material. depthWrite off + depthTest on
// so 3D objects still occlude the effect but the flat quads don't fight each
// other. fog:false — RO never fogs foreground effect particles (and additive +
// fog paints solid fog-coloured boxes over the transparent quad).

import {
  AddEquation,
  BufferAttribute,
  BufferGeometry,
  CustomBlending,
  DoubleSide,
  DstColorFactor,
  Group,
  Mesh,
  MeshBasicMaterial,
  OneFactor,
  OneMinusDstColorFactor,
  OneMinusSrcAlphaFactor,
  OneMinusSrcColorFactor,
  type PerspectiveCamera,
  SrcAlphaFactor,
  SrcAlphaSaturateFactor,
  SrcColorFactor,
  type Scene,
  Vector3,
  ZeroFactor,
} from "three";
import { UNITS_PER_PX } from "../sprite";
import type { LoadedStr, StrLayer } from "./effectAssets";

// roBrowser anchors .str effects at STR (320, 320) — the content's origin pixel,
// pinned on the entity's ground point (StrEffect.js: `pos -= 320`).
const ANCHOR_X = 320;
const ANCHOR_Y = 320;
// Pull toward the camera along the line of sight, like Character's FRONT_BIAS, so
// the effect clears the surrounding ground without an on-screen shift.
const FRONT_BIAS = 2.5;
// STR angle unit → radians. Angles are stored as 1024ths of a full circle
// (roBrowser: `angle = raw / (1024/360)` degrees); raw -256 = -90°.
const STR_ANGLE_TO_RAD = ((360 / 1024) * Math.PI) / 180;
// Horizontal mirror applied to the effect's local X. roBrowser draws effects
// through an x-negated camera (a true mirror); our scene reproduces the RO
// orientation with root.scale(-1,-1,1) — a 180° rotation, NOT a mirror — so
// ported effects come out flipped. We fold the missing mirror into local X here.
// One grep-able token so it stays distinct from the Y-down→Y-up axis flip.
const MIRROR_X = -1;

// D3DBLEND enum int → three.js blend factor. 1..11 are the standard factors;
// 12..15 (BOTHSRCALPHA/BLENDFACTOR) are rare and fall back to the default.
//
// DESTALPHA (7) / INVDESTALPHA (8): the RO client renders to an X8R8G8B8
// backbuffer — no destination alpha — so D3D defines them as constant 1 / 0
// there. Mapping them to the real DST_ALPHA factors instead reads whatever
// alpha earlier transparent quads happened to write into our framebuffer,
// which ERASES the glow behind later layers (arrows rendered solid black
// inside the Arrow Storm canopy). Emulate the client's constants.
const D3D_BLEND: Record<number, number> = {
  1: ZeroFactor,
  2: OneFactor,
  3: SrcColorFactor,
  4: OneMinusSrcColorFactor,
  5: SrcAlphaFactor,
  6: OneMinusSrcAlphaFactor,
  7: OneFactor, // DESTALPHA on an alpha-less backbuffer ≡ 1
  8: ZeroFactor, // INVDESTALPHA on an alpha-less backbuffer ≡ 0
  9: DstColorFactor,
  10: OneMinusDstColorFactor,
  11: SrcAlphaSaturateFactor,
};

function blendFactor(d3d: number, fallback: number): number {
  return D3D_BLEND[d3d] ?? fallback;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** One layer's quad at a moment in time (STR space, fields still raw where the
 *  renderer applies the unit conversion). */
interface Sample {
  posX: number; // layer origin (STR px, absolute; content is corner offsets)
  posY: number;
  xy: ArrayLike<number>; // 4 corner offsets: x0..x3, y0..y3
  angleRaw: number; // 1024ths of a circle
  r: number; // colour 0..1
  g: number;
  b: number;
  a: number;
  src: number; // D3DBLEND src factor int
  dst: number; // D3DBLEND dst factor int
  texIdx: number;
}

// Reused per-sample corner scratch (only when morphing; static frames use the
// keyframe's own array).
const xyTmp = new Float32Array(8);

// Reused per-sample result. sampleLayer runs once per layer per live effect
// every frame and its result is fully consumed within that same loop iteration
// (never stored), so a single shared instance avoids per-frame allocation.
const sampleTmp: Sample = {
  posX: 0, posY: 0, xy: xyTmp, angleRaw: 0, r: 0, g: 0, b: 0, a: 0, src: 0, dst: 0, texIdx: 0,
};

/** Sample a layer at key-time `keyIndex`, following roBrowser's renderLayer.
 *  Returns null when the layer draws nothing at this time. */
function sampleLayer(layer: StrLayer, keyIndex: number): Sample | null {
  const anims = layer.animations;
  if (!anims.length) return null;

  let fromId = -1;
  let toId = -1;
  let lastFrame = -1;
  for (let i = 0; i < anims.length; i++) {
    const a = anims[i];
    if (a.frame <= keyIndex) {
      if (a.type === 0) fromId = i;
      else if (a.type === 1) toId = i;
    }
    if (a.frame > lastFrame) lastFrame = a.frame;
  }
  // Not started yet, or finished (past the last key with no velocity active).
  if (fromId < 0 || (toId < 0 && lastFrame < keyIndex)) return null;

  const from = anims[fromId];
  const texcnt = layer.textures.length;

  let posX: number, posY: number, angleRaw: number, aniframe: number;
  let r: number, g: number, b: number, a: number;
  let xy: ArrayLike<number>;

  const to = toId === fromId + 1 && anims[toId].frame === from.frame ? anims[toId] : null;
  if (!to) {
    // Static frame — the snapshot as-is.
    posX = from.pos[0];
    posY = from.pos[1];
    angleRaw = from.angle;
    aniframe = from.aniframe;
    r = from.color[0]; g = from.color[1]; b = from.color[2]; a = from.color[3];
    xy = from.xy;
  } else {
    // Morph: every field drifts by the velocity key × elapsed frames.
    const delta = keyIndex - from.frame;
    posX = from.pos[0] + to.pos[0] * delta;
    posY = from.pos[1] + to.pos[1] * delta;
    angleRaw = from.angle + to.angle * delta;
    r = from.color[0] + to.color[0] * delta;
    g = from.color[1] + to.color[1] * delta;
    b = from.color[2] + to.color[2] * delta;
    a = from.color[3] + to.color[3] * delta;
    for (let i = 0; i < 8; i++) xyTmp[i] = from.xy[i] + to.xy[i] * delta;
    xy = xyTmp;
    switch (to.anitype) {
      case 1: // normal
        aniframe = from.aniframe + to.aniframe * delta;
        break;
      case 2: // stop at end
        aniframe = Math.min(from.aniframe + to.delay * delta, texcnt - 1);
        break;
      case 3: // repeat
        aniframe = texcnt > 0 ? (from.aniframe + to.delay * delta) % texcnt : 0;
        break;
      case 4: // reverse loop
        aniframe = texcnt > 0 ? (from.aniframe - to.delay * delta) % texcnt : 0;
        break;
      default:
        aniframe = from.aniframe;
        break;
    }
  }

  a = clamp01(a / 255);
  if (a <= 0.001) return null; // fully faded — skip the draw

  let texIdx = Math.floor(aniframe);
  if (texIdx < 0) texIdx += texcnt; // reverse loop can go negative
  if (texIdx < 0) texIdx = 0;
  if (texcnt > 0 && texIdx >= texcnt) texIdx = texcnt - 1;

  sampleTmp.posX = posX;
  sampleTmp.posY = posY;
  sampleTmp.xy = xy;
  sampleTmp.angleRaw = angleRaw;
  sampleTmp.r = clamp01(r / 255);
  sampleTmp.g = clamp01(g / 255);
  sampleTmp.b = clamp01(b / 255);
  sampleTmp.a = a;
  sampleTmp.src = from.srcalpha;
  sampleTmp.dst = from.destalpha;
  sampleTmp.texIdx = texIdx;
  return sampleTmp;
}

interface LayerMesh {
  mesh: Mesh;
  material: MeshBasicMaterial;
  geometry: BufferGeometry;
  positions: BufferAttribute;
  layer: StrLayer;
}

export class StrEffect {
  private readonly group = new Group();
  private readonly layers: LayerMesh[] = [];
  private readonly fps: number;
  private readonly maxKey: number;
  private readonly up = new Vector3();
  private readonly right = new Vector3();
  private readonly toCam = new Vector3();

  constructor(private readonly scene: Scene, effect: LoadedStr) {
    this.fps = effect.fps || 60;
    this.maxKey = effect.maxKey;
    for (let li = 0; li < effect.layers.length; li++) {
      const layer = effect.layers[li];
      if (!layer.animations.length) continue; // empty layers draw nothing
      // Quad from the STR's 4 corners (updated per frame). Vertex order mirrors
      // roBrowser's triangle strip: corners 0,1 = top edge, 3,2 = bottom edge
      // (STR y-down → our local y-up flips v). Texcoords are hardcoded 0/1 —
      // the file's uv track is unused, exactly like roBrowser.
      const geometry = new BufferGeometry();
      const positions = new BufferAttribute(new Float32Array(4 * 3), 3);
      positions.setUsage(35048 /* DynamicDrawUsage */);
      geometry.setAttribute("position", positions);
      geometry.setAttribute(
        "uv",
        new BufferAttribute(new Float32Array([0, 1, 1, 1, 0, 0, 1, 0]), 2),
      );
      geometry.setIndex([0, 1, 2, 2, 1, 3]);
      const material = new MeshBasicMaterial({
        map: layer.textures.find((t) => t) ?? null,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        fog: false,
        side: DoubleSide,
        blending: CustomBlending,
        blendEquation: AddEquation,
        blendSrc: SrcAlphaFactor,
        blendDst: OneFactor,
        // Discard fully-transparent texels, mirroring the RO client's alpha test.
        // Effect BMPs carry their colour-keyed background as a real (usually
        // brown/magenta) RGB at alpha 0. Layers that draw with an OPAQUE blend
        // (D3DBLEND ONE/ZERO — e.g. the swinging bell in the "angelus"/Blessing
        // STR) take blendSrc=One, which ignores that alpha and writes the bg RGB
        // across the whole quad → a solid brown square. Additive layers hide the
        // bg for free (alpha 0 contributes nothing), but opaque ones need this.
        // A tiny threshold clips only alpha≈0 texels, leaving soft glow edges.
        alphaTest: 0.01,
      });
      const mesh = new Mesh(geometry, material);
      mesh.frustumCulled = false; // rebuilt every frame; avoid stale-sphere culling
      // Over the character billboard (1), under damage text (100); STR layers
      // draw in file order.
      mesh.renderOrder = 3 + li * 0.01;
      mesh.visible = false;
      this.group.add(mesh);
      this.layers.push({ mesh, material, geometry, positions, layer });
    }
    scene.add(this.group);
  }

  /** Advance to `elapsedMs` since spawn and place every layer quad, facing the
   *  camera, anchored at `anchor` (world space). Returns false once a one-shot
   *  effect has played past maxKey (the caller should dispose it). `loop` keeps
   *  it playing (keyIndex wraps at maxKey) for persistent ground effects — the
   *  caller culls those on its own duration/lifetime. */
  update(elapsedMs: number, camera: PerspectiveCamera, anchor: Vector3, loop = false): boolean {
    let keyIndex = (elapsedMs / 1000) * this.fps;
    if (this.maxKey > 0) {
      if (loop) {
        keyIndex %= this.maxKey;
      } else if (keyIndex >= this.maxKey) {
        for (const l of this.layers) l.mesh.visible = false;
        return false;
      }
    }

    // Camera basis, shared by every layer this frame.
    this.right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    this.toCam.copy(camera.position).sub(anchor).normalize();

    for (const l of this.layers) {
      const s = sampleLayer(l.layer, keyIndex);
      const tex = s ? l.layer.textures[s.texIdx] : null;
      if (!s || !tex || !(tex.image && (tex.image as HTMLImageElement).complete !== false)) {
        l.mesh.visible = false;
        continue;
      }
      l.mesh.visible = true;
      if (l.material.map !== tex) {
        l.material.map = tex;
        l.material.needsUpdate = true;
      }
      l.material.color.setRGB(s.r, s.g, s.b);
      l.material.opacity = s.a;
      // Cast: our lookup covers both src- and dst-valid factors, but three types
      // blendSrc/blendDst as disjoint unions — the D3DBLEND ints only ever pick
      // factors valid for their side.
      l.material.blendSrc = blendFactor(s.src, SrcAlphaFactor) as typeof l.material.blendSrc;
      l.material.blendDst = blendFactor(s.dst, OneFactor) as typeof l.material.blendDst;

      // Corner quad in local (billboard) space: STR x → right (times MIRROR_X),
      // STR y (down) → -up. MIRROR_X un-does roBrowser's view-mirror that our
      // non-mirrored scene lacks (see the constant) — subtle on symmetric effects
      // like Arrow Storm, essential for Crescive Bolt's directional spear.
      const xy = s.xy;
      const arr = l.positions.array as Float32Array;
      arr[0] = MIRROR_X * xy[0] * UNITS_PER_PX; arr[1] = -xy[4] * UNITS_PER_PX; arr[2] = 0;
      arr[3] = MIRROR_X * xy[1] * UNITS_PER_PX; arr[4] = -xy[5] * UNITS_PER_PX; arr[5] = 0;
      arr[6] = MIRROR_X * xy[3] * UNITS_PER_PX; arr[7] = -xy[7] * UNITS_PER_PX; arr[8] = 0;
      arr[9] = MIRROR_X * xy[2] * UNITS_PER_PX; arr[10] = -xy[6] * UNITS_PER_PX; arr[11] = 0;
      l.positions.needsUpdate = true;

      // Orient: face the camera, then spin the quad in-plane. angle stays +θ: the
      // corner MIRROR_X already supplied the reflection that flips its chirality.
      l.mesh.quaternion.copy(camera.quaternion);
      if (s.angleRaw) l.mesh.rotateZ(s.angleRaw * STR_ANGLE_TO_RAD);
      // Place: the layer's pos offset from the anchor pixel (ANCHOR_X/Y). The X
      // offset carries MIRROR_X (distinct from the plain Y-down→Y-up flip below).
      l.mesh.position
        .copy(anchor)
        .addScaledVector(this.right, MIRROR_X * (s.posX - ANCHOR_X) * UNITS_PER_PX)
        .addScaledVector(this.up, (ANCHOR_Y - s.posY) * UNITS_PER_PX)
        .addScaledVector(this.toCam, FRONT_BIAS);
    }
    return true;
  }

  dispose(): void {
    this.scene.remove(this.group);
    for (const l of this.layers) {
      l.material.dispose();
      l.geometry.dispose();
    }
    // Textures are shared/cached in effectAssets; not disposed here.
  }
}
