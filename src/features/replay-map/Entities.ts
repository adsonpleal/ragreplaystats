// Per-AID actor table for the replay map viewer. Each entry owns one billboard
// (Character for the player, a smaller pet-canvas billboard for mobs), a Walker
// for cell-grid motion, and a pose state machine driven by the replay's damage/
// skill/vanish events. Movement is driven by the replay's MoveEvent + FixPosEvent
// streams (replay packet stream → decoded in src/rrf), so the actor follows the
// path the server told it to walk in real time.

import { type Mesh, type PerspectiveCamera, type Scene, Vector3 } from "three";
import { loadImage } from "../../sim/imageCache";
import { DEFAULT_FRAME_DELAY, fetchApngInfo, frameAt, type ApngInfo } from "../../sim/apng";
import { Character } from "../../sim/render/character";
import { Walker } from "../../sim/walker";
import {
  ACTION_FRAMES,
  SPRITE_ATTACK1,
  SPRITE_CASTING,
  SPRITE_DEAD,
  SPRITE_HURT,
  SPRITE_IDLE,
  SPRITE_WALK,
} from "../../sim/sprite";
import {
  MOB_SPRITE,
  mobFrameProbeUrl,
  mobFrameUrl,
  playerFrameProbeUrl,
  playerFrameUrl,
  type PlayerLook,
} from "../../sim/ragassets";
import type { World } from "../../sim/render/scene";
import type { Entity, FixPosEvent, MoveEvent } from "../../rrf/types";

const ATTACK_HOLD_MS = 600; // attack pose displays for this long after a damage event
const HURT_HOLD_MS = 250; // brief flash; long enough to register, short enough to keep walking feeling fluid

type Pose = "idle" | "walk" | "attack" | "hurt" | "casting" | "dead";

/** All poses we can render — used to warm frame counts up front. */
const PLAYER_ACTIONS = [SPRITE_IDLE, SPRITE_WALK, SPRITE_ATTACK1, SPRITE_CASTING, SPRITE_HURT, SPRITE_DEAD];
const MOB_ACTIONS = [SPRITE_IDLE, SPRITE_WALK, SPRITE_ATTACK1, SPRITE_DEAD];

interface ActorSource {
  kind: "player" | "mob";
  /** Player look (when kind = "player") — passed to the ragassets URL builder. */
  look?: PlayerLook;
  /** Mob view id (when kind = "mob"). */
  view?: number;
}

/** Whether we render the "hurt" pose for this actor when it takes damage.
 *  ragassets doesn't have a hurt animation for every monster (dummies + a lot
 *  of the boss/npc sprites resolve to an empty frame or a stale idle), so
 *  transitioning them into it causes a flicker every time a hit lands. In RO
 *  proper only PC/pet sprites play a hurt frame — mobs stay in idle/walk. */
function poseHurtAllowed(src: ActorSource): boolean {
  return src.kind === "player";
}

/** Seconds it takes the animator to reach `holdFrame` given the pose's
 *  per-frame delays (or the DEFAULT_FRAME_DELAY fallback when the acTL didn't
 *  ship delays). Used to freeze the casting animation at the raise-arms hold
 *  point instead of letting `frameAt`'s modulo loop the animation. */
function holdFrameTime(info: ApngInfo, holdFrame: number): number {
  if (info.delays.length === info.count) {
    let t = 0;
    for (let i = 0; i < holdFrame && i < info.delays.length; i++) t += info.delays[i];
    return t;
  }
  const d = info.delays[0] || DEFAULT_FRAME_DELAY;
  return d * holdFrame;
}

class Actor {
  walker: Walker;
  billboard: Character;
  visible = false;
  pose: Pose = "idle";
  private poseUntil = 0; // ms (recording time) the held pose expires
  private dead = false;
  private aAction = -1;
  private aDir = -1;
  private aClock = 0;
  private frames: HTMLImageElement[] = [];
  private aInfo: ApngInfo = { count: 1, delays: [] };
  private feet = new Vector3();
  private frameInfo = new Map<number, ApngInfo>();
  /** While casting: play frames up to `castHoldFrame` at normal speed, then
   *  freeze until the cast bar fills, then release into idle/attack. Matches
   *  RO's behaviour where the character raises their arms mid-animation and
   *  waits for the cast bar. Null while not casting. */
  private castHoldFrame: number | null = null;

