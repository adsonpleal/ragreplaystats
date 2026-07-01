// The character's movement state: a position in GAT cell coordinates that walks
// a queued path of cells at a fixed speed, exposing the world position (RO
// space, before the scene's Y-flip), the 8-direction sprite facing and whether
// it's moving. No three.js / React — the Simulator drives it each frame and maps
// the result onto the camera + DOM billboard.

import type { Gat } from "./format/gat";
import type { Cell } from "./pathfind";

const SPEED = 6; // cells per second (RO walks ~1 cell / 0.15s; this is brisk)

// Entity facing (0..7, RO/ragassets convention) from a cell-step direction —
// roBrowser's exact lookup, indexed by [sign(dx)+1][sign(dy)+1]. This is the
// *absolute* facing; the displayed sprite frame is (camera.direction + this) % 8.
const DIRECTION = [
  [1, 2, 3],
  [0, 0, 4],
  [7, 6, 5],
];
function dirFromDelta(dx: number, dy: number): number {
  // The scene mirrors X (root scale.x = -1, like RO) and our +Z (gy) points
  // toward the camera at yaw 0 — both opposite to roBrowser's table axes — so
  // flip dx and dy before the lookup.
  const sx = dx > 0 ? -1 : dx < 0 ? 1 : 0;
  const sy = dy > 0 ? -1 : dy < 0 ? 1 : 0;
  return DIRECTION[sx + 1][sy + 1];
}

export class Walker {
  /** Fractional GAT cell position (cell centre = integer + 0.5). */
  px: number;
  py: number;
  dir = 0;
  moving = false;
  private path: Cell[] = [];

  constructor(
    private gat: Gat,
    private cellSize: number,
    spawn: Cell,
    // Cells per second. Defaults to the player's brisk pace; the pet follower
    // walks a touch faster (see sim/pet.ts) so it can close the gap when trailing.
    private speed: number = SPEED,
  ) {
    this.px = spawn.gx + 0.5;
    this.py = spawn.gy + 0.5;
  }

  get cellX(): number {
    return Math.floor(this.px);
  }
  get cellY(): number {
    return Math.floor(this.py);
  }

  setPath(path: Cell[]): void {
    this.path = path;
    this.moving = path.length > 0;
  }

  /** Stop moving and clear the queued path (e.g. when sitting). */
  stop(): void {
    this.path = [];
    this.moving = false;
  }

  /** The 8-direction facing toward a cell (current dir if it's our own cell). */
  dirTo(gx: number, gy: number): number {
    const dx = gx + 0.5 - this.px;
    const dy = gy + 0.5 - this.py;
    return dx !== 0 || dy !== 0 ? dirFromDelta(dx, dy) : this.dir;
  }

  /** Turn to face a cell without moving (sit/dead pose changes facing on click). */
  face(gx: number, gy: number): void {
    this.dir = this.dirTo(gx, gy);
  }

  /** Advance along the path. Returns true while moving. */
  update(dt: number): boolean {
    if (!this.path.length) {
      this.moving = false;
      return false;
    }
    let budget = this.speed * dt;
    while (budget > 0 && this.path.length) {
      const next = this.path[0];
      const tx = next.gx + 0.5;
      const ty = next.gy + 0.5;
      const dx = tx - this.px;
      const dy = ty - this.py;
      const dist = Math.hypot(dx, dy);
      if (dist <= budget) {
        this.px = tx;
        this.py = ty;
        budget -= dist;
        this.path.shift();
        if (dist > 1e-6) this.dir = dirFromDelta(dx, dy);
      } else {
        this.px += (dx / dist) * budget;
        this.py += (dy / dist) * budget;
        this.dir = dirFromDelta(dx, dy);
        budget = 0;
      }
    }
    this.moving = this.path.length > 0;
    return this.moving;
  }

  /** World position in RO space: x/z from the cell grid, y from the GAT height. */
  worldX(): number {
    return this.px * this.cellSize;
  }
  worldZ(): number {
    return this.py * this.cellSize;
  }
  worldY(): number {
    const cx = this.cellX;
    const cy = this.cellY;
    return this.gat.heightAt(cx, cy, this.px - cx, this.py - cy);
  }
}
