// GAT (Ground Altitude) parser — the per-cell walkability + height grid the
// character navigates. A GAT is 2× the GND tile resolution (so for tra_fild's
// 100×100 GND it's 200×200 cells, one cell = 1 world unit). Each cell stores 4
// corner heights and a terrain type. Ported from roBrowser Loaders/Altitude.js.
//
// Heights are scaled by 0.2 to match the GND world scale (GND stores height/5).

import { BinaryReader } from "./reader";

// Cell terrain type → walkable? (athena's map.c table, via roBrowser.)
//   0 walkable · 1 non-walkable · 2 walkable · 3 walkable water · 4 walkable
//   5 snipable-only (cliff) · 6 walkable
const WALKABLE_TYPES = new Set([0, 2, 3, 4, 6]);

export class Gat {
  readonly width: number;
  readonly height: number;
  /** 4 corner heights per cell (SW, SE, NW, NE), row-major, ×0.2. */
  readonly heights: Float32Array;
  /** Raw terrain type per cell, row-major. */
  readonly types: Uint8Array;

  constructor(buffer: ArrayBuffer) {
    const fp = new BinaryReader(buffer);
    if (fp.str(4) !== "GRAT") throw new Error("GAT: invalid header (expected GRAT)");
    fp.u8();
    fp.u8(); // version major.minor
    this.width = fp.u32();
    this.height = fp.u32();

    const count = this.width * this.height;
    this.heights = new Float32Array(count * 4);
    this.types = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      this.heights[i * 4 + 0] = fp.f32() * 0.2;
      this.heights[i * 4 + 1] = fp.f32() * 0.2;
      this.heights[i * 4 + 2] = fp.f32() * 0.2;
      this.heights[i * 4 + 3] = fp.f32() * 0.2;
      this.types[i] = fp.u32() & 0xff;
    }
  }

  inBounds(gx: number, gy: number): boolean {
    return gx >= 0 && gy >= 0 && gx < this.width && gy < this.height;
  }

  typeAt(gx: number, gy: number): number {
    return this.inBounds(gx, gy) ? this.types[gy * this.width + gx] : 1;
  }

  isWalkable(gx: number, gy: number): boolean {
    return this.inBounds(gx, gy) && WALKABLE_TYPES.has(this.types[gy * this.width + gx]);
  }

  /** Bilinearly-interpolated terrain height at a fractional position within cell
   *  (gx, gy). `fx`/`fy` default to the cell centre. */
  heightAt(gx: number, gy: number, fx = 0.5, fy = 0.5): number {
    if (!this.inBounds(gx, gy)) return 0;
    const o = (gy * this.width + gx) * 4;
    const sw = this.heights[o + 0];
    const se = this.heights[o + 1];
    const nw = this.heights[o + 2];
    const ne = this.heights[o + 3];
    const bottom = sw + (se - sw) * fx;
    const top = nw + (ne - nw) * fx;
    return bottom + (top - bottom) * fy;
  }
}