  constructor(
    scene: Scene,
    world: World,
    private readonly src: ActorSource,
    spawn: { gx: number; gy: number },
  ) {
    this.walker = new Walker(world.gat, world.cellSize, spawn);
    const metrics = src.kind === "mob" ? MOB_SPRITE : undefined;
    this.billboard = new Character(scene, metrics);
    this.billboard.setVisible(false);
    void this.probeFrames();
  }

  private async probeFrames(): Promise<void> {
    const actions = this.src.kind === "player" ? PLAYER_ACTIONS : MOB_ACTIONS;
    const probeUrl = (a: number) =>
      this.src.kind === "player"
        ? playerFrameProbeUrl(this.src.look!, a)
        : mobFrameProbeUrl(this.src.view!, a);
    await Promise.all(
      actions.map(async (a) => {
        const info = await fetchApngInfo(probeUrl(a));
        this.frameInfo.set(a, info);
      }),
    );
    // Force the animator to rebuild against the new frame counts.
    this.aAction = -1;
  }

  /** Snap to a cell (no animation). */
  setPos(gx: number, gy: number): void {
    this.walker.stop();
    this.walker.px = gx + 0.5;
    this.walker.py = gy + 0.5;
    this.visible = true;
  }

  /** Trigger an attack pose for ATTACK_HOLD_MS ms, optionally facing target cell. */
  triggerAttack(nowMs: number, target?: { gx: number; gy: number }): void {
    if (this.dead) return;
    if (target) this.walker.face(target.gx, target.gy);
    this.pose = "attack";
    this.poseUntil = nowMs + ATTACK_HOLD_MS;
  }

  /** Enter the casting pose for `castMs`. The animation plays through until
   *  ~2/3 of the frames, then freezes on that frame while the cast bar fills;
   *  the last frames play out just before the cast completes. Matches the
   *  RO client: raise-arms, hold, then flourish on cast complete. */
  triggerCasting(nowMs: number, castMs: number, target?: { gx: number; gy: number }): void {
    if (this.dead) return;
    if (target) this.walker.face(target.gx, target.gy);
    this.pose = "casting";
    this.poseUntil = nowMs + Math.max(200, castMs);
    // Freeze on the 2nd-to-last frame — computed at ensureFrames time once we
    // know how many frames this build's casting sprite actually has.
    this.castHoldFrame = null; // reset; ensureFrames will fill it
  }

  triggerHurt(nowMs: number): void {
    if (this.dead) return;
    if (this.pose === "attack" || this.pose === "casting") return; // don't pre-empt the attack swing
    if (!poseHurtAllowed(this.src)) return; // mobs have no reliable hurt sprite → flickers
    this.pose = "hurt";
    this.poseUntil = nowMs + HURT_HOLD_MS;
  }

  kill(): void {
    this.dead = true;
    this.pose = "dead";
    this.poseUntil = Infinity;
    this.walker.stop();
  }

  /** World-space ground position (for damage-text anchors). */
  worldPos(out: Vector3): Vector3 {
    out.set(-this.walker.worldX(), -this.walker.worldY(), this.walker.worldZ());
    return out;
  }

