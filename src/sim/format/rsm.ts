// RSM (Resource Model) parser — the 3D props placed by the RSW (trees, rocks,
// bridges…). Ported from roBrowserLegacy Loaders/Model.js, which handles 1.x
// through 2.x (tra_fild uses 1.4, 1.5 and one 2.3). This is parse-only: it
// produces a node tree of raw vertices/faces/transforms; render/model.ts turns
// that into three.js meshes (bounding box, node matrices, per-texture groups).
//
// Keyframes (animation) are read only to keep multi-node cursor alignment — the
// renderer draws the static base pose. Texture references are resolved to a flat
// model.textures array of manifest keys; each node's faces index it via the
// node's textureIndexes.

import { BinaryReader, normName } from "./reader";

export const SHADING = { NONE: 0, FLAT: 1, SMOOTH: 2 } as const;

export interface RsmFace {
  vertidx: [number, number, number];
  tvertidx: [number, number, number];
  texid: number;
  smoothGroup: number;
}

export interface RsmNode {
  name: string;
  parentname: string;
  /** Indices into RSM.textures (manifest keys). */
  textureIndexes: number[];
  mat3: number[]; // 3×3, row-major
  offset: [number, number, number];
  pos: [number, number, number];
  rotangle: number;
  rotaxis: [number, number, number];
  scale: [number, number, number];
  /** Mirror applied for 2.2+ models (else [1,1,1]). */
  flip: [number, number, number];
  vertices: [number, number, number][];
  /** Interleaved [r,g,b,a,u,v] per texture vertex (colour unused, u/v adjusted). */
  tvertices: Float32Array;
  faces: RsmFace[];
}

export class Rsm {
  readonly version: number;
  readonly shadeType: number;
  readonly alpha: number;
  readonly textures: string[]; // manifest keys
  readonly nodes: RsmNode[];
  readonly mainNode: RsmNode;

  constructor(buffer: ArrayBuffer) {
    const fp = new BinaryReader(buffer);
    const header = fp.str(4);
    if (header !== "GRSM" && header !== "GRSX") throw new Error("RSM: invalid header");
    const version = (this.version = fp.i8() + fp.i8() / 10);
    fp.i32(); // animLen
    this.shadeType = fp.i32();
    this.alpha = version >= 1.4 ? fp.u8() / 255 : 1;

    // Top-level texture list (varies by version) + main-node name for <2.2.
    const topTextures: string[] = [];
    let mainNodeName: string | null = null;
    if (version >= 2.3) {
      fp.f32(); // frame rate
      const c = fp.u32();
      for (let i = 0; i < c; i++) topTextures.push(normName(fp.lstr()));
    } else if (version >= 2.2) {
      fp.f32();
      const ac = fp.u32();
      for (let i = 0; i < ac; i++) topTextures.push(normName(fp.lstr()));
      const c = fp.u32();
      for (let i = 0; i < c; i++) topTextures.push(normName(fp.lstr()));
    } else {
      fp.seek(16); // reserved
      const c = fp.u32();
      for (let i = 0; i < c; i++) topTextures.push(normName(fp.str(40)));
      mainNodeName = fp.str(40);
    }

    // Nodes. For >=2.3 textures are per-node names; we collect them into a flat
    // list and rewrite each node's indices to point at it. For <2.2 the node
    // texture entries are already indices into topTextures.
    const flat = [...topTextures];
    const indexOf = (name: string) => {
      const i = flat.indexOf(name);
      return i === -1 ? flat.push(name) - 1 : i;
    };

    const nodeCount = fp.u32();
    this.nodes = new Array(nodeCount);
    for (let n = 0; n < nodeCount; n++) {
      this.nodes[n] = this.readNode(fp, version, indexOf);
    }

    this.textures = flat;
    this.mainNode =
      this.nodes.find((nd) => nd.name === mainNodeName) ?? this.nodes[0];
  }

