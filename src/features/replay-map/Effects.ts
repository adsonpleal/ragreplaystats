// Scrub-safe skill/world-effect layer for the replay map viewer, modelled on
// DamageText.ts. Each live effect stores its spawn `nowMs` (recording clock) and
// drives its keyframes off `elapsed = nowMs - spawnMs`, NOT wall-clock dt, so
// pause/scrub/rewind track the timeline. Effects are loaded async (memoized in
// effectAssets); a spawn kicks off the load and instantiates the StrEffect(s)
// once it resolves — if the load lands late, the instance simply starts a few ms
// in and self-culls if the moment has already passed.
//
// Attached effects (a cast on its caster) re-read the entity's world position
// each frame so they follow; hit effects stay at the anchor captured at spawn.
// The whole layer is disposed + recreated on a backward seek (ReplayMap's
// buildRuntime), like the damage pool, so a rewind starts clean.

import { type PerspectiveCamera, type Scene, Vector3 } from "three";
import { StrEffect } from "../../sim/render/strEffect";
import { CylinderEffect } from "../../sim/render/cylinderEffect";
import { ThreeDEffect } from "../../sim/render/threeDEffect";
import { SprAnimEffect } from "../../sim/render/sprAnimEffect";
import { type LoadedPart, loadEffect, loadSkillMainEffect } from "../../sim/render/effectAssets";
import type { EntityTable } from "./Entities";

/** Any renderer — all share update(elapsedMs, camera, anchor, loop) + dispose. */
type EffectRenderer = StrEffect | CylinderEffect | ThreeDEffect | SprAnimEffect;

interface LiveEffect {
  effect: EffectRenderer;
  spawnMs: number;
  /** Part stagger (ms after spawnMs before this STR starts playing) — multi-part
   *  modern effects stage their waves. Animation time = elapsed - delayMs;
   *  negative just keeps the part hidden until its wave begins. */
  delayMs: number;
  attached: boolean;
  aid: number;
  /** Static anchor (hit/ground effects) or the last known follow position. */
  anchor: Vector3;
  /** Persistent ground effect: loop the STR and cull at `durationMs` instead of
   *  at the STR's natural end. false for one-shot cast/hit effects. */
  loop: boolean;
  /** Lifetime for looped effects (ms); ignored when loop is false. */
  durationMs: number;
}

/** Per-spawn placement. `attached` follows `aid`; `loop`+`durationMs` make a
 *  persistent ground effect (Storm Gust, Arrow Storm, …). */
export interface SpawnOpts {
  attached?: boolean;
  loop?: boolean;
  durationMs?: number;
}

export class EffectsLayer {
  private readonly live: LiveEffect[] = [];
  private readonly followTmp = new Vector3();
  private disposed = false;

  constructor(
    private readonly scene: Scene,
    private readonly entities: EntityTable,
    /** World units per map tile — CylinderEffect converts its tile-unit sizes. */
    private readonly cellSize: number,
  ) {}

  /** Spawn `effectId`'s STR animation(s) at `anchor` (world space). `attached`
   *  effects follow `aid`'s position each frame; others stay at `anchor`. `loop`
   *  makes a persistent ground effect culled at `durationMs`. Loading is async +
   *  memoized; nothing renders (and nothing breaks) for an unknown or non-STR
   *  effect. A null/undefined effectId or anchor is a no-op. */
  spawn(
    effectId: number | undefined,
    aid: number,
    anchor: Vector3 | null,
    nowMs: number,
    opts: SpawnOpts = {},
  ): void {
    if (effectId == null || !anchor) return;
    this.instantiate(loadEffect(effectId), aid, anchor, nowMs, opts, `effect ${effectId}`);
  }

  /** Spawn a skill's MAIN effect resolved by skillId (client STR override first,
   *  else the gateway skill-map's effectId). Used for skills the gateway doesn't
   *  cover — Windhawk et al. Same placement semantics as `spawn`. */
  spawnSkillMain(
    skillId: number,
    aid: number,
    anchor: Vector3 | null,
    nowMs: number,
    opts: SpawnOpts = {},
  ): void {
    if (!skillId || !anchor) return;
    this.instantiate(loadSkillMainEffect(skillId), aid, anchor, nowMs, opts, `skill ${skillId}`);
  }

  /** Await a resolved part list and push a live instance per part — a StrEffect
   *  for keyframe parts, a CylinderEffect for procedural ground rings. Shared by
   *  the effectId and skillId spawn paths. */
  private instantiate(
    partsPromise: Promise<LoadedPart[]>,
    aid: number,
    anchor: Vector3,
    nowMs: number,
    opts: SpawnOpts,
    label: string,
  ): void {
    const anchorSnapshot = anchor.clone();
    const attached = opts.attached ?? false;
    const loop = opts.loop ?? false;
    const durationMs = opts.durationMs ?? 0;
    partsPromise
      .then((parts) => {
        if (this.disposed || !parts.length) return;
        for (const part of parts) {
          let effect: EffectRenderer;
          let delayMs: number;
          if (part.kind === "str") {
            effect = new StrEffect(this.scene, part.str);
            delayMs = part.str.startDelayMs ?? 0;
          } else if (part.kind === "cylinder") {
            effect = new CylinderEffect(this.scene, part.cyl, this.cellSize);
            delayMs = part.cyl.startDelayMs ?? 0;
          } else if (part.kind === "threeD") {
            effect = new ThreeDEffect(this.scene, part.three, this.cellSize);
            delayMs = part.three.startDelayMs ?? 0;
          } else {
            effect = new SprAnimEffect(this.scene, part.spr, this.cellSize);
            delayMs = part.spr.startDelayMs ?? 0;
          }
          this.live.push({
            effect,
            spawnMs: nowMs,
            delayMs,
            attached,
            aid,
            anchor: anchorSnapshot.clone(),
            loop,
            durationMs,
          });
        }
      })
      .catch((err) => console.warn("[effects] spawn failed", label, err));
  }

  /** Advance every live effect to `nowMs`, culling finished ones. Drives
   *  keyframes off elapsed recording time so pause/scrub behave. */
  update(nowMs: number, camera: PerspectiveCamera): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const l = this.live[i];
      const elapsed = nowMs - l.spawnMs;
      // Rewound before this effect existed → drop it (a fresh seek forward will
      // respawn from the cursors).
      if (elapsed < 0) {
        l.effect.dispose();
        this.live.splice(i, 1);
        continue;
      }
      // Looped ground effects run for a fixed lifetime (the STR wraps); cull when
      // it elapses rather than at the STR's natural end.
      if (l.loop && l.durationMs > 0 && elapsed > l.durationMs) {
        l.effect.dispose();
        this.live.splice(i, 1);
        continue;
      }
      // Attached: follow the entity's ground point while it's visible; fall back
      // to the last anchor when it vanishes.
      if (l.attached) {
        const p = this.entities.worldPosOf(l.aid, this.followTmp);
        if (p) l.anchor.copy(p);
      }
      // Part stagger: animate from the part's own start; a negative time just
      // renders nothing (StrEffect hides all layers before keyframe 0).
      const alive = l.effect.update(elapsed - l.delayMs, camera, l.anchor, l.loop);
      if (!alive) {
        l.effect.dispose();
        this.live.splice(i, 1);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const l of this.live) l.effect.dispose();
    this.live.length = 0;
  }
}