  /** Render one frame. `nowMs` is the recording's time cursor (used to expire
   *  held poses). `camDir` is the camera's facing index for the displayed
   *  direction. */
  update(
    dtSec: number,
    nowMs: number,
    camDir: number,
    camera: PerspectiveCamera,
  ): void {
    // Expire held poses.
    if (this.pose === "attack" || this.pose === "hurt" || this.pose === "casting") {
      if (nowMs >= this.poseUntil) this.pose = this.walker.moving ? "walk" : "idle";
    }
    // Walk pose follows the walker's moving flag, unless a held pose overrides.
    if (!this.dead && this.pose !== "attack" && this.pose !== "hurt" && this.pose !== "casting") {
      this.pose = this.walker.moving ? "walk" : "idle";
    }

    this.walker.update(dtSec);
    if (!this.visible) {
      this.billboard.setVisible(false);
      return;
    }
    this.billboard.setVisible(true);

    const action = poseToAction(this.pose);
    const dir = (camDir + this.walker.dir) % 8;
    this.ensureFrames(action, dir);
    this.aClock += dtSec;
    // Casting: play frames 0..castHoldFrame at normal speed, then STOP the
    // animation clock at the boundary so the sprite stays on castHoldFrame
    // (RO's "raise arms → hold → release" behaviour). Without this the
    // frameAt() modulo loops the animation forever, so the character would
    // keep re-raising over and over during a long cast.
    if (this.pose === "casting" && this.castHoldFrame != null) {
      const holdSec = holdFrameTime(this.aInfo, this.castHoldFrame);
      if (this.aClock >= holdSec) this.aClock = holdSec;
    }
    let fi = this.frames.length ? frameAt(this.aClock, this.aInfo) : 0;
    if (this.pose === "casting" && this.castHoldFrame != null && fi > this.castHoldFrame) {
      fi = this.castHoldFrame;
    }
    const frame = this.frames[fi];
    this.worldPos(this.feet);
    if (frame && frame.complete && frame.naturalWidth) {
      this.billboard.update(frame, this.feet, camera);
    }
  }

  private ensureFrames(action: number, dir: number): void {
    if (action === this.aAction && dir === this.aDir) return;
    if (action !== this.aAction) {
      this.aClock = 0;
      this.aInfo = this.frameInfo.get(action) ?? { count: ACTION_FRAMES[action] ?? 1, delays: [] };
      // Recompute the casting hold-frame against the pose we're switching TO.
      // RO's cast animation is "raise arms → hold → release": play through
      // the raise, freeze at the third frame (0-indexed 2) — the "arms up,
      // ready to release" pose in a 6-frame casting animation — then let the
      // transition to `attack` on cast-complete do the release. Frame index
      // is floor((count-1)/2), which lands on 2 for 6 frames and degrades
      // gracefully for shorter animations.
      this.castHoldFrame =
        action === SPRITE_CASTING ? Math.max(0, Math.floor((this.aInfo.count - 1) / 2)) : null;
    }
    this.aAction = action;
    this.aDir = dir;
    const n = this.aInfo.count;
    if (this.src.kind === "player") {
      const look = this.src.look!;
      this.frames = Array.from({ length: n }, (_, f) => loadImage(playerFrameUrl(look, action, dir, f)));
    } else {
      const mob = this.src.view!;
      this.frames = Array.from({ length: n }, (_, f) => loadImage(mobFrameUrl(mob, action, dir, f)));
    }
  }

  dispose(): void {
    this.billboard.dispose();
  }
}

function poseToAction(pose: Pose): number {
  switch (pose) {
    case "walk":
      return SPRITE_WALK;
    case "attack":
      return SPRITE_ATTACK1;
    case "hurt":
      return SPRITE_HURT;
    case "casting":
      return SPRITE_CASTING;
    case "dead":
      return SPRITE_DEAD;
    case "idle":
    default:
      return SPRITE_IDLE;
  }
}

export class EntityTable {
  private readonly actors = new Map<number, Actor>();
  /** Per-AID position from the latest fix-pos event (used to seed the actor's
   *  Walker the first time it becomes visible). */
  private readonly lastFix = new Map<number, { gx: number; gy: number }>();

  constructor(
    private readonly scene: Scene,
    private readonly world: World,
    private readonly replay: { entities: Map<number, Entity>; groundUnits: Set<number> },
    private readonly playerAid: number,
    private readonly playerLook: PlayerLook,
  ) {}

