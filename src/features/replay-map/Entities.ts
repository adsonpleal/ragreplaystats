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
  MOB_ATTACK,
  MOB_DEAD,
  MOUNTED_CANVAS,
  MOUNTED_SPRITE,
  SPRITE,
  SPRITE_CANVAS,
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
import { attackActionType } from "../../ui/weapon-action";
import { type AttackTarget, Companion, FALCON_VIEW, WARG_VIEW } from "./Companion";
import { lookFromEntity } from "./playerState";
import type { World } from "../../sim/render/scene";
import type { ReferenceDb } from "../../db/loader";
import type { Entity, FixPosEvent, MoveEvent } from "../../rrf/types";

const ATTACK_HOLD_MS = 600; // attack pose displays for this long after a damage event
const HURT_HOLD_MS = 250; // brief flash; long enough to register, short enough to keep walking feeling fluid
// After a kill (vanish kind 1) the sprite plays its death frames for this long,
// then disappears — like the client, where a corpse fades out. Without this a
// killed mob would linger on the ground for the whole recording.
const DEATH_HIDE_MS = 1200;

// NPC sprite view ids that are invisible in the client — warp portals and the
// "hidden" script-trigger NPCs. They have no real sprite, so rendering them via
// the bare-sprite path would show a broken/placeholder frame. Skip them.
const INVISIBLE_NPC_VIEWS = new Set([45, 46, 111, 139, 722, 811, 2337]);

// OPTION/effectState bits that mean "cloaked / hidden" — the client doesn't draw
// the sprite. Script NPCs use these (cloakonnpc / hideonnpc) to appear and vanish
// at scripted moments: HIDE 0x2, CLOAK 0x4, INVISIBLE 0x40.
const OPTION_HIDDEN = 0x2 | 0x4 | 0x40;
const isOptionHidden = (option: number): boolean => (option & OPTION_HIDDEN) !== 0;

// Summon OPTION bits on the local player: Falcon (0x10) and Warg — companion
// (WUG 0x100000, trots beside the player) or riding (WUGRIDER 0x200000, the warg
// becomes the mount under the rider). Either bit means a warg is present.
const OPTION_FALCON = 0x10;
const OPTION_WUG = 0x100000;
const OPTION_WUGRIDER = 0x200000;
const OPTION_WARG = OPTION_WUG | OPTION_WUGRIDER;

// Warg-riding classes render as a player+warg composite the gateway serves under
// a "riding" job id (it composites the player's gear onto the warg too), so we
// swap the rider's sprite to that id instead of drawing a separate warg. Base
// class (the replay's session jobView) → mounted id; unmapped classes fall back
// to the under-rider warg. Only the Hunter/Ranger branch rides a warg. The ids
// are ported from latamvisuais' authoritative mount catalog (core/mounts.ts,
// nameKey:"wolf"), verified on the live gateway. 4080→4088 is kept as a defensive
// alias for the alternate Ranger sprite id some clients report.
const WARG_MOUNT_JOB: Record<number, number> = {
  4056: 4111, // Ranger (Sentinela) → Ranger (warg)
  4080: 4088, // Ranger (alternate sprite id) → Ranger (warg)
  4257: 4278, // Windhawk (Falcão do Vento) → Windhawk (warg)
};
const wargMountJob = (baseJob: number): number | null => WARG_MOUNT_JOB[baseJob] ?? null;

// Companion attack skills: when the local player lands one of these, the relevant
// companion lunges at the target and attacks (like the client). Warg: Assalto /
// Investida / Mordida de Worg. Falcon: Ataque Aéreo / Mergulho Aéreo.
const WARG_SKILLS = new Set([2242, 2243, 2244]);
const FALCON_SKILLS = new Set([129, 5326]);
// How long the companion stays on its lunge before returning to the player.
const STRIKE_MS = 900;

