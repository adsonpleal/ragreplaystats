// GND (Ground) parser — the visible textured ground mesh. Ported from roBrowser
// Loaders/Ground.js, but instead of packing every texture into one atlas we emit
// one vertex group per texture name (we ship the textures as individual PNGs and
// let three.js use one material each). Output is plain typed data; scene.ts wraps
// it into geometry. World coordinates follow roBrowser: a tile at (x,y) spans
// (x*2 … (x+1)*2) on X/Z, with height = stored value / 5.
//
// Each emitted vertex is interleaved [x, y, z, u, v, r, g, b, lu, lv] (position,
// texture coord, baked tile colour 0..1, lightmap atlas coord). The lightmap
// carries RO's baked per-pixel shadows from 3D objects; scene.ts feeds it to the
// material's lightMap (channel 1 / uv1). Normals are computed by three.js.

import { BinaryReader, normName } from "./reader";

interface Tile {
  u: [number, number, number, number];
  v: [number, number, number, number];
  texture: number;
  light: number; // lightmap atlas index
  color: [number, number, number];
}
interface Surface {
  height: [number, number, number, number];
  tileUp: number;
  tileFront: number;
  tileRight: number;
}

/** Vertices for one texture, ready to upload as a BufferGeometry group. */
export interface GroundGroup {
  texture: string; // manifest key (normalized)
  vertices: Float32Array; // interleaved [x,y,z,u,v,r,g,b,lu,lv]
}

/** A flat water quad grid at `level` (only where ground sits above the water). */
export interface WaterMesh {
  vertices: Float32Array; // interleaved [x,y,z,u,v]
}

/** The baked lightmap as an RGBA atlas. Each RO lightmap cell is 8×8 with 64
 *  brightness bytes (the shadow map) then 64×3 colour bytes (the baked coloured
 *  light — torches, lamps, coloured ambience). We pack A = brightness (shadow,
 *  multiplied) and RGB = colour (added), so the shader can reproduce RO's
 *  `ground = base × lightmap.a + lightmap.rgb` (see render/scene.ts). */
export interface Lightmap {
  data: Uint8Array; // RGBA, width*height*4 — A = shadow, RGB = coloured light
  width: number;
  height: number;
}

const STRIDE = 10;
const LM_CELL = 8; // RO lightmap cell is 8×8 pixels

export class Gnd {
  readonly width: number;
  readonly height: number;
  readonly textures: string[];
  private tiles: Tile[];
  private surfaces: Surface[];
  // Raw lightmap: `count` cells, each 8×8 with 64 brightness bytes then 64×3 RGB.
  private lm: { raw: Uint8Array; count: number; cols: number; rows: number } | null = null;

  constructor(buffer: ArrayBuffer) {
    const fp = new BinaryReader(buffer);
    if (fp.str(4) !== "GRGN") throw new Error("GND: invalid header (expected GRGN)");
    fp.u8();
    fp.u8(); // version
    this.width = fp.u32();
    this.height = fp.u32();
    fp.f32(); // zoom

    // Textures
    const count = fp.u32();
    const length = fp.u32();
    this.textures = [];
    for (let i = 0; i < count; i++) this.textures.push(normName(fp.str(length)));

    // Lightmaps: count cells of perCell brightness bytes + perCell×3 colour bytes.
    const lmCount = fp.u32();
    const perCellX = fp.i32();
    const perCellY = fp.i32();
    const sizeCell = fp.i32();
    const perCell = perCellX * perCellY * sizeCell; // 64
    const raw = fp.bytesView(lmCount * perCell * 4); // count × (64 + 64×3) bytes
    if (lmCount > 0) {
      const cols = Math.ceil(Math.sqrt(lmCount));
      const rows = Math.ceil(lmCount / cols);
      this.lm = { raw, count: lmCount, cols, rows };
    }

    // Tiles
    const tileCount = fp.u32();
    this.tiles = new Array(tileCount);
    for (let i = 0; i < tileCount; i++) {
      const u: [number, number, number, number] = [fp.f32(), fp.f32(), fp.f32(), fp.f32()];
      const v: [number, number, number, number] = [fp.f32(), fp.f32(), fp.f32(), fp.f32()];
      const texture = fp.u16();
      const light = fp.u16();
      const color: [number, number, number] = [fp.u8() / 255, fp.u8() / 255, fp.u8() / 255];
      fp.u8(); // alpha (unused)
      this.tiles[i] = { u, v, texture, light, color };
    }

    // Surfaces (one per tile cell)
    const surfCount = this.width * this.height;
    this.surfaces = new Array(surfCount);
    for (let i = 0; i < surfCount; i++) {
      this.surfaces[i] = {
        height: [fp.f32() / 5, fp.f32() / 5, fp.f32() / 5, fp.f32() / 5],
        tileUp: fp.i32(),
        tileFront: fp.i32(),
        tileRight: fp.i32(),
      };
    }
  }