  private readNode(
    fp: BinaryReader,
    version: number,
    indexOf: (name: string) => number,
  ): RsmNode {
    const name = version >= 2.2 ? fp.lstr() : fp.str(40);
    const parentname = version >= 2.2 ? fp.lstr() : fp.str(40);

    const texCount = fp.u32();
    const textureIndexes: number[] = new Array(texCount);
    for (let i = 0; i < texCount; i++) {
      textureIndexes[i] = version >= 2.3 ? indexOf(normName(fp.lstr())) : fp.i32();
    }

    const mat3 = [fp.f32(), fp.f32(), fp.f32(), fp.f32(), fp.f32(), fp.f32(), fp.f32(), fp.f32(), fp.f32()];
    const offset: [number, number, number] = [fp.f32(), fp.f32(), fp.f32()];

    let pos: [number, number, number] = [0, 0, 0];
    let rotangle = 0;
    let rotaxis: [number, number, number] = [0, 0, 0];
    let scale: [number, number, number] = [1, 1, 1];
    let flip: [number, number, number] = [1, 1, 1];
    if (version >= 2.2) {
      flip = [1, -1, 1];
    } else {
      pos = [fp.f32(), fp.f32(), fp.f32()];
      rotangle = fp.f32();
      rotaxis = [fp.f32(), fp.f32(), fp.f32()];
      scale = [fp.f32(), fp.f32(), fp.f32()];
    }

    const vertCount = fp.u32();
    const vertices: [number, number, number][] = new Array(vertCount);
    for (let i = 0; i < vertCount; i++) vertices[i] = [fp.f32(), fp.f32(), fp.f32()];

    const tvCount = fp.u32();
    const tvertices = new Float32Array(tvCount * 6);
    for (let i = 0, j = 0; i < tvCount; i++, j += 6) {
      if (version >= 1.2) {
        tvertices[j + 0] = fp.u8() / 255;
        tvertices[j + 1] = fp.u8() / 255;
        tvertices[j + 2] = fp.u8() / 255;
        tvertices[j + 3] = fp.u8() / 255;
      }
      tvertices[j + 4] = fp.f32() * 0.98 + 0.01;
      tvertices[j + 5] = fp.f32() * 0.98 + 0.01;
    }

    const faceCount = fp.u32();
    const faces: RsmFace[] = new Array(faceCount);
    for (let i = 0; i < faceCount; i++) {
      const len = version >= 2.2 ? fp.i32() : -1;
      const vertidx: [number, number, number] = [fp.u16(), fp.u16(), fp.u16()];
      const tvertidx: [number, number, number] = [fp.u16(), fp.u16(), fp.u16()];
      const texid = fp.u16();
      fp.u16(); // padding
      fp.i32(); // two-sided
      let smoothGroup = 0;
      if (version >= 1.2) {
        smoothGroup = fp.i32();
        if (len > 24) fp.i32();
        if (len > 28) fp.i32();
        if (len > 32) fp.seek(len - 32);
      }
      faces[i] = { vertidx, tvertidx, texid, smoothGroup };
    }

    // Keyframes — skipped, but read counts to stay aligned with the next node.
    // The block order/size changed across versions:
    //   < 2.2 : [scale (1.6+)] → pos (1.5+, 16B) → rot          (legacy/original)
    //   >= 2.2: scale → rot → pos (20B)
    // Missing the 1.5-era pos block was corrupting multi-node 1.5 models
    // (e.g. prontera_re/woodbox_s_02 sampled the wrong atlas region).
    if (version >= 1.6) {
      const sc = fp.u32();
      fp.seek(sc * 20); // scale keyframes: frame i32 + scale 3f + data f
    }
    if (version >= 1.5 && version < 2.2) {
      const pc = fp.u32();
      fp.seek(pc * 16); // old pos keyframes: frame i32 + pos 3f
    }
    const rc = fp.u32();
    fp.seek(rc * 20); // rot keyframes: frame i32 + quat 4f
    if (version >= 2.2) {
      const pc = fp.u32();
      fp.seek(pc * 20); // pos keyframes: frame i32 + pos 3f + data i32
    }
    if (version >= 2.3) {
      const g = fp.u32();
      for (let i = 0; i < g; i++) {
        fp.i32(); // texture id
        const anims = fp.u32();
        for (let a = 0; a < anims; a++) {
          fp.i32(); // type
          const frames = fp.u32();
          fp.seek(frames * 8); // frame i32 + offset f32
        }
      }
    }

    return { name, parentname, textureIndexes, mat3, offset, pos, rotangle, rotaxis, scale, flip, vertices, tvertices, faces };
  }
}