type Pose = "idle" | "walk" | "attack" | "hurt" | "casting" | "dead";

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
  private deadHideAt = Infinity; // recording time to hide the corpse after death
  /** Cloaked/hidden via OPTION (a script NPC toggled with cloakonnpc). While set
   *  the sprite isn't drawn, regardless of the visible/pose state. */
  optionHidden = false;
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
  /** Animation type used for the "attack" pose. A player's attack motion
   *  depends on their equipped weapon — a bow uses ATTACK3, a dagger ATTACK1,
   *  etc. (weapon-action.ts maps job+weapon → 5/10/11). Using the wrong motion
   *  renders the unarmed swing AND drops the weapon sprite (ragassets only
   *  composites the weapon on the motion that weapon actually animates on).
   *  Mobs always use ATTACK1. */
  private readonly attackAction: number;
  /** Warg-mount override (player only): when set, the sprite renders as the
   *  player+warg composite under this job id and on the larger mounted canvas.
   *  Null = on foot. */
  private mountJob: number | null = null;

  constructor(
    scene: Scene,
    world: World,
    private readonly src: ActorSource,
    spawn: { gx: number; gy: number },
  ) {
    this.walker = new Walker(world.gat, world.cellSize, spawn);
    this.attackAction =
      src.kind === "player"
        ? attackActionType(src.look!.jobView, src.look!.weapon, src.look!.sex)
        : MOB_ATTACK;
    const metrics = src.kind === "player" ? undefined : MOB_SPRITE;
    this.billboard = new Character(scene, metrics);
    this.billboard.setVisible(false);
    void this.probeFrames();
  }

  private async probeFrames(): Promise<void> {
    // Player poses: idle/walk/cast/hurt/dead plus the weapon-specific attack
    // motion. Mobs: idle/walk/attack/dead.
    const actions =
      this.src.kind === "player"
        ? [SPRITE_IDLE, SPRITE_WALK, this.attackAction, SPRITE_CASTING, SPRITE_HURT, SPRITE_DEAD]
        : [SPRITE_IDLE, SPRITE_WALK, MOB_ATTACK, MOB_DEAD];
    const probeUrl = (a: number) =>
      this.src.kind === "player"
        ? playerFrameProbeUrl(this.renderLook(), a)
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

  /** Snap to a cell (no animation). A fresh position means the entity is present
   *  again, so revive it if it had died (the server reuses an AID for a new
   *  spawn). */
  setPos(gx: number, gy: number): void {
    this.walker.stop();
    this.walker.px = gx + 0.5;
    this.walker.py = gy + 0.5;
    this.visible = true;
    if (this.dead) {
      this.dead = false;
      this.deadHideAt = Infinity;
      this.pose = "idle";
    }
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

  kill(nowMs: number): void {
    this.dead = true;
    this.pose = "dead";
    this.poseUntil = Infinity;
    this.deadHideAt = nowMs + DEATH_HIDE_MS;
    this.walker.stop();
  }

  /** World-space ground position (for damage-text anchors). */
  worldPos(out: Vector3): Vector3 {
    out.set(-this.walker.worldX(), -this.walker.worldY(), this.walker.worldZ());
    return out;
  }

  /** The look the URL builders should render — the base look on foot, or the
   *  same look with the warg-mount job id swapped in while riding (so gear still
   *  composites onto the mounted body). */
  private renderLook(): PlayerLook {
    const look = this.src.look!;
    return this.mountJob != null ? { ...look, jobView: this.mountJob } : look;
  }

  /** Switch the player between the on-foot sprite and a warg-mount sprite
   *  (`jobView` = the mounted job id, or null to dismount). Resizes the billboard
   *  and re-probes frame counts for the swapped sprite. No-op for mobs. */
  setMount(jobView: number | null): void {
    if (this.src.kind !== "player" || jobView === this.mountJob) return;
    this.mountJob = jobView;
    this.billboard.setMetrics(jobView != null ? MOUNTED_SPRITE : SPRITE);
    this.aAction = -1; // force a frame rebuild against the swapped sprite
    void this.probeFrames();
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
    // Cloaked/hidden by OPTION (script NPC) — don't draw it at all.
    if (this.optionHidden) {
      this.billboard.setVisible(false);
      return;
    }
    // A killed sprite plays its death frames, then disappears (the corpse fades
    // in the client). Once past that window it stops rendering.
    if (this.dead && nowMs >= this.deadHideAt) this.visible = false;
    // Expire held poses. Casting flows into attack (the RO client plays the
    // strike animation right after the cast bar fills — the "release" of the
    // raised arms), so a completed cast transitions to attack for
    // ATTACK_HOLD_MS instead of falling straight to idle. If a damage event
    // then arrives it retargets the swing via triggerAttack; if the skill
    // deals no damage the attack still plays out and expires on its own.
    if (this.pose === "casting" && nowMs >= this.poseUntil) {
      this.pose = "attack";
      this.poseUntil = nowMs + ATTACK_HOLD_MS;
    } else if ((this.pose === "attack" || this.pose === "hurt") && nowMs >= this.poseUntil) {
      this.pose = this.walker.moving ? "walk" : "idle";
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

    const action = this.pose === "attack" ? this.attackAction : poseToAction(this.pose, this.src.kind);
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
      const look = this.renderLook();
      const canvas = this.mountJob != null ? MOUNTED_CANVAS : SPRITE_CANVAS;
      this.frames = Array.from({ length: n }, (_, f) => loadImage(playerFrameUrl(look, action, dir, f, 0, canvas)));
    } else {
      const mob = this.src.view!;
      this.frames = Array.from({ length: n }, (_, f) => loadImage(mobFrameUrl(mob, action, dir, f)));
    }
  }

  dispose(): void {
    this.billboard.dispose();
  }
}

// "attack" is resolved to the actor's weapon-specific attackAction at the call
// site (a bow attacks on ATTACK3, a dagger on ATTACK1), so it never reaches here.
// Mobs/NPCs use the compact monster action layout (die = 4, not the player's 8);
// their hurt pose is disabled upstream so only "dead" actually diverges.
function poseToAction(pose: Pose, kind: ActorSource["kind"]): number {
  const isMob = kind === "mob";
  switch (pose) {
    case "walk":
      return SPRITE_WALK;
    case "hurt":
      return SPRITE_HURT;
    case "casting":
      return SPRITE_CASTING;
    case "dead":
      return isMob ? MOB_DEAD : SPRITE_DEAD;
    case "attack":
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
  /** The local player's summons, toggled by their OPTION (falcon + warg). */
  private falcon: Companion | null = null;
  private warg: Companion | null = null;
  private readonly companionFeet = new Vector3();
  private readonly strikeFeet = new Vector3();
  /** The player's warg-mount job id while riding (null on foot, or when their
   *  class has no mounted sprite) — applied to the player Actor each frame. */
  private playerMountJob: number | null = null;
  /** Active companion-skill lunges: the target AID and when the lunge ends
   *  (recording ms). While set, the companion attacks that target instead of
   *  following; cleared when the window passes so it returns to the player. */
  private wargStrike: { targetAid: number; until: number } | null = null;
  private falconStrike: { targetAid: number; until: number } | null = null;

  constructor(
    private readonly scene: Scene,
    private readonly world: World,
    private readonly replay: { entities: Map<number, Entity>; groundUnits: Set<number> },
    private readonly playerAid: number,
    private readonly playerLook: PlayerLook,
    private readonly db: ReferenceDb | null,
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
    const source = this.sourceFor(aid, entity);
    if (!source) return null;
    const spawn = this.lastFix.get(aid) ?? near ?? this.world.spawn;
    a = new Actor(this.scene, this.world, source, spawn);
    a.visible = this.lastFix.has(aid); // hide until we know its real position
    // Seed the cloak state from the spawn OPTION so a script NPC that starts
    // hidden (tr_box) stays invisible until an option change reveals it. Never
    // cloak the local player — they always see themselves.
    a.optionHidden = aid !== this.playerAid && isOptionHidden(entity.option ?? 0);
    this.actors.set(aid, a);
    return a;
  }

  /** Decide how to render an entity, or null to skip it. The local player and
   *  remote PCs render as full player sprites (gear/hair/colors); the local
   *  player's look comes from the session + inventory, a remote player's from
   *  the appearance the spawn packet carried. Mobs and NPCs render as bare
   *  sprites; invisible NPCs (warps/triggers) and other object types are
   *  skipped. */
  private sourceFor(aid: number, entity: Entity): ActorSource | null {
    if (aid === this.playerAid) return { kind: "player", look: this.playerLook };
    switch (entity.kind) {
      case "pc":
        return { kind: "player", look: lookFromEntity(entity, this.db) };
      case "mob":
        return { kind: "mob", view: entity.view || 0 };
      case "npc":
        if (!entity.view || INVISIBLE_NPC_VIEWS.has(entity.view)) return null;
        return { kind: "mob", view: entity.view };
      default:
        return null; // pets/homun/merc/elem not rendered in v1
    }
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

  /** Source attacked target — face & swing. A companion skill from the local
   *  player also sends the warg/falcon lunging at the target. */
  applyDamage(nowMs: number, sourceAid: number, targetAid: number, skillId = 0): void {
    const tgt = this.actors.get(targetAid) ?? this.ensure(targetAid);
    const src = this.actors.get(sourceAid) ?? this.ensure(sourceAid);
    if (src && tgt) {
      src.triggerAttack(nowMs, { gx: tgt.walker.cellX, gy: tgt.walker.cellY });
    } else if (src) {
      src.triggerAttack(nowMs);
    }
    if (tgt) tgt.triggerHurt(nowMs);
    if (sourceAid === this.playerAid) this.companionStrike(skillId, targetAid, nowMs);
  }

  /** Start a companion lunge if `skillId` is a warg/falcon skill and that
   *  companion is out (a mounted warg is part of the rider sprite, so it can't
   *  lunge — the falcon still can). */
  private companionStrike(skillId: number, targetAid: number, nowMs: number): void {
    if (WARG_SKILLS.has(skillId) && this.warg) {
      this.wargStrike = { targetAid, until: nowMs + STRIKE_MS };
    } else if (FALCON_SKILLS.has(skillId) && this.falcon) {
      this.falconStrike = { targetAid, until: nowMs + STRIKE_MS };
    }
  }

  /** The attack target for an active strike, or undefined when it's expired or
   *  the target is gone (also clears the finished strike). */
  private strikeTarget(
    strike: { targetAid: number; until: number } | null,
    nowMs: number,
  ): AttackTarget | undefined {
    if (!strike) return undefined;
    if (nowMs >= strike.until) return undefined;
    const t = this.actors.get(strike.targetAid);
    if (!t || !t.visible || t.optionHidden) return undefined;
    return { cellX: t.walker.cellX, cellY: t.walker.cellY, feet: t.worldPos(this.strikeFeet) };
  }

  applyCast(nowMs: number, sourceAid: number, targetAid: number, castMs: number): void {
    const src = this.actors.get(sourceAid) ?? this.ensure(sourceAid);
    const tgt = this.actors.get(targetAid);
    if (!src) return;
    src.triggerCasting(nowMs, castMs, tgt ? { gx: tgt.walker.cellX, gy: tgt.walker.cellY } : undefined);
  }

  applyVanish(nowMs: number, aid: number, kind: number): void {
    const a = this.actors.get(aid);
    if (!a) return;
    if (kind === 1) {
      a.kill(nowMs);
    } else {
      // out of sight / logged out / teleported — hide without playing dead
      a.visible = false;
    }
  }

  /** OPTION/effectState change. For the local player it toggles their summons
   *  (falcon + warg); for everyone else it reveals or cloaks a script NPC
   *  (cloakonnpc) — the player is never cloaked (they see themselves). */
  applyOption(aid: number, option: number): void {
    if (aid === this.playerAid) {
      const wargPresent = (option & OPTION_WARG) !== 0;
      const riding = (option & OPTION_WUGRIDER) !== 0;
      // Riding + a mounted sprite for this class → render the player as the
      // player+warg composite (applied to the Actor in update); no separate warg.
      this.playerMountJob = riding ? wargMountJob(this.playerLook.jobView) : null;
      this.setCompanion("falcon", (option & OPTION_FALCON) !== 0);
      this.setCompanion("warg", wargPresent && this.playerMountJob == null);
      // Fallback for a warg-rider class with no mounted sprite: draw the warg
      // under the rider instead (no-op when there's no separate warg).
      this.warg?.setMounted(riding);
      return;
    }
    const a = this.actors.get(aid) ?? this.ensure(aid);
    if (a) a.optionHidden = isOptionHidden(option);
  }

  private setCompanion(kind: "falcon" | "warg", want: boolean): void {
    const cur = kind === "falcon" ? this.falcon : this.warg;
    if (want === !!cur) return;
    let next: Companion | null = null;
    if (want) {
      const player = this.actors.get(this.playerAid);
      const near = player
        ? { gx: player.walker.cellX, gy: player.walker.cellY }
        : this.world.spawn;
      const view = kind === "falcon" ? FALCON_VIEW : WARG_VIEW;
      next = new Companion(this.scene, this.world, view, kind, near);
    } else {
      cur!.dispose();
    }
    if (kind === "falcon") this.falcon = next;
    else this.warg = next;
  }

  /** Per-frame render call. */
  update(dtSec: number, nowMs: number, camDir: number, camera: PerspectiveCamera): void {
    // Apply the player's mount state (warg-riding sprite swap) before drawing.
    this.actors.get(this.playerAid)?.setMount(this.playerMountJob);
    for (const a of this.actors.values()) a.update(dtSec, nowMs, camDir, camera);
    // Summons trail the local player while their OPTION carries the bit.
    const player = this.actors.get(this.playerAid);
    if ((this.falcon || this.warg) && player && player.visible && !player.optionHidden) {
      const owner = {
        cellX: player.walker.cellX,
        cellY: player.walker.cellY,
        feet: player.worldPos(this.companionFeet),
        dir: player.walker.dir,
        moving: player.walker.moving,
      };
      // Resolve any active companion-skill lunges, then expire the finished ones.
      const falconAttack = this.strikeTarget(this.falconStrike, nowMs);
      const wargAttack = this.strikeTarget(this.wargStrike, nowMs);
      if (this.falconStrike && nowMs >= this.falconStrike.until) this.falconStrike = null;
      if (this.wargStrike && nowMs >= this.wargStrike.until) this.wargStrike = null;
      this.falcon?.update(dtSec, owner, camDir, camera, falconAttack);
      this.warg?.update(dtSec, owner, camDir, camera, wargAttack);
    } else {
      this.falcon?.hide();
      this.warg?.hide();
    }
  }

  /** Look up an actor's world-space ground position (for damage text). */
  worldPosOf(aid: number, out: Vector3): Vector3 | null {
    const a = this.actors.get(aid);
    if (!a || !a.visible || a.optionHidden) return null;
    return a.worldPos(out);
  }

  /** Iterate every visible actor with the meshes the hover raycast needs. */
  visibleActors(): Array<{ aid: number; mesh: Mesh; actor: Actor; billboard: Character }> {
    const out: Array<{ aid: number; mesh: Mesh; actor: Actor; billboard: Character }> = [];
    for (const [aid, a] of this.actors) {
      if (!a.visible || a.optionHidden) continue;
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
    this.falcon?.dispose();
    this.warg?.dispose();
    this.falcon = this.warg = null;
  }
}
