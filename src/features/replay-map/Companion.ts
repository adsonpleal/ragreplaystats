// The player's summoned companions (Ranger/Windhawk falcon + warg) in the map
// viewer. They aren't replay entities — no packets of their own; they're driven
// off the owner each frame while the owner's OPTION carries the FALCON / WUG bit.
//
//   Warg — follows like a PET (mirrors latamvisuais' sim/pet.ts): its own Walker
//   paths toward a cell beside the owner, idles when close, and teleports when
//   the owner outruns it. It trails and catches up, it isn't glued to the player.
//
//   Falcon — hovers above the owner's head, always flapping (the hawk's idle),
//   with a gentle bob, tracking the player. Like roBrowser it isn't flown on a
//   wide code-orbit; the sprite's animation is the motion.
//
// Sprites come from ragassets by mob id: 20830 -> the Windhawk hawk
// (data\sprite\이팩트\windhawk_hawk), 20833 -> the Windhawk warg (windhawk_wolf).

import { type PerspectiveCamera, type Scene, Vector3 } from "three";
import { type ApngInfo, fetchApngInfo, frameAt } from "../../sim/apng";
import { loadImage } from "../../sim/imageCache";
import { findPath } from "../../sim/pathfind";
import { Character } from "../../sim/render/character";
import type { World } from "../../sim/render/scene";
import { MOB_SPRITE, mobFrameProbeUrl, mobFrameUrl } from "../../sim/ragassets";
import { MOB_ATTACK, SPRITE_IDLE, SPRITE_WALK } from "../../sim/sprite";
import { Walker } from "../../sim/walker";

/** Windhawk companion sprite ids (ragassets → windhawk_hawk / windhawk_wolf). */
export const FALCON_VIEW = 20830;
export const WARG_VIEW = 20833;

export type CompanionKind = "falcon" | "warg";

/** What the owning player looks like this frame: their GAT cell, scene feet,
 *  facing direction (0–7), and whether they're walking — the falcon faces the
 *  same way as its owner, and a ridden warg walks/idles in sync with them. */
export type OwnerState = {
  cellX: number;
  cellY: number;
  feet: Vector3;
  dir: number;
  moving: boolean;
};

/** A companion-skill target this frame (Warg Strike, Aerial Dive, …): the warg
 *  lunges to the enemy and bites, the falcon dives at it. Passed while the strike
 *  is active; cleared afterwards so the companion returns to the player. */
export type AttackTarget = { cellX: number; cellY: number; feet: Vector3 };

