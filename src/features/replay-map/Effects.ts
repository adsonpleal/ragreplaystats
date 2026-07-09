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
import { QuadHornEffect } from "../../sim/render/quadHornEffect";
import { CastCircleEffect } from "../../sim/render/castCircleEffect";
import { GroundAuraEffect } from "../../sim/render/groundAuraEffect";
import { SwirlingAuraEffect } from "../../sim/render/swirlingAuraEffect";
import { Level99BubbleEffect } from "../../sim/render/level99BubbleEffect";
import { MaxLevelAuraEffect } from "../../sim/render/maxLevelAuraEffect";
import {
  AURA_GOLD,
  type LoadedPart,
  levelAuraParts,
  loadEffect,
  loadLockOnTexture,
  loadSkillMainEffect,
  maxLevelAuraParts,
} from "../../sim/render/effectAssets";
import type { EntityTable } from "./Entities";
import type { Texture } from "three";

/** Level-aura tier: the base-99 aura, or the EXE-recovered base-250 4th-job aura. */
export type AuraTier = "l99" | "max";

/** Any renderer — all share update(elapsedMs, camera, anchor, loop) + dispose. */
type EffectRenderer =
  | StrEffect
  | CylinderEffect
  | ThreeDEffect
  | SprAnimEffect
  | QuadHornEffect
  | CastCircleEffect
  | GroundAuraEffect
  | SwirlingAuraEffect
  | Level99BubbleEffect
  | MaxLevelAuraEffect;

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
  /** Lazily-loaded lock-on cast-circle texture, shared across every cast circle. */
  private lockOnTex: Texture | null = null;
  /** Persistent level auras, one per qualifying actor (aid → its part renderers,
   *  spawn time, and tier). Managed by syncAuras, not the live list — they live for
   *  as long as the actor is present and qualifying, following it each frame. */
  private readonly auras = new Map<number, { effects: EffectRenderer[]; spawnMs: number; tier: AuraTier }>();

  constructor(
    private readonly scene: Scene,
    private readonly entities: EntityTable,
    /** World units per map tile — CylinderEffect converts its tile-unit sizes. */
    private readonly cellSize: number,
  ) {}

  /** Spawn the lock-on cast circle under a caster for the cast's duration — the
   *  rotating ground targeting ring (EF_LOCKON). Attached to `aid` so it follows,
   *  culled when the cast ends. A no-op for instant casts (castMs ≤ 0) or a missing
   *  anchor. Synchronous: the texture is cached, the renderer carries no table data. */
  spawnCastCircle(aid: number, anchor: Vector3 | null, nowMs: number, castMs: number): void {
    if (this.disposed || !anchor || castMs <= 0) return;
    if (!this.lockOnTex) this.lockOnTex = loadLockOnTexture();
    const effect = new CastCircleEffect(this.scene, this.lockOnTex, this.cellSize);
    this.live.push({
      effect,
      spawnMs: nowMs,
      delayMs: 0,
      attached: true,
      aid,
      anchor: anchor.clone(),
      loop: true,
      durationMs: castMs,
    });
  }

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
          const { effect, delayMs } = this.buildRenderer(part);
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

  /** Construct the renderer for one loaded part, plus its part-stagger delay. */
  private buildRenderer(part: LoadedPart): { effect: EffectRenderer; delayMs: number } {
    switch (part.kind) {
      case "str":
        return { effect: new StrEffect(this.scene, part.str), delayMs: part.str.startDelayMs ?? 0 };
      case "cylinder":
        return { effect: new CylinderEffect(this.scene, part.cyl, this.cellSize), delayMs: part.cyl.startDelayMs ?? 0 };
      case "threeD":
        return { effect: new ThreeDEffect(this.scene, part.three, this.cellSize), delayMs: part.three.startDelayMs ?? 0 };
      case "sprAnim":
        return { effect: new SprAnimEffect(this.scene, part.spr, this.cellSize), delayMs: part.spr.startDelayMs ?? 0 };
      case "quadHorn":
        return { effect: new QuadHornEffect(this.scene, part.quad, this.cellSize), delayMs: part.quad.startDelayMs ?? 0 };
      case "groundAura":
        return { effect: new GroundAuraEffect(this.scene, part.aura, this.cellSize), delayMs: 0 };
      case "swirlingAura":
        return { effect: new SwirlingAuraEffect(this.scene, part.texture, this.cellSize), delayMs: 0 };
      case "levelBubble":
        return { effect: new Level99BubbleEffect(this.scene, part.texture, this.cellSize), delayMs: 0 };
      case "maxLevelAura":
        return {
          effect: new MaxLevelAuraEffect(this.scene, part.max.frames, part.max.rings, part.max.color, this.cellSize),
          delayMs: 0,
        };
    }
  }

  /** Reconcile the persistent level auras with the actors that currently qualify,
   *  keyed by tier: "l99" = the base-99 aura (glow/swirl/bubbles), "max" = the
   *  EXE-recovered gold base-250 4th-job aura (CLevel150Effect). Idempotent per
   *  frame: spawns an aura for a newly-qualifying actor, re-spawns if its tier
   *  changed, and disposes it when the actor drops out (vanished / rewound). Called
   *  each frame from the map's render loop. */
  syncAuras(qualifying: Map<number, AuraTier>, nowMs: number): void {
    if (this.disposed) return;
    for (const [aid, a] of this.auras) {
      if (qualifying.get(aid) !== a.tier) {
        for (const e of a.effects) e.dispose();
        this.auras.delete(aid);
      }
    }
    for (const [aid, tier] of qualifying) {
      if (this.auras.has(aid)) continue;
      const parts = tier === "max" ? maxLevelAuraParts(AURA_GOLD) : levelAuraParts();
      const effects = parts.map((p) => this.buildRenderer(p).effect);
      this.auras.set(aid, { effects, spawnMs: nowMs, tier });
    }
  }

  /** Advance every live effect to `nowMs`, culling finished ones. Drives
   *  keyframes off elapsed recording time so pause/scrub behave. */
  update(nowMs: number, camera: PerspectiveCamera): void {
    // Persistent auras: follow their actor and render. Clamp elapsed ≥ 0 so a
    // backward scrub (nowMs < spawnMs) keeps the aura up rather than hiding it —
    // it's a level-driven, always-on visual, not a timed one.
    for (const [aid, a] of this.auras) {
      const p = this.entities.worldPosOf(aid, this.followTmp);
      if (!p) continue; // actor not placed this frame; syncAuras will cull if gone
      const elapsed = Math.max(0, nowMs - a.spawnMs);
      for (const e of a.effects) e.update(elapsed, camera, p, true);
    }
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
    for (const a of this.auras.values()) for (const e of a.effects) e.dispose();
    this.auras.clear();
  }
}
