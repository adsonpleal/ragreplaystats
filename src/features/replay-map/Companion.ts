// A summoned companion billboard (Ranger/Windhawk falcon + warg) that follows
// the player. It's not a replay entity — it has no packets of its own; it's
// driven each frame off the owner's position + facing while the owner's OPTION
// carries the FALCON / WUG bit. The falcon circles above the player; the warg
// trots on the ground just ahead of them.
//
// Sprites come from ragassets by mob id: the gateway maps 20830 -> the Windhawk
// hawk (data\sprite\이팩트\windhawk_hawk) and 20833 -> the Windhawk warg
// (windhawk_wolf). Like any mob sprite, idle = action 0, walk = action 1.

import { type PerspectiveCamera, type Scene, Vector3 } from "three";
import { loadImage } from "../../sim/imageCache";
import { type ApngInfo, fetchApngInfo, frameAt } from "../../sim/apng";
import { Character } from "../../sim/render/character";
import { MOB_SPRITE, mobFrameProbeUrl, mobFrameUrl } from "../../sim/ragassets";
import { SPRITE_IDLE, SPRITE_WALK } from "../../sim/sprite";

/** Windhawk companion sprite ids (ragassets → windhawk_hawk / windhawk_wolf). */
export const FALCON_VIEW = 20830;
export const WARG_VIEW = 20833;

export type CompanionKind = "falcon" | "warg";

// Absolute facing (0-7) → cell delta, the inverse of the Walker's dirFromDelta.
const DIR_DELTA: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1],
];

const WARG_FRONT_CELLS = 1.4; // how far ahead of the owner the warg trots
const FALCON_HEIGHT = 6.5; // world units the falcon floats above the owner's feet
const FALCON_ORBIT = 2.2; // horizontal orbit radius
const FALCON_ORBIT_SPEED = 1.6; // rad/sec
const FALCON_BOB = 0.8; // vertical bob amplitude

export class Companion {
  private readonly billboard: Character;
  private frames: HTMLImageElement[] = [];
  private aInfo: ApngInfo = { count: 1, delays: [] };
  private readonly frameInfo = new Map<number, ApngInfo>();
  private aAction = -1;
  private aDir = -1;
  private aClock = 0;
  private phase = Math.random() * Math.PI * 2; // falcon orbit phase
  private readonly p = new Vector3();

  constructor(
    scene: Scene,
    private readonly view: number,
    private readonly kind: CompanionKind,
  ) {
    this.billboard = new Character(scene, MOB_SPRITE);
    this.billboard.setVisible(false);
    void this.probe();
  }

  private async probe(): Promise<void> {
    await Promise.all(
      [SPRITE_IDLE, SPRITE_WALK].map(async (a) => {
        this.frameInfo.set(a, await fetchApngInfo(mobFrameProbeUrl(this.view, a)));
      }),
    );
    this.aAction = -1; // force a rebuild against the real frame counts
  }

  /** Position + animate relative to the owner. `ownerFeet` is the player's
   *  ground point in scene space (as from Actor.worldPos). */
  update(
    dtSec: number,
    ownerFeet: Vector3,
    ownerDir: number,
    ownerMoving: boolean,
    camDir: number,
    camera: PerspectiveCamera,
    cellSize: number,
  ): void {
    let action: number;
    if (this.kind === "warg") {
      // Trot a step ahead in the owner's facing direction, on the ground. Scene
      // space mirrors X (x = -cellX) and keeps Z (z = cellY), matching Actor.
      const [dx, dy] = DIR_DELTA[ownerDir % 8];
      this.p.copy(ownerFeet);
      this.p.x -= dx * cellSize * WARG_FRONT_CELLS;
      this.p.z += dy * cellSize * WARG_FRONT_CELLS;
      action = ownerMoving ? SPRITE_WALK : SPRITE_IDLE;
    } else {
      // Circle above the player, bobbing, always flapping (the hawk's idle).
      this.phase += dtSec * FALCON_ORBIT_SPEED;
      this.p.copy(ownerFeet);
      this.p.x -= Math.cos(this.phase) * FALCON_ORBIT;
      this.p.z += Math.sin(this.phase) * FALCON_ORBIT;
      // Scene "up" (higher on screen) is +y here.
      this.p.y += FALCON_HEIGHT + Math.sin(this.phase * 2) * FALCON_BOB;
      action = SPRITE_IDLE;
    }
    const dir = (camDir + ownerDir) % 8;
    this.ensureFrames(action, dir);
    this.aClock += dtSec;
    const fi = this.frames.length ? frameAt(this.aClock, this.aInfo) : 0;
    const frame = this.frames[fi];
    this.billboard.setVisible(true);
    if (frame && frame.complete && frame.naturalWidth) this.billboard.update(frame, this.p, camera);
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
    this.frames = Array.from({ length: n }, (_, f) => loadImage(mobFrameUrl(this.view, action, dir, f)));
  }

  hide(): void {
    this.billboard.setVisible(false);
  }

  dispose(): void {
    this.billboard.dispose();
  }
}