// Warg follow, in cells (mirrors latamvisuais' Pet): chase once the owner pulls
// FOLLOW_FAR away, keep walking until back within FOLLOW_NEAR (the gap stops a
// walk↔idle flicker at the boundary), teleport when they outrun it. A little
// faster than the player so a trailing warg can close the gap. FOLLOW_FAR is
// kept tight (2 cells) so the warg walks right beside the player like in-game,
// rather than trailing several cells back before catching up.
const FOLLOW_NEAR = 1;
const FOLLOW_FAR = 2;
const TELEPORT_AT = 14;
const WARG_SPEED = 7.5;
const NEIGHBORS: ReadonlyArray<readonly [number, number]> = [
  [0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [-1, 1], [1, -1], [1, 1],
];

// Falcon: floats this far above the owner's feet, bobbing (scene "up" is +y).
// Kept low so it sits right over the head, like the client — not way overhead.
const FALCON_HEIGHT = 4.7;
const FALCON_BOB = 0.5;
const FALCON_BOB_SPEED = 3.4;
// The falcon's hover point chases the owner with a lag (exponential smoothing,
// frame-rate independent): while the player walks the hawk drifts behind them,
// and it catches up once they stop. Lower = more trailing; higher = tighter.
const FALCON_LAG_RATE = 6;

// A ridden warg is drawn at the rider's own ground point, so it needs a smaller
// line-of-sight pull than the default (Character.FRONT_BIAS = 2.5) — that seats
// the warg behind the rider in depth so the player draws on top of their mount
// instead of being covered by it.
const MOUNT_FRONT_BIAS = 1;

// Companion-skill lunge: the warg dashes straight at the enemy (cells/sec, faster
// than its follow pace so it reaches within the strike window) and bites once
// adjacent. The falcon swoops from its hover down toward the target and back.
const DASH_SPEED = 16;
const FALCON_DIVE_RATE = 7; // how fast the falcon closes on the target (exp smoothing)
const FALCON_DIVE_HEIGHT = 1.8; // it drops from head-height to just over the enemy

const chebyshev = (ax: number, ay: number, bx: number, by: number): number =>
  Math.max(Math.abs(ax - bx), Math.abs(ay - by));

export class Companion {
  private readonly billboard: Character;
  private frames: HTMLImageElement[] = [];
  private aInfo: ApngInfo = { count: 1, delays: [] };
  private readonly frameInfo = new Map<number, ApngInfo>();
  private aAction = -1;
  private aDir = -1;
  private aClock = 0;
  private readonly feet = new Vector3();
  // Warg follower state (null for the falcon).
  private readonly walker: Walker | null;
  private following = false;
  private lastGoal = "";
  // Warg riding: when the owner's OPTION has WUGRIDER the warg stops pet-following
  // and locks under the rider (mount), walking/idling in sync with them.
  private mounted = false;
  // Falcon bob phase + the lagging hover point that trails the owner.
  private bobT = Math.random() * Math.PI * 2;
  private readonly hoverPos = new Vector3();
  private hoverInit = false;

  constructor(
    scene: Scene,
    private readonly world: World,
    private readonly view: number,
    kind: CompanionKind,
    near: { gx: number; gy: number },
  ) {
    this.billboard = new Character(scene, MOB_SPRITE);
    this.billboard.setVisible(false);
    this.walker =
      kind === "warg"
        ? new Walker(world.gat, world.cellSize, this.spotNear(near, near), WARG_SPEED)
        : null;
    void this.probe();
  }

  private async probe(): Promise<void> {
    // The warg also bites on a strike (MOB_ATTACK); the falcon dives with its
    // idle flap, so it doesn't need the attack pose.
    const actions = this.walker ? [SPRITE_IDLE, SPRITE_WALK, MOB_ATTACK] : [SPRITE_IDLE, SPRITE_WALK];
    await Promise.all(
      actions.map(async (a) => {
        this.frameInfo.set(a, await fetchApngInfo(mobFrameProbeUrl(this.view, a)));
      }),
    );
    this.aAction = -1; // force a rebuild against the real frame counts
  }

  update(
    dtSec: number,
    owner: OwnerState,
    camDir: number,
    camera: PerspectiveCamera,
    attack?: AttackTarget,
  ): void {
    let action: number;
    let spriteDir: number;
    let frontBias: number | undefined;
    if (this.walker && attack && !this.mounted) {
      // Warg Strike — lunge straight at the enemy and bite. Move the walker's
      // position directly (a fast dash, no A* — it's a short pounce) toward a
      // cell beside the target, biting once adjacent. When the strike ends the
      // pet-follow takes over and walks it back to the player.
      const w = this.walker;
      const goal = this.spotNear({ gx: attack.cellX, gy: attack.cellY }, { gx: w.cellX, gy: w.cellY });
      const dx = goal.gx + 0.5 - w.px;
      const dy = goal.gy + 0.5 - w.py;
      const dist = Math.hypot(dx, dy);
      const step = DASH_SPEED * dtSec;
      if (dist > 1e-3) {
        const move = Math.min(step, dist);
        w.px += (dx / dist) * move;
        w.py += (dy / dist) * move;
      }
      w.stop(); // drop any queued follow path
      w.face(attack.cellX, attack.cellY);
      this.lastGoal = "";
      action = chebyshev(w.cellX, w.cellY, attack.cellX, attack.cellY) <= 1 ? MOB_ATTACK : SPRITE_WALK;
      spriteDir = w.dir;
      this.feet.set(-w.worldX(), -w.worldY(), w.worldZ());
    } else if (!this.walker && attack) {
      // Aerial Dive — swoop from the hover down toward the enemy, then the return
      // (below) glides it back over the player once the strike ends.
      this.bobT += dtSec * FALCON_BOB_SPEED;
      if (!this.hoverInit) {
        this.hoverPos.copy(owner.feet);
        this.hoverInit = true;
      }
      const a = 1 - Math.exp(-dtSec * FALCON_DIVE_RATE);
      this.hoverPos.x += (attack.feet.x - this.hoverPos.x) * a;
      this.hoverPos.z += (attack.feet.z - this.hoverPos.z) * a;
      this.feet.set(
        this.hoverPos.x,
        attack.feet.y + FALCON_DIVE_HEIGHT + Math.sin(this.bobT) * FALCON_BOB,
        this.hoverPos.z,
      );
      action = SPRITE_IDLE;
      spriteDir = owner.dir;
    } else if (this.walker && this.mounted) {
      // Ridden warg — the mount: locked under the rider, facing the same way and
      // walking when they walk. Keep the walker parked on the rider's cell so it
      // doesn't dash off pathing when they dismount.
      this.walker.stop();
      this.walker.px = owner.cellX + 0.5;
      this.walker.py = owner.cellY + 0.5;
      this.feet.copy(owner.feet);
      action = owner.moving ? SPRITE_WALK : SPRITE_IDLE;
      spriteDir = owner.dir;
      frontBias = MOUNT_FRONT_BIAS; // seat the warg behind the rider
    } else if (this.walker) {
      // Warg companion — trail the player like a pet, drawn at its own walked cell.
      this.follow(owner);
      this.walker.update(dtSec);
      action = this.walker.moving ? SPRITE_WALK : SPRITE_IDLE;
      spriteDir = this.walker.dir;
      this.feet.set(-this.walker.worldX(), -this.walker.worldY(), this.walker.worldZ());
    } else {
      // Falcon — hover above the owner's head, flapping in place, facing the same
      // way as the owner, its hover point trailing the player so it lags behind
      // when they walk (horizontal only; height + bob ride on top).
      this.bobT += dtSec * FALCON_BOB_SPEED;
      if (!this.hoverInit) {
        this.hoverPos.copy(owner.feet);
        this.hoverInit = true;
      }
      const a = 1 - Math.exp(-dtSec * FALCON_LAG_RATE);
      this.hoverPos.x += (owner.feet.x - this.hoverPos.x) * a;
      this.hoverPos.z += (owner.feet.z - this.hoverPos.z) * a;
      this.feet.set(
        this.hoverPos.x,
        owner.feet.y + FALCON_HEIGHT + Math.sin(this.bobT) * FALCON_BOB,
        this.hoverPos.z,
      );
      action = SPRITE_IDLE;
      spriteDir = owner.dir;
    }
    const dir = (camDir + spriteDir) % 8;
    this.ensureFrames(action, dir);
    this.aClock += dtSec;
    const fi = this.frames.length ? frameAt(this.aClock, this.aInfo) : 0;
    const frame = this.frames[fi];
    this.billboard.setVisible(true);
    if (frame && frame.complete && frame.naturalWidth) this.billboard.update(frame, this.feet, camera, frontBias);
  }

  /** Toggle the warg between pet-follow and ridden-mount (WUGRIDER). No-op for
   *  the falcon. */
  setMounted(mounted: boolean): void {
    this.mounted = mounted;
  }

  /** Warg pet follow: path to a cell beside the owner when they pull ahead, idle
   *  facing them when close, teleport when they outrun it (hysteresis between
   *  FOLLOW_NEAR/FOLLOW_FAR keeps a single continuous walk per catch-up). */
  private follow(owner: OwnerState): void {
    const w = this.walker!;
    const dist = chebyshev(owner.cellX, owner.cellY, w.cellX, w.cellY);
    if (dist >= TELEPORT_AT) {
      this.place({ gx: owner.cellX, gy: owner.cellY });
      return;
    }
    if (dist <= FOLLOW_NEAR) {
      this.following = false;
      w.stop();
      w.face(owner.cellX, owner.cellY);
      this.lastGoal = "";
      return;
    }
    if (!this.following) {
      if (dist <= FOLLOW_FAR) {
        w.face(owner.cellX, owner.cellY);
        return;
      }
      this.following = true;
    }
    const goal = this.spotNear({ gx: owner.cellX, gy: owner.cellY }, { gx: w.cellX, gy: w.cellY });
    const key = `${goal.gx},${goal.gy}`;
    if (key === this.lastGoal) return; // already heading there
    this.lastGoal = key;
    const path = findPath(this.world.gat, { gx: w.cellX, gy: w.cellY }, goal);
    if (path.length) w.setPath(path);
  }

  /** Walkable cell adjacent to `target` nearest `from` (so the warg approaches
   *  the near side and stands beside the owner, not on top of them). */
  private spotNear(
    target: { gx: number; gy: number },
    from: { gx: number; gy: number },
  ): { gx: number; gy: number } {
    let best = target;
    let bestD = Infinity;
    for (const [dx, dy] of NEIGHBORS) {
      const gx = target.gx + dx;
      const gy = target.gy + dy;
      if (!this.world.gat.isWalkable(gx, gy)) continue;
      const d = (gx - from.gx) ** 2 + (gy - from.gy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { gx, gy };
      }
    }
    return best;
  }

  private place(target: { gx: number; gy: number }): void {
    const w = this.walker!;
    const spot = this.spotNear(target, { gx: w.cellX, gy: w.cellY });
    w.px = spot.gx + 0.5;
    w.py = spot.gy + 0.5;
    w.stop();
    this.lastGoal = "";
    this.following = false;
  }

  private ensureFrames(action: number, dir: number): void {
    if (action === this.aAction && dir === this.aDir) return;
    if (action !== this.aAction) {
      this.aClock = 0;
      this.aInfo = this.frameInfo.get(action) ?? { count: 1, delays: [] };
    }
    this.aAction = action;
    this.aDir = dir;
    const n = this.aInfo.count;
    // The falcon flies, so drop its ground shadow (the warg keeps its).
    const shadow = this.walker !== null;
    this.frames = Array.from({ length: n }, (_, f) => loadImage(mobFrameUrl(this.view, action, dir, f, shadow)));
  }

  hide(): void {
    this.billboard.setVisible(false);
  }

  dispose(): void {
    this.billboard.dispose();
  }
}
