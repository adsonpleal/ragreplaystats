// A* over GAT walkable cells, 8-directional like RO. Diagonal steps are only
// allowed when both orthogonally-adjacent cells are also walkable (no cutting
// through wall corners). Framework-free and pure so it can be unit-tested.

export interface Cell {
  gx: number;
  gy: number;
}

interface Grid {
  width: number;
  height: number;
  isWalkable(gx: number, gy: number): boolean;
}

const SQRT2 = Math.SQRT2;
const NEIGHBORS: [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/** Path from `start` (exclusive) to `goal` (inclusive). Empty if unreachable or
 *  the goal isn't walkable. `maxNodes` bounds the search so a click into a large
 *  sealed-off region can't hang the frame. */
export function findPath(grid: Grid, start: Cell, goal: Cell, maxNodes = 20000): Cell[] {
  if (!grid.isWalkable(goal.gx, goal.gy)) return [];
  if (start.gx === goal.gx && start.gy === goal.gy) return [];

  const key = (x: number, y: number) => y * grid.width + x;
  const open = new Map<number, { x: number; y: number; g: number; f: number }>();
  const came = new Map<number, number>();
  const gScore = new Map<number, number>();
  const closed = new Set<number>();

  const startK = key(start.gx, start.gy);
  open.set(startK, { x: start.gx, y: start.gy, g: 0, f: heuristic(start, goal) });
  gScore.set(startK, 0);

  let visited = 0;
  while (open.size && visited++ < maxNodes) {
    // Pop the lowest-f open node (linear scan — fine for one small map).
    let bestK = -1;
    let best = Infinity;
    for (const [k, n] of open) {
      if (n.f < best) { best = n.f; bestK = k; }
    }
    const cur = open.get(bestK)!;
    open.delete(bestK);
    closed.add(bestK);

    if (cur.x === goal.gx && cur.y === goal.gy) {
      return groupDiagonals(grid, start, reconstruct(came, bestK, grid.width));
    }

    for (const [dx, dy] of NEIGHBORS) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      if (!grid.isWalkable(nx, ny)) continue;
      // Prevent diagonal corner-cutting.
      if (dx !== 0 && dy !== 0) {
        if (!grid.isWalkable(cur.x + dx, cur.y) || !grid.isWalkable(cur.x, cur.y + dy)) continue;
      }
      const nk = key(nx, ny);
      if (closed.has(nk)) continue;
      const tentative = cur.g + (dx !== 0 && dy !== 0 ? SQRT2 : 1);
      if (tentative < (gScore.get(nk) ?? Infinity)) {
        came.set(nk, bestK);
        gScore.set(nk, tentative);
        open.set(nk, { x: nx, y: ny, g: tentative, f: tentative + heuristic({ gx: nx, gy: ny }, goal) });
      }
    }
  }
  return [];
}

// Reorder a path so diagonal steps come before cardinal ones within each
// obstacle-free run — the shape RO uses, so a diagonal walk plays one continuous
// diagonal animation instead of staircasing (which flickers the facing every
// cell). A cardinal step immediately followed by a diagonal one (A→B→C) is
// swapped to diagonal-then-cardinal (A→B'→C, B' = A + (C−B)) when B' is walkable
// and the new diagonal doesn't cut a wall corner; repeated until stable. Same
// length and endpoints, so still a shortest path.
function groupDiagonals(grid: Grid, start: Cell, path: Cell[]): Cell[] {
  if (path.length < 2) return path;
  const cells = [start, ...path];
  const isDiag = (a: Cell, b: Cell) => a.gx !== b.gx && a.gy !== b.gy;
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i + 2 < cells.length; i++) {
      const a = cells[i];
      const b = cells[i + 1];
      const c = cells[i + 2];
      if (isDiag(a, b) || !isDiag(b, c)) continue; // only cardinal-then-diagonal
      const bx = a.gx + (c.gx - b.gx);
      const by = a.gy + (c.gy - b.gy);
      // B' walkable and the new diagonal A→B' doesn't cut a corner.
      if (!grid.isWalkable(bx, by) || !grid.isWalkable(bx, a.gy) || !grid.isWalkable(a.gx, by)) continue;
      cells[i + 1] = { gx: bx, gy: by };
      changed = true;
    }
  }
  cells.shift(); // drop the start cell
  return cells;
}

// Octile distance.
function heuristic(a: Cell, b: Cell): number {
  const dx = Math.abs(a.gx - b.gx);
  const dy = Math.abs(a.gy - b.gy);
  return Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy);
}

function reconstruct(came: Map<number, number>, goalK: number, width: number): Cell[] {
  const path: Cell[] = [];
  let k: number | undefined = goalK;
  while (k !== undefined) {
    path.push({ gx: k % width, gy: Math.floor(k / width) });
    k = came.get(k);
  }
  path.reverse();
  path.shift(); // drop the start cell
  return path;
}