  /** Per-corner lightmap atlas UVs for a tile (1-texel inset to avoid bleeding
   *  into neighbouring cells, like roBrowser). Order matches the tile's corners:
   *  0=(x,y) 1=(x+1,y) 2=(x,y+1) 3=(x+1,y+1). */
  private lmUv(light: number): { lu: number[]; lv: number[] } {
    if (!this.lm) return { lu: [0, 0, 0, 0], lv: [0, 0, 0, 0] };
    const { cols, rows } = this.lm;
    const w = cols * LM_CELL;
    const h = rows * LM_CELL;
    const cx = (light % cols) * LM_CELL;
    const cy = Math.floor(light / cols) * LM_CELL;
    const u1 = (cx + 1) / w;
    const u2 = (cx + 7) / w;
    const v1 = (cy + 1) / h;
    const v2 = (cy + 7) / h;
    return { lu: [u1, u2, u1, u2], lv: [v1, v1, v2, v2] };
  }

  /** The lightmap as an RGBA atlas (A = shadow brightness, RGB = baked coloured
   *  light), or null if the map has none. Cell `i` occupies pixels [col*8…]
   *  [row*8…] in a cols×rows grid. Per cell: 64 brightness bytes, then 64×3 RGB. */
  lightmapAtlas(): Lightmap | null {
    if (!this.lm) return null;
    const { raw, count, cols, rows } = this.lm;
    const width = cols * LM_CELL;
    const height = rows * LM_CELL;
    const data = new Uint8Array(width * height * 4);
    const COLOR_OFF = LM_CELL * LM_CELL; // colour bytes follow the 64 brightness bytes
    for (let i = 0; i < count; i++) {
      const cx = (i % cols) * LM_CELL;
      const cy = Math.floor(i / cols) * LM_CELL;
      const src = i * LM_CELL * LM_CELL * 4; // 256 bytes per cell (64 + 64×3)
      for (let py = 0; py < LM_CELL; py++) {
        for (let px = 0; px < LM_CELL; px++) {
          const texel = px + py * LM_CELL;
          const c = src + COLOR_OFF + texel * 3;
          const o = ((cy + py) * width + (cx + px)) * 4;
          data[o] = raw[c]; // R \
          data[o + 1] = raw[c + 1]; // G  } baked coloured light (added)
          data[o + 2] = raw[c + 2]; // B /
          data[o + 3] = raw[src + texel]; // A = brightness / shadow (multiplied)
        }
      }
    }
    return { data, width, height };
  }