  /** Returns the actor for `aid`, creating it on first reference if we know
   *  enough to render it (player or a mob/PC with a sprite view). */
  ensure(aid: number, near?: { gx: number; gy: number }): Actor | null {
    let a = this.actors.get(aid);
    if (a) return a;
    // Skip ground-skill units — they're invisible markers in roBrowser too.
    if (this.replay.groundUnits.has(aid)) return null;
    const entity = this.replay.entities.get(aid);
    if (!entity) return null;
    const isPlayer = aid === this.playerAid;
    // Only render PCs and mobs in v1; NPCs are static and uninteresting for
    // damage playback (npc.kind === 'npc' covers warpers/shops).
    if (!isPlayer && entity.kind !== "mob" && entity.kind !== "pc") return null;
    const spawn = this.lastFix.get(aid) ?? near ?? this.world.spawn;
    a = new Actor(
      this.scene,
      this.world,
      isPlayer
        ? { kind: "player", look: this.playerLook }
        : { kind: "mob", view: entity.view || 0 },
      spawn,
    );
    a.visible = this.lastFix.has(aid); // hide until we know its real position
    this.actors.set(aid, a);
    return a;
  }

  /** Apply a fix-pos / spawn-position event. */
  applyFixPos(ev: FixPosEvent): void {
    this.lastFix.set(ev.aid, { gx: ev.gx, gy: ev.gy });
    const a = this.ensure(ev.aid);
    if (a) {
      a.setPos(ev.gx, ev.gy);
    }
  }

  /** Apply a move event — start walking from `from` to `to`. */
  applyMove(ev: MoveEvent, findPath: (from: { gx: number; gy: number }, to: { gx: number; gy: number }) => { gx: number; gy: number }[]): void {
    const a = this.ensure(ev.aid, ev.from);
    if (!a) return;
    a.setPos(ev.from.gx, ev.from.gy);
    a.visible = true;
    const path = findPath(ev.from, ev.to);
    if (path.length) {
      a.walker.setPath(path);
    }
  }

  /** Source attacked target — face & swing. */
  applyDamage(nowMs: number, sourceAid: number, targetAid: number): void {
    const tgt = this.actors.get(targetAid) ?? this.ensure(targetAid);
    const src = this.actors.get(sourceAid) ?? this.ensure(sourceAid);
    if (src && tgt) {
      src.triggerAttack(nowMs, { gx: tgt.walker.cellX, gy: tgt.walker.cellY });
    } else if (src) {
      src.triggerAttack(nowMs);
    }
    if (tgt) tgt.triggerHurt(nowMs);
  }

  applyCast(nowMs: number, sourceAid: number, targetAid: number, castMs: number): void {
    const src = this.actors.get(sourceAid) ?? this.ensure(sourceAid);
    const tgt = this.actors.get(targetAid);
    if (!src) return;
    src.triggerCasting(nowMs, castMs, tgt ? { gx: tgt.walker.cellX, gy: tgt.walker.cellY } : undefined);
  }

  applyVanish(aid: number, kind: number): void {
    const a = this.actors.get(aid);
    if (!a) return;
    if (kind === 1) {
      a.kill();
    } else {
      // out of sight / logged out / teleported — hide without playing dead
      a.visible = false;
    }
  }

  /** Per-frame render call. */
  update(dtSec: number, nowMs: number, camDir: number, camera: PerspectiveCamera): void {
    for (const a of this.actors.values()) a.update(dtSec, nowMs, camDir, camera);
  }

  /** Look up an actor's world-space ground position (for damage text). */
  worldPosOf(aid: number, out: Vector3): Vector3 | null {
    const a = this.actors.get(aid);
    if (!a || !a.visible) return null;
    return a.worldPos(out);
  }

  /** Iterate every visible actor with the meshes the hover raycast needs. */
  visibleActors(): Array<{ aid: number; mesh: Mesh; actor: Actor; billboard: Character }> {
    const out: Array<{ aid: number; mesh: Mesh; actor: Actor; billboard: Character }> = [];
    for (const [aid, a] of this.actors) {
      if (!a.visible) continue;
      out.push({ aid, mesh: a.billboard.mesh, actor: a, billboard: a.billboard });
    }
    return out;
  }

  actor(aid: number): Actor | null {
    return this.actors.get(aid) ?? null;
  }

  dispose(): void {
    for (const a of this.actors.values()) a.dispose();
    this.actors.clear();
  }
}