  /** Build per-texture ground geometry + the water quad grid. A tile gets a water
   *  quad when any corner is at/below the water surface — roBrowser's test, with
   *  RO's down-positive heights: `corner > level - waveHeight`. */
  compile(waterLevel: number, waveHeight = 0): { ground: GroundGroup[]; water: WaterMesh } {
    const { width, height, tiles, surfaces, textures } = this;
    const groups = new Map<string, number[]>();
    const water: number[] = [];

    const push = (texIdx: number, verts: number[]) => {
      const name = textures[texIdx] ?? "";
      let arr = groups.get(name);
      if (!arr) groups.set(name, (arr = []));
      for (const n of verts) arr.push(n);
    };

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const cell = surfaces[x + y * width];
        const h = cell.height;

        if (cell.tileUp > -1) {
          const t = tiles[cell.tileUp];
          const [r, g, b] = t.color;
          // Flip V: textures load with three's flipY (bottom-up), but RO tile UVs
          // use an image-top origin — same fix as the models, so cliff faces line
          // up with the ground above them instead of reading upside-down.
          const fv = [1 - t.v[0], 1 - t.v[1], 1 - t.v[2], 1 - t.v[3]];
          const { lu, lv } = this.lmUv(t.light);
          push(t.texture, [
            (x + 0) * 2, h[0], (y + 0) * 2, t.u[0], fv[0], r, g, b, lu[0], lv[0],
            (x + 1) * 2, h[1], (y + 0) * 2, t.u[1], fv[1], r, g, b, lu[1], lv[1],
            (x + 1) * 2, h[3], (y + 1) * 2, t.u[3], fv[3], r, g, b, lu[3], lv[3],
            (x + 1) * 2, h[3], (y + 1) * 2, t.u[3], fv[3], r, g, b, lu[3], lv[3],
            (x + 0) * 2, h[2], (y + 1) * 2, t.u[2], fv[2], r, g, b, lu[2], lv[2],
            (x + 0) * 2, h[0], (y + 0) * 2, t.u[0], fv[0], r, g, b, lu[0], lv[0],
          ]);

          const wt = waterLevel - waveHeight;
          if (h[0] > wt || h[1] > wt || h[2] > wt || h[3] > wt) {
            water.push(
              (x + 0) * 2, waterLevel, (y + 0) * 2, (x % 5) / 5, (y % 5) / 5,
              (x + 1) * 2, waterLevel, (y + 0) * 2, ((x + 1) % 5) / 5 || 1, (y % 5) / 5,
              (x + 1) * 2, waterLevel, (y + 1) * 2, ((x + 1) % 5) / 5 || 1, ((y + 1) % 5) / 5 || 1,
              (x + 1) * 2, waterLevel, (y + 1) * 2, ((x + 1) % 5) / 5 || 1, ((y + 1) % 5) / 5 || 1,
              (x + 0) * 2, waterLevel, (y + 1) * 2, (x % 5) / 5, ((y + 1) % 5) / 5 || 1,
              (x + 0) * 2, waterLevel, (y + 0) * 2, (x % 5) / 5, (y % 5) / 5,
            );
          }
        }

        if (cell.tileFront > -1 && y + 1 < height) {
          const t = tiles[cell.tileFront];
          const [r, g, b] = t.color;
          const fv = [1 - t.v[0], 1 - t.v[1], 1 - t.v[2], 1 - t.v[3]];
          const { lu, lv } = this.lmUv(t.light);
          const hb = surfaces[x + (y + 1) * width].height;
          push(t.texture, [
            (x + 0) * 2, hb[0], (y + 1) * 2, t.u[2], fv[2], r, g, b, lu[2], lv[2],
            (x + 1) * 2, h[3], (y + 1) * 2, t.u[1], fv[1], r, g, b, lu[1], lv[1],
            (x + 1) * 2, hb[1], (y + 1) * 2, t.u[3], fv[3], r, g, b, lu[3], lv[3],
            (x + 0) * 2, hb[0], (y + 1) * 2, t.u[2], fv[2], r, g, b, lu[2], lv[2],
            (x + 1) * 2, h[3], (y + 1) * 2, t.u[1], fv[1], r, g, b, lu[1], lv[1],
            (x + 0) * 2, h[2], (y + 1) * 2, t.u[0], fv[0], r, g, b, lu[0], lv[0],
          ]);
        }

        if (cell.tileRight > -1 && x + 1 < width) {
          const t = tiles[cell.tileRight];
          const [r, g, b] = t.color;
          const fv = [1 - t.v[0], 1 - t.v[1], 1 - t.v[2], 1 - t.v[3]];
          const { lu, lv } = this.lmUv(t.light);
          const hb = surfaces[x + 1 + y * width].height;
          push(t.texture, [
            (x + 1) * 2, h[1], (y + 0) * 2, t.u[1], fv[1], r, g, b, lu[1], lv[1],
            (x + 1) * 2, h[3], (y + 1) * 2, t.u[0], fv[0], r, g, b, lu[0], lv[0],
            (x + 1) * 2, hb[0], (y + 0) * 2, t.u[3], fv[3], r, g, b, lu[3], lv[3],
            (x + 1) * 2, hb[0], (y + 0) * 2, t.u[3], fv[3], r, g, b, lu[3], lv[3],
            (x + 1) * 2, hb[2], (y + 1) * 2, t.u[2], fv[2], r, g, b, lu[2], lv[2],
            (x + 1) * 2, h[3], (y + 1) * 2, t.u[0], fv[0], r, g, b, lu[0], lv[0],
          ]);
        }
      }
    }

    const ground: GroundGroup[] = [];
    for (const [texture, arr] of groups) {
      if (arr.length) ground.push({ texture, vertices: new Float32Array(arr) });
    }
    return { ground, water: { vertices: new Float32Array(water) } };
  }
}

export { STRIDE as GROUND_STRIDE };
