// Fullscreen overlay that plays the replay back as a 3D scene: the recording's
// map (built from ragassets' GAT/GND/RSW/RSM via the ported sim modules), the
// player + every mob walking the paths the server told them to, attacks driving
// the sprite's attack pose, and floating damage numbers over the targets.
//
// Read-only viewer: no click-to-move. The player's actions come straight from
// the replay's event streams keyed off a Timeline clock the controls expose
// (play/pause, speed, scrub).
//
// Lazy-loaded by the toolbar entry point — three.js + map binaries are heavy
// and only ship when a user actually opens the viewer.

import { useEffect, useMemo, useRef, useState } from "react";
import { Raycaster, Vector2, Vector3 } from "three";
import { t } from "../../i18n";
import type { ReferenceDb } from "../../db/loader";
import type { Replay } from "../../rrf/types";
import { Engine } from "../../sim/render/engine";
import { buildWorld, type MapManifest, type World } from "../../sim/render/scene";
import { MAPS_ROOT, bgmIndexUrl, bgmTrackUrl } from "../../sim/ragassets";
import { findPath } from "../../sim/pathfind";
import { CursorAnimator } from "../../sim/cursor";
import { DamageTextLayer } from "./DamageText";
import { type AuraTier, EffectsLayer } from "./Effects";
import {
  hasSkillEffect,
  preloadSkillMap,
  skillEntry,
  soundsForEffect,
  soundsForSkill,
} from "../../sim/render/effectAssets";
import { AudioManager } from "../../sim/render/audio";
import { weaponSwingSound } from "../../sim/render/weaponSound";
import { EntityTable } from "./Entities";
import { EventCursor, Timeline } from "./Timeline";
import { BuffBar, CastBarLayer, CastNameLayer, HoverTooltip, VitalBars, projectToScreen } from "./HudOverlay";
import { lookAtStart } from "./playerState";
import { monsterName, npcName, playerName } from "../explorer/entityNames";
import { SP_HP, SP_MAXHP, SP_SP, SP_MAXSP } from "../../aggregate";
import { UNITS_PER_PX } from "../../sim/sprite";

// rAthena SP_AP / SP_MAXAP for 4th-job replays. Not surfaced from aggregate/
// because AP isn't yet used elsewhere; kept local so a downstream refactor
// there won't force churn in the map viewer.
const SP_AP = 219;
const SP_MAXAP = 220;

// World-space drop below the character's ground anchor to clear the drawn
// boots when pinning the HP/SP/AP bars. ~18 sprite pixels — the boots' visible
// overhang below the ground-contact anchor. In world units it scales with zoom
// like the sprite, so the bars stay just under the feet at every zoom (a fixed
// screen-pixel margin can't, since the overhang grows as you zoom in).
const FEET_BELOW_ANCHOR_WORLD = 18 * UNITS_PER_PX;

// World-space rise above the ground anchor for the cast bar / skill-name labels
// — ~120 sprite pixels, the head height of a standing sprite (canvas anchorY is
// 152px up, the body tops out around here). Projecting this point puts the bar
// just above the head and, being a world offset, it scales with zoom so the
// labels stay pinned to the head instead of floating off when zoomed out.
const CAST_ABOVE_ANCHOR_WORLD = 120 * UNITS_PER_PX;

// Small safety margin past the recording's real duration (from ReplayData
// chunk 970) so a damage float / combo total that outlives the recording's own
// tail still finishes its fade before the clock auto-pauses. The bulk of the
// tail comes from the real duration now, so this stays small.
const PLAYBACK_TAIL_MS = 1500;

// Ground effects (Storm Gust, Arrow Storm, Pneuma, …) are persistent: the STR
// loops for this long, then it's culled. The 0x09ca stream doesn't carry the
// skill's real duration, so this is a single reasonable default (most ground
// AoEs run ~3–6s). GROUND_DEDUP_MS collapses the burst of unit cells one cast
// drops into a single centred effect.
const GROUND_EFFECT_MS = 4500;
const GROUND_DEDUP_MS = 600;
// Collapse a skill activation's repeated result packets (multi-hit damage, or a
// cast+use pair) into a single main-effect spawn.
const MAIN_EFFECT_DEDUP_MS = 500;
// Collapse a doubled server-effect (0x01f3) packet, while still letting a genuine
// re-use (a potion used again seconds later) spawn again.
const NOTIFY_DEDUP_MS = 200;

// A played sound can't be un-played, so SFX fire ONLY for events crossing the
// playhead during normal forward playback. A per-frame `audible` flag gates them;
// part of it is that the recording clock stepped forward by a *small* amount —
// this cap (ms of recording time) suppresses the initial priming drain (0 → now),
// a tab-refocus rAF spike, and any future scrub, all of which jump the clock far.
// Visuals still spawn on those frames; only audio is gated.
const AUDIBLE_STEP_CAP = 250;

type Phase = "loading" | "ready" | "error";

const SPEEDS = [0.5, 1, 2, 4] as const;

// Viewer display toggles persisted across sessions (localStorage). Level auras
// default OFF (they clutter the scene and most viewers don't want them); skill/
// world effects default ON. Read defensively so a corrupt/blocked store just
// yields the defaults.
const SETTINGS_KEY = "ragreplay.map.settings";
interface MapSettings {
  aura: boolean;
  effects: boolean;
  /** Skill/effect sound effects. */
  sfx: boolean;
  /** Background music (governed by the same master; no BGM source in this repo yet). */
  bgm: boolean;
}
function loadMapSettings(): MapSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<MapSettings>;
      // aura defaults false; effects/sfx/bgm default true (only an explicit false disables).
      return { aura: p.aura === true, effects: p.effects !== false, sfx: p.sfx !== false, bgm: p.bgm !== false };
    }
  } catch {
    /* storage unavailable / malformed — fall through to defaults */
  }
  return { aura: false, effects: true, sfx: true, bgm: true };
}

// The map→BGM-track catalogue (bgm/index.json), fetched once per app load and
// memoized so every viewer open reuses it. Never rejects (falls back to {} so a
// failed fetch just means no music, silently). Keys match `mapBaseName` output
// (instance maps as "1@<base>").
let bgmTablePromise: Promise<Record<string, string>> | null = null;
function loadBgmTable(): Promise<Record<string, string>> {
  if (!bgmTablePromise) {
    bgmTablePromise = fetch(bgmIndexUrl())
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { maps?: Record<string, string> } | null) => j?.maps ?? {})
      .catch(() => ({}));
  }
  return bgmTablePromise;
}

function mapBaseName(raw: string): string {
  // Replay map names land as e.g. "prontera.gat" — the asset server's tree is
  // keyed by the bare map name.
  const stripped = raw.replace(/\.gat$/i, "").trim();
  // Instance maps come as "<instanceId>@<base>" (e.g. "0qk1@gl_he"). The
  // <instanceId> rotates per session and isn't extracted to the asset server;
  // the shipped variant is always "1@<base>" (same map binaries, just keyed
  // under the canonical instance id 1). Strip the dynamic prefix.
  const at = stripped.indexOf("@");
  if (at >= 0) return `1@${stripped.slice(at + 1)}`;
  return stripped;
}

export default function ReplayMap({ replay, db, onClose }: { replay: Replay; db: ReferenceDb | null; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [, forceRender] = useState(0);

  const mapName = useMemo(() => mapBaseName(replay.sessionInfo.map || "prontera"), [replay]);
  const playerAid = replay.sessionInfo.aid;
  const playerEntity = replay.entities.get(playerAid);
  const playerLook = useMemo(
    () => (playerEntity ? lookAtStart(replay, playerEntity, db) : null),
    [replay, playerEntity, db],
  );

  // Sorted event arrays driving the per-frame Entity updates. The Replay
  // already has these sorted by time during decode (skill/cast/status are
  // deduped/sorted; damage/moves/positions/kills are append-order so we sort
  // defensively here — it's a one-time cost on open).
  const events = useMemo(() => {
    const by = <T extends { time: number }>(arr: ReadonlyArray<T>): T[] => [...arr].sort((a, b) => a.time - b.time);
    return {
      damage: by(replay.damage),
      vanishes: by(replay.vanishes),
      options: by(replay.optionChanges),
      moves: by(replay.moves),
      positions: by(replay.positions),
      casts: by(replay.skillCasts),
      uses: by(replay.skillUses),
      ground: by(replay.groundSkillUnits),
      notify: by(replay.notifyEffects),
      params: by(replay.paramChanges),
      // Local player's status changes only — drives the buff strip.
      status: by(replay.statusEvents.filter((e) => e.aid === playerAid)),
    };
  }, [replay, playerAid]);

  // Live values surfaced to the controls. Refs avoid re-creating the engine
  // when only the displayed time changes; `tick` updates a state slice each
  // frame so the React scrubber tracks playback.
  const timelineRef = useRef<Timeline>(
    new Timeline(Math.max(1, replay.sessionInfo.durationMs), PLAYBACK_TAIL_MS),
  );
  // Rebuilds the entity table + cursors from scratch so a rewind past their
  // internal cursor position starts clean (dead mobs alive again, damage floats
  // cleared). Wired by the setup effect once the world lands.
  const restartRef = useRef<(() => void) | null>(null);
  const [speed, setSpeed] = useState(1);
  // Playback starts PAUSED behind the intro dialog; dismissing it (below) is
  // what kicks off the replay, so the user reads the warning before it plays.
  const [isPlaying, setIsPlaying] = useState(false);
  // "Highly experimental" intro shown over the viewer on open. Dismissing it
  // starts playback.
  const [showIntro, setShowIntro] = useState(true);

  // Persisted display toggles. State drives the button UI + localStorage; refs
  // feed the imperative render loop (which reads them each frame without a
  // re-subscribe). aura OFF / effects ON by default.
  const initialSettings = useMemo(loadMapSettings, []);
  const [auraEnabled, setAuraEnabled] = useState(initialSettings.aura);
  const [effectsEnabled, setEffectsEnabled] = useState(initialSettings.effects);
  const [sfxEnabled, setSfxEnabled] = useState(initialSettings.sfx);
  const [bgmEnabled, setBgmEnabled] = useState(initialSettings.bgm);
  const auraEnabledRef = useRef(auraEnabled);
  const effectsEnabledRef = useRef(effectsEnabled);
  const sfxEnabledRef = useRef(sfxEnabled);
  const bgmEnabledRef = useRef(bgmEnabled);
  // The audio manager for this viewer (created by the setup effect). The SFX/BGM
  // toggles drive it through this ref, mirroring effectsEnabledRef.
  const audioRef = useRef<AudioManager | null>(null);
  useEffect(() => {
    auraEnabledRef.current = auraEnabled;
    effectsEnabledRef.current = effectsEnabled;
    sfxEnabledRef.current = sfxEnabled;
    bgmEnabledRef.current = bgmEnabled;
    audioRef.current?.setSfxMuted(!sfxEnabled);
    audioRef.current?.setBgmMuted(!bgmEnabled);
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({ aura: auraEnabled, effects: effectsEnabled, sfx: sfxEnabled, bgm: bgmEnabled }),
      );
    } catch {
      /* storage blocked — the toggle still works for this session */
    }
  }, [auraEnabled, effectsEnabled, sfxEnabled, bgmEnabled]);

  useEffect(() => {
    if (!playerLook) {
      setPhase("error");
      return;
    }
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    let disposed = false;

    const engine = new Engine(canvas);
    engine.resize(wrap.clientWidth, wrap.clientHeight);
    // Start rotated 180° so the camera sits BEHIND the player (looking north
    // instead of south). Entities' initial facing is 0 = south, so with the
    // camera at yaw 0 you'd see the front of the character. Yaw 180 flips the
    // camera to the north side and the player's sprite direction resolves to
    // `back` — the classic "over the shoulder / walking forward" starting
    // view. The user can still right-drag to rotate freely.
    engine.cam.rotate(180);

    let world: World | null = null;
    let entities: EntityTable | null = null;
    let damageLayer: DamageTextLayer | null = null;
    let effectsLayer: EffectsLayer | null = null;
    let cursor: CursorAnimator | null = null;

    let damageCursor: EventCursor<typeof events.damage[number]> | null = null;
    let vanishCursor: EventCursor<typeof events.vanishes[number]> | null = null;
    let optionCursor: EventCursor<typeof events.options[number]> | null = null;
    let moveCursor: EventCursor<typeof events.moves[number]> | null = null;
    let posCursor: EventCursor<typeof events.positions[number]> | null = null;
    let castCursor: EventCursor<typeof events.casts[number]> | null = null;
    let useCursor: EventCursor<typeof events.uses[number]> | null = null;
    let groundCursor: EventCursor<typeof events.ground[number]> | null = null;
    let notifyCursor: EventCursor<typeof events.notify[number]> | null = null;
    let paramCursor: EventCursor<typeof events.params[number]> | null = null;
    let statusCursor: EventCursor<typeof events.status[number]> | null = null;
    // Drain the cursors once even while paused so the starting frame (player +
    // entities placed at t=0, camera on them) shows behind/after the intro
    // dialog, before the user presses play. Reset by buildRuntime on restart.
    let primed = false;
    // Previous frame's recording time, for the SFX `audible` gate's step check
    // (a small forward step = normal playback; a big jump = prime/scrub/refocus).
    // Reset with the cursors on rebuild so nothing bleeds across a restart.
    let lastNowMs = 0;

    // Web Audio SFX/BGM manager (one per mount). The left-side SFX/BGM toggles
    // drive it via audioRef; unlocked on the first play gesture (browsers block
    // audio until then). Muted state seeded from the current toggle refs.
    const audio = new AudioManager();
    audio.setSfxMuted(!sfxEnabledRef.current);
    audio.setBgmMuted(!bgmEnabledRef.current);
    audioRef.current = audio;
    // The map's looping BGM: resolve mapName → track via the catalogue, then set it
    // (starts on the first play gesture, governed by the "Música" toggle). A map
    // with no track / a failed index fetch just stays silent.
    loadBgmTable().then((table) => {
      const track = table[mapName];
      if (track && !disposed) audio.setBgm(bgmTrackUrl(track));
    });

    // Play a resolved sound-name list (from soundsForSkill/soundsForEffect) as
    // SFX. v1 is flat: master volume, no distance/pan (the spatial pass is a
    // follow-up). Guarded so a rejected lookup never breaks the drain.
    const playSounds = (names: Promise<string[]>): void => {
      names
        .then((list) => {
          for (const n of list) audio.play(n);
        })
        .catch(() => {});
    };

    // Local player's active buffs: EFST id → expiry time (ms, recording clock;
    // Infinity when the status has no timed duration). Rebuilt on restart. The
    // strip only re-renders when this set changes (`buffsDirty`).
    const activeBuffs = new Map<number, number>();
    let buffsDirty = false;

    // Per-activation dedupe for ground effects: `${casterAid}:${skillId}` → last
    // spawn ms, so the burst of unit cells one cast drops spawns a single effect.
    // Cleared on restart.
    const lastGroundSpawn = new Map<string, number>();
    // Same idea for a skill's MAIN effect (effectId): `${skillId}:${targetAid}` →
    // last spawn ms, so a multi-hit / cast+use activation only spawns it once.
    const lastMainEffect = new Map<string, number>();
    // Server-effect (0x01f3) dedup: `${aid}:${effectId}` → last spawn ms, to
    // collapse a packet that arrives doubled while still letting a genuine re-use
    // (a potion used again seconds later) fire again. Cleared on restart.
    const lastNotifyEffect = new Map<string, number>();

    // Spawn a skill's main effect ON THE TARGET, attached (follows it), and play
    // its main sound. This is the arrow-rain / bolt / heal-sparkle that belongs
    // over the entity the skill was used on — NOT on the caster. Deduped per
    // activation (one shared window for visual + sound, so a skill that fires both
    // useCursor and damageCursor doesn't double up). Self-cast skills pass the
    // caster as the target. `audible` gates ONLY the sound (visuals always spawn).
    // The sound is resolved straight from the effect table — NOT gated on
    // hasSkillEffect — because many skills have a sound but no visual we render.
    const spawnMainEffect = (skillId: number, targetAid: number, nowMs: number, audible: boolean): void => {
      if (!skillId || !targetAid || !entities) return;
      const key = `${skillId}:${targetAid}`;
      const last = lastMainEffect.get(key);
      if (last != null && nowMs - last < MAIN_EFFECT_DEDUP_MS) return;
      lastMainEffect.set(key, nowMs);
      const pos = entities.worldPosOf(targetAid, mainEffectTmp);
      if (effectsLayer && hasSkillEffect(skillId)) {
        effectsLayer.spawnSkillMain(skillId, targetAid, pos, nowMs, { attached: true });
      }
      if (audible) playSounds(soundsForSkill(skillId));
    };

    // Player vitals — updated as paramChange events drain. Kept in refs so the
    // per-frame HUD read is O(1) with no React state churn.
    const vitals = { hp: 0, maxHp: 0, sp: 0, maxSp: 0, ap: 0, maxAp: 0 };

    // DOM HUD siblings of the canvas: hover-tooltip + player HP/SP/AP bars +
    // per-actor skill cast progress bars.
    const tooltip = new HoverTooltip(wrap);
    const vitalBars = new VitalBars(wrap);
    const castBars = new CastBarLayer(wrap);
    const castNames = new CastNameLayer(wrap);
    const buffBar = new BuffBar(wrap, (id) => db?.resolveStatus(id) ?? `Efeito #${id}`);

    // Hover state — last cursor position (client coords) + latest hit's aid.
    // Reset to -1 so a still cursor doesn't trigger a hover on first mount.
    let hoverX = -1;
    let hoverY = -1;
    const hoverRay = new Raycaster();
    const hoverNdc = new Vector2();
    const hoverTmp = new Vector3();

    const onResize = () => engine.resize(wrap.clientWidth, wrap.clientHeight);
    const ro = new ResizeObserver(onResize);
    ro.observe(wrap);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === " " && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        timelineRef.current.togglePlay();
        if (timelineRef.current.isPlaying) audio.resume(); // keyboard toggle is a gesture
        setIsPlaying(timelineRef.current.isPlaying);
      }
    };
    window.addEventListener("keydown", onKey);

    // Tab visibility: suspend the audio context when hidden (the `audible` gate
    // already drops the refocus rAF spike, so returning resumes without a backlog).
    const onVisibility = () => {
      if (document.hidden) audio.suspend();
      else if (timelineRef.current.isPlaying) audio.resume();
    };
    document.addEventListener("visibilitychange", onVisibility);

    // Right-drag rotates the camera. Left-click is intentionally disabled —
    // the map viewer is a playback, not an interactive sim. The cursor swaps
    // to the two-curvy-arrows rotate cursor while dragging, mirroring RO.
    let rotating = false;
    let lastX = 0;
    const onPointerDown = (e: MouseEvent) => {
      if (e.button === 2) {
        rotating = true;
        lastX = e.clientX;
        cursor?.set("rotate");
        e.preventDefault();
      }
    };
    const onPointerMove = (e: MouseEvent) => {
      // Track for hover regardless of rotation — the per-frame raycast reads
      // this (a still cursor over a walking mob should keep the tooltip live).
      hoverX = e.clientX;
      hoverY = e.clientY;
      if (!rotating) return;
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      engine.cam.rotate(-(dx / wrap.clientWidth) * 360);
    };
    const onPointerLeave = () => {
      hoverX = -1;
      hoverY = -1;
    };
    canvas.addEventListener("mouseleave", onPointerLeave);
    const onPointerUp = (e: MouseEvent) => {
      if (e.button === 2) {
        rotating = false;
        cursor?.set("default");
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      engine.cam.zoom(-e.deltaY);
    };
    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    canvas.addEventListener("mousedown", onPointerDown);
    window.addEventListener("mousemove", onPointerMove);
    window.addEventListener("mouseup", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", onContextMenu);

    const charWorldTmp = new Vector3();
    const targetWorldTmp = new Vector3();
    const castWorldTmp = new Vector3();
    const groundWorldTmp = new Vector3();
    const mainEffectTmp = new Vector3();
    const notifyWorldTmp = new Vector3();
    const camUpTmp = new Vector3();
    // Reused each frame to reconcile level auras by tier (see syncAuras below).
    const auraTiers = new Map<number, AuraTier>();
    const feetTmp = new Vector3();
    const screenXY = { x: 0, y: 0 };
    // Throttled React update so the scrubber/time text don't re-render every
    // frame. Declared *before* engine.start so the immediate first frame can
    // read it (engine.start renders one frame synchronously to avoid a blank).
    let tickSinceUiPush = 0;

    engine.start((dt) => {
      engine.cam.tickZoom(dt);
      cursor?.update(dt);
      if (!world || !entities || !damageLayer) return;
      world.update(dt);

      // Apply the skill/world-effects toggle before draining cursors (so a
      // disabled state drops this frame's spawns instead of clearing them after).
      // Cheap: setEffectsEnabled early-returns when the flag is unchanged.
      effectsLayer?.setEffectsEnabled(effectsEnabledRef.current);

      const advanced = timelineRef.current.tick(dt);
      const nowMs = timelineRef.current.time;
      // Scrub-safety gate for SFX: sounds fire ONLY for events crossing the
      // playhead during normal forward playback. `primed` here is the PREVIOUS
      // frame's value (read before the drain flips it), so the priming drain
      // itself is silent. Big clock jumps (prime 0→now, tab-refocus rAF spike,
      // any future scrub) exceed the step cap and are silent too. Visuals are NOT
      // gated — only this boolean guards the sound plays inside the seams.
      const stepMs = nowMs - lastNowMs;
      const audible =
        timelineRef.current.isPlaying &&
        advanced &&
        primed &&
        stepMs >= 0 &&
        stepMs <= AUDIBLE_STEP_CAP &&
        !document.hidden;
      if (advanced || !primed) {
        primed = true;
        // Drain cursors up to the playback time, applying each event to the
        // entity table / damage / cast layers.
        posCursor!.advanceTo(nowMs, (ev) => {
          entities!.applyFixPos(ev);
        });
        moveCursor!.advanceTo(nowMs, (ev) => {
          entities!.applyMove(ev, (from, to) => findPath(world!.gat, from, to));
        });
        castCursor!.advanceTo(nowMs, (ev) => {
          entities!.applyCast(nowMs, ev.source, ev.target, ev.castMs, ev.skillId);
          const name = db?.resolveSkill(ev.skillId) ?? `skill#${ev.skillId}`;
          castNames.spawn(ev.source, name, nowMs, ev.castMs);
          castBars.spawn(ev.source, nowMs, ev.castMs);
          // The lock-on cast circle spins on the ground under the caster while the
          // bar fills (EF_LOCKON). The skill's MAIN effect, by contrast, belongs on
          // the TARGET and is spawned when the skill lands (skill-use / damage
          // packet below), not on the caster at cast start.
          const casterPos = entities!.worldPosOf(ev.source, castWorldTmp);
          if (casterPos) effectsLayer!.spawnCastCircle(ev.source, casterPos, nowMs, ev.castMs);
        });
        useCursor!.advanceTo(nowMs, (ev) => {
          // No-damage skills (heals/buffs) land via skill-use: play the main
          // effect + sound on the target it was used on (self for a buff).
          spawnMainEffect(ev.skillId, ev.target || ev.source, nowMs, audible);
        });
        groundCursor!.advanceTo(nowMs, (ev) => {
          // Persistent ground effect (Storm Gust/Arrow Storm/…) at the unit's
          // cell. The skill is attributed from the caster's recent use/cast; one
          // effect per activation (the cell burst is deduped), looped for a fixed
          // lifetime. Anchored in scene space (X/Y negated like the actors).
          if (!ev.skillId) return;
          const eff = skillEntry(ev.skillId);
          if (eff?.groundEffectId == null) return;
          const key = `${ev.casterAid}:${ev.skillId}`;
          const last = lastGroundSpawn.get(key);
          if (last != null && nowMs - last < GROUND_DEDUP_MS) return;
          lastGroundSpawn.set(key, nowMs);
          const cs = world!.cellSize;
          const h = world!.gat.heightAt(ev.gx, ev.gy, 0.5, 0.5);
          groundWorldTmp.set(-((ev.gx + 0.5) * cs), -h, (ev.gy + 0.5) * cs);
          effectsLayer!.spawn(eff.groundEffectId, ev.casterAid, groundWorldTmp, nowMs, {
            loop: true,
            durationMs: GROUND_EFFECT_MS,
          });
          // Ground effect sound once per activation (already deduped above).
          if (audible) playSounds(soundsForEffect(eff.groundEffectId));
        });
        notifyCursor!.advanceTo(nowMs, (ev) => {
          // Server-pushed effect (0x01f3): item-use sparkle + other specialeffects.
          // Render effectId ON the entity (attached, follows it) and play its sound.
          // Deduped so a doubled packet spawns once; a genuine re-use fires again.
          if (!ev.effectId || !effectsLayer || !entities) return;
          const key = `${ev.aid}:${ev.effectId}`;
          const last = lastNotifyEffect.get(key);
          if (last != null && nowMs - last < NOTIFY_DEDUP_MS) return;
          lastNotifyEffect.set(key, nowMs);
          const pos = entities.worldPosOf(ev.aid, notifyWorldTmp);
          if (!pos) return; // entity not placed this frame → nothing to anchor to
          effectsLayer.spawn(ev.effectId, ev.aid, pos, nowMs, { attached: true });
          if (audible) playSounds(soundsForEffect(ev.effectId));
        });
        damageCursor!.advanceTo(nowMs, (ev) => {
          entities!.applyDamage(nowMs, ev.source, ev.target, ev.skillId);
          const pos = entities!.worldPosOf(ev.target, targetWorldTmp);
          if (pos) {
            damageLayer!.spawn(ev.target, pos, ev.damage, ev.hitType, ev.source === playerAid, nowMs, ev.hits);
            // Damage skills land via their damage packet: the main effect once on
            // the target (Arrow Storm rain, bolt impact), plus the per-hit effect
            // pinned where each hit landed (a quick flash, not attached).
            spawnMainEffect(ev.skillId, ev.target, nowMs, audible);
            const eff = skillEntry(ev.skillId);
            if (eff?.hitEffectId != null) {
              effectsLayer!.spawn(eff.hitEffectId, ev.target, pos, nowMs);
              // Hit-spark sound once per damage event — not per hit (ev.hits is a
              // single multi-hit packet; the same-name throttle collapses any
              // rapid repeats at speed).
              if (audible) playSounds(soundsForEffect(eff.hitEffectId));
            }
            // Auto-attack (skillId 0): the weapon's swing sound, resolved from the
            // ATTACKER's equipped weapon — a sword's clash, a bow's twang, bare
            // fists otherwise. Only for a player attacker (entities.actor().
            // weaponView() reads PlayerLook, which only exists for player actors);
            // a mob's auto-attack has no client-side sound to draw on yet, so it
            // stays silent rather than borrowing a player's fist swing.
            if (!ev.skillId && audible && replay.entities.get(ev.source)?.kind === "pc") {
              const name = weaponSwingSound(entities!.actor(ev.source)?.weaponView() ?? null);
              if (name) audio.play(name);
            }
          }
        });
        vanishCursor!.advanceTo(nowMs, (ev) => {
          entities!.applyVanish(nowMs, ev.aid, ev.kind);
        });
        optionCursor!.advanceTo(nowMs, (ev) => {
          entities!.applyOption(ev.aid, ev.option);
        });
        statusCursor!.advanceTo(nowMs, (ev) => {
          if (ev.isOn) {
            // leftMs is the remaining duration at this event; 0 = no timer.
            activeBuffs.set(ev.statusId, ev.leftMs > 0 ? ev.time + ev.leftMs : Infinity);
          } else {
            activeBuffs.delete(ev.statusId);
          }
          buffsDirty = true;
        });
        paramCursor!.advanceTo(nowMs, (ev) => {
          const n = Number(ev.value);
          switch (ev.type) {
            case SP_HP: vitals.hp = n; break;
            case SP_MAXHP: vitals.maxHp = n; break;
            case SP_SP: vitals.sp = n; break;
            case SP_MAXSP: vitals.maxSp = n; break;
            case SP_AP: vitals.ap = n; break;
            case SP_MAXAP: vitals.maxAp = n; break;
          }
        });
      }
      // Record this frame's playhead for the next frame's `audible` step check.
      lastNowMs = nowMs;

      entities.update(dt, nowMs, engine.cam.direction, engine.cam.camera);
      damageLayer.update(nowMs, engine.cam.camera);
      // Skill/world STR effects. Guarded so a bad effect never breaks playback.
      try {
        effectsLayer?.update(nowMs, engine.cam.camera);
      } catch (err) {
        console.warn("[ReplayMap] effects update failed", err);
      }

      // Expire timed buffs whose duration ran out with no explicit "off" event
      // (a buff can lapse silently). Only mutate when something actually drops.
      for (const [id, expiresAt] of activeBuffs) {
        if (nowMs > expiresAt) {
          activeBuffs.delete(id);
          buffsDirty = true;
        }
      }
      // Reconcile the right-side buff strip only when the active set changed.
      if (buffsDirty) {
        buffBar.setActive([...activeBuffs.keys()]);
        buffsDirty = false;
      }

      // Follow the player.
      const pos = entities.worldPosOf(playerAid, charWorldTmp);
      if (pos) engine.cam.setTarget(pos);

      // HUD: HP/SP/AP bars pinned just below the sprite's BOOTS. The walker's
      // anchor is the ground-contact cell, but the drawn boots extend a little
      // below that on screen — and that overhang grows with zoom, so a fixed
      // CSS margin can't clear it (at max zoom the bars ended up over the
      // sprite). Project a point offset below the anchor along camera-up by a
      // small sprite-relative amount (FEET_BELOW_ANCHOR_WORLD): the offset
      // scales with zoom exactly like the sprite, so the bars sit right under
      // the boots at every zoom. A tiny CSS margin adds the final gap.
      const wrapW = wrap.clientWidth;
      const wrapH = wrap.clientHeight;
      // Camera-up in world space — shared by the vitals (offset below the feet)
      // and the cast bar / skill name (offset above the head). Both offsets are
      // sprite-relative world distances, so they scale with zoom instead of
      // floating away when zoomed out.
      camUpTmp.set(0, 1, 0).applyQuaternion(engine.cam.camera.quaternion);
      if (pos) {
        feetTmp.copy(pos).addScaledVector(camUpTmp, -FEET_BELOW_ANCHOR_WORLD);
        if (projectToScreen(feetTmp, engine.cam.camera, wrapW, wrapH, screenXY)) {
          vitalBars.setVisible(true);
          vitalBars.setScreenXY(screenXY.x, screenXY.y);
          vitalBars.setValues(vitals.hp, vitals.maxHp, vitals.sp, vitals.maxSp, vitals.ap, vitals.maxAp);
        } else {
          vitalBars.setVisible(false);
        }
      } else {
        vitalBars.setVisible(false);
      }
      // Cast bar + skill-name labels: project a point a sprite's-height ABOVE
      // the caster's feet (CAST_ABOVE_ANCHOR_WORLD along camera-up) so the
      // anchor sits at the head and tracks the sprite as you zoom — a fixed CSS
      // margin off the feet floated the labels way above the head when zoomed
      // out. The small remaining CSS margins only stack the name above the bar.
      const projectCaster = (aid: number, out: { x: number; y: number }) => {
        const caster = entities!.worldPosOf(aid, castWorldTmp);
        if (!caster) return false;
        castWorldTmp.addScaledVector(camUpTmp, CAST_ABOVE_ANCHOR_WORLD);
        return projectToScreen(castWorldTmp, engine.cam.camera, wrapW, wrapH, out);
      };
      castBars.update(nowMs, projectCaster);
      castNames.update(nowMs, projectCaster);

      // Level auras: every visible player at base level ≥ 99 gets the persistent
      // aura, tiered by level — ≥ 250 shows the EXE-recovered gold 4th-job aura
      // (EF_LEVEL4TH), otherwise the base-99 aura. Reconciled each frame so it
      // follows spawns, vanishes and backward-seek rebuilds. (The exact 150/160/185
      // tiers between 99 and 250 still show the 99 aura — a known simplification.)
      auraTiers.clear();
      // When auras are toggled off, leave the tier map empty so syncAuras disposes
      // any that were showing — the toggle takes hold immediately, mid-playback.
      if (auraEnabledRef.current) {
        for (const v of entities!.visibleActors()) {
          const ent = replay.entities.get(v.aid);
          const lvl = ent?.kind === "pc" ? (ent.level ?? 0) : 0;
          if (lvl >= 250) auraTiers.set(v.aid, "max");
          else if (lvl >= 99) auraTiers.set(v.aid, "l99");
        }
      }
      effectsLayer!.syncAuras(auraTiers, nowMs);

      // Hover — raycast against every visible actor billboard, then reject
      // hits that land in the sprite's transparent padding (each billboard is
      // a full-canvas quad, so a raw mesh hit picks up a huge invisible area).
      // Sample the underlying canvas at the hit UV; only counts if the pixel
      // is opaque. The tooltip is pinned at the actor's projected foot pixel
      // so it follows the sprite rather than the cursor.
      if (hoverX >= 0) {
        const rect = canvas.getBoundingClientRect();
        hoverNdc.set(((hoverX - rect.left) / rect.width) * 2 - 1, -(((hoverY - rect.top) / rect.height) * 2 - 1));
        hoverRay.setFromCamera(hoverNdc, engine.cam.camera);
        const actorList = entities.visibleActors();
        const meshes = actorList.map((v) => v.mesh);
        const hits = hoverRay.intersectObjects(meshes, false);
        // Walk hits nearest-first, keeping the first one whose sprite pixel
        // is opaque. Anything else is transparent padding around the sprite.
        let matched: (typeof actorList)[number] | null = null;
        for (const hit of hits) {
          const found = actorList.find((v) => v.mesh === hit.object);
          if (!found || !hit.uv) continue;
          const alpha = found.billboard.alphaAt(hit.uv.x, hit.uv.y);
          if (alpha > 24) { matched = found; break; }
        }
        if (matched) {
          const entity = replay.entities.get(matched.aid);
          // Players keep their character name; mobs resolve through the DP
          // database (pt-BR species) like the by-monster tab (the packet name is
          // often an English/instance label like "#grn_3"); NPCs get their
          // cleaned display name (hidden/effect NPCs resolve to nothing).
          const name =
            entity?.kind === "pc"
              ? playerName(replay, matched.aid)
              : entity?.kind === "npc"
                ? npcName(replay, db, matched.aid)
                : monsterName(replay, db, matched.aid);
          const worldPos = name ? entities.worldPosOf(matched.aid, hoverTmp) : null;
          if (worldPos && projectToScreen(worldPos, engine.cam.camera, wrapW, wrapH, screenXY)) {
            tooltip.showAt(name, screenXY.x, screenXY.y);
          } else {
            tooltip.hide();
          }
        } else {
          tooltip.hide();
        }
      } else {
        tooltip.hide();
      }

      // Throttle React updates: every ~10 frames push the time so the slider
      // tracks without burning a render per frame. Also mirror the timeline's
      // playing flag so the button swaps to the play icon when Timeline
      // auto-pauses at the end of the recording.
      tickSinceUiPush++;
      if (tickSinceUiPush >= 10) {
        tickSinceUiPush = 0;
        // Triggers the throttled re-render that refreshes the scrubber/readout
        // (which read the timeline clock directly, clamped to the duration).
        forceRender((n) => n + 1);
        setIsPlaying(timelineRef.current.isPlaying);
      }
    });

    // Build the map asynchronously; reveal the scene once the world is in.
    (async () => {
      try {
        // Kick off the map fetch and the pixel-font preload in parallel — the
        // font is small (< 20KB) and the map is dozens of textures, so the
        // font almost always wins the race. Rendering damage floats / cast
        // labels / tooltips before Galmuri11 lands would draw them in the
        // Impact/Arial Black fallback, then swap once the woff2 arrives (a
        // visible font flash on the first frames of playback).
        const fontReady = document.fonts
          ? document.fonts.load("16px Galmuri11").catch(() => null)
          : Promise.resolve();
        // Warm the skill→effect map so the per-event drain can look up effect ids
        // synchronously. Awaited below (with the font) before the viewer goes
        // "ready" — it's ~20KB while the map is dozens of textures, but on a slow
        // link an unawaited fetch could land after the first casts drained,
        // silently skipping their effects. Never rejects (falls back to {}).
        const skillMapReady = preloadSkillMap();
        const base = `${MAPS_ROOT}${mapName}/`;
        const manifest = (await fetch(`${base}manifest.json`).then((r) => r.json())) as MapManifest;
        if (disposed) return;
        const built = await buildWorld(base, manifest);
        if (disposed) {
          built.dispose();
          return;
        }
        world = built;
        engine.add(world.root);
        engine.setFog(world.fog);
        // RO mouse cursors (cursors.spr/.act): the animated default arrow +
        // the two-curvy-arrows rotate cursor. Toggled by the pointer handlers
        // and cycled per frame.
        cursor = new CursorAnimator(canvas, base);
        cursor.add("default", manifest.ui?.cursor);
        cursor.add("rotate", manifest.ui?.cursorRotate);
        cursor.set("default");
        // Extracted so restartRef can re-run it: EntityTable and DamageTextLayer
        // hold per-actor pose/dead state and the pool of active floats, none of
        // which can be un-applied by seeking cursors alone. Disposing +
        // recreating them is the simplest guaranteed-clean rewind.
        const buildRuntime = () => {
          entities?.dispose();
          damageLayer?.dispose();
          effectsLayer?.dispose();
          entities = new EntityTable(engine.scene, world!, replay, playerAid, playerLook, db);
          damageLayer = new DamageTextLayer(engine.scene);
          effectsLayer = new EffectsLayer(engine.scene, entities, world!.cellSize);
          damageCursor = new EventCursor(events.damage);
          vanishCursor = new EventCursor(events.vanishes);
          optionCursor = new EventCursor(events.options);
          moveCursor = new EventCursor(events.moves);
          posCursor = new EventCursor(events.positions);
          castCursor = new EventCursor(events.casts);
          useCursor = new EventCursor(events.uses);
          groundCursor = new EventCursor(events.ground);
          notifyCursor = new EventCursor(events.notify);
          paramCursor = new EventCursor(events.params);
          statusCursor = new EventCursor(events.status);
          vitals.hp = vitals.maxHp = vitals.sp = vitals.maxSp = vitals.ap = vitals.maxAp = 0;
          activeBuffs.clear();
          lastGroundSpawn.clear();
          lastMainEffect.clear();
          lastNotifyEffect.clear();
          buffsDirty = true; // force one reconcile so a rewind clears the strip
          primed = false; // re-drain the starting frame for the fresh cursors
          lastNowMs = 0; // reset the SFX step baseline so nothing bleeds across
          audio.stopAll(); // cut any live voices before the fresh drain
        };
        buildRuntime();
        // Open paused behind the intro dialog — pressing "Entendi" starts it.
        timelineRef.current.setPlaying(false);
        restartRef.current = () => {
          buildRuntime();
          timelineRef.current.seek(0);
          timelineRef.current.setPlaying(true);
          audio.resume(); // restart is a user gesture — (re)unlock audio
          forceRender((n) => n + 1);
          setIsPlaying(true);
        };
        // Warm the session's frequent sounds so the first cast of each skill isn't
        // dropped by the late-play window (fetch+decode > 150ms on a cold buffer).
        // preload() before the first gesture just queues names; audio.resume()
        // fetches them once the context unlocks. Best-effort, never blocks ready.
        void (async () => {
          await skillMapReady;
          const ids = new Set<number>();
          for (const e of events.casts) if (e.skillId) ids.add(e.skillId);
          for (const e of events.uses) if (e.skillId) ids.add(e.skillId);
          for (const e of events.damage) if (e.skillId) ids.add(e.skillId);
          const names = new Set<string>();
          await Promise.all(
            [...ids].map(async (id) => {
              for (const n of await soundsForSkill(id)) names.add(n);
              const eff = skillEntry(id);
              if (eff?.hitEffectId != null) for (const n of await soundsForEffect(eff.hitEffectId)) names.add(n);
              if (eff?.groundEffectId != null) for (const n of await soundsForEffect(eff.groundEffectId)) names.add(n);
            }),
          );
          if (!disposed) audio.preload([...names]);
        })().catch(() => {});
        // Wait for Galmuri11 before unblocking playback — the first damage /
        // cast label / tooltip text draws its Canvas texture once at spawn, so
        // late-arrival of the font would leave those first labels frozen in
        // the fallback font for their entire lifetime.
        await fontReady;
        await skillMapReady;
        if (disposed) return;
        setPhase("ready");
        forceRender((n) => n + 1);
        if (import.meta.env.DEV) {
          // Use property getters so the handle always points at the CURRENT
          // closure bindings — buildRuntime() reassigns entities/damageLayer/
          // cursors on restart, and a snapshot object would go stale.
          Object.defineProperty(window, "__replayMap", {
            configurable: true,
            get() {
              return {
                engine,
                world,
                replay,
                get entities() { return entities; },
                get damageLayer() { return damageLayer; },
                get effectsLayer() { return effectsLayer; },
                castNames,
                castBars,
                buffBar,
                audio,
                timeline: timelineRef.current,
                get cursors() { return { damageCursor, vanishCursor, moveCursor, posCursor, castCursor, paramCursor }; },
                tick(ms: number) {
                  const dt = ms / 1000;
                  engine.renderOnce(dt);
                },
              };
            },
          });
        }
      } catch (err) {
        console.error("[ReplayMap] failed to load map", mapName, err);
        if (!disposed) setPhase("error");
      }
    })();

    return () => {
      disposed = true;
      ro.disconnect();
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("mousemove", onPointerMove);
      window.removeEventListener("mouseup", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContextMenu);
      restartRef.current = null;
      tooltip.dispose();
      vitalBars.dispose();
      castBars.dispose();
      castNames.dispose();
      buffBar.dispose();
      effectsLayer?.dispose();
      damageLayer?.dispose();
      entities?.dispose();
      world?.dispose();
      engine.dispose();
      audio.dispose();
      audioRef.current = null;
      canvas.removeEventListener("mouseleave", onPointerLeave);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapName, playerAid]);

  const togglePlay = () => {
    timelineRef.current.togglePlay();
    if (timelineRef.current.isPlaying) audioRef.current?.resume(); // play click is a gesture
    setIsPlaying(timelineRef.current.isPlaying);
  };

  const setSpeedClamped = (s: number) => {
    timelineRef.current.setSpeed(s);
    setSpeed(s);
  };

  const totalMs = replay.sessionInfo.durationMs;
  // Clamp to the real duration so the readout + scrubber sit at 0:10 / 100%
  // during the playback tail (the clock runs past `totalMs` to finish trailing
  // animations, but the UI shouldn't show more than the recording length).
  const nowMs = Math.min(timelineRef.current.time, totalMs);

  return (
    <div className="replay-map-overlay" ref={wrapRef}>
      <canvas className="replay-map-canvas" ref={canvasRef} />
      {phase === "loading" && <div className="replay-map-status">{t.replayMapLoading}</div>}
      {phase === "error" && <div className="replay-map-status">{t.replayMapError}</div>}
      <button type="button" className="replay-map-close" title={t.replayMapClose} onClick={onClose}>
        ×
      </button>
      {/* Left-side display toggles (persisted): level auras + skill/world effects.
          The coloured dot signals on/off for sighted users; aria-pressed carries
          the state to assistive tech. */}
      <div className="replay-map-settings" role="group" aria-label={t.replayMapSettings}>
        <button
          type="button"
          className={`replay-map-toggle${auraEnabled ? " is-on" : ""}`}
          aria-pressed={auraEnabled}
          onClick={() => setAuraEnabled((v) => !v)}
        >
          <span className="replay-map-toggle-dot" aria-hidden="true" />
          {t.replayMapAura}
        </button>
        <button
          type="button"
          className={`replay-map-toggle${effectsEnabled ? " is-on" : ""}`}
          aria-pressed={effectsEnabled}
          onClick={() => setEffectsEnabled((v) => !v)}
        >
          <span className="replay-map-toggle-dot" aria-hidden="true" />
          {t.replayMapEffects}
        </button>
        <button
          type="button"
          className={`replay-map-toggle${sfxEnabled ? " is-on" : ""}`}
          aria-pressed={sfxEnabled}
          onClick={() => setSfxEnabled((v) => !v)}
        >
          <span className="replay-map-toggle-dot" aria-hidden="true" />
          {t.replayMapSfx}
        </button>
        <button
          type="button"
          className={`replay-map-toggle${bgmEnabled ? " is-on" : ""}`}
          aria-pressed={bgmEnabled}
          onClick={() => setBgmEnabled((v) => !v)}
        >
          <span className="replay-map-toggle-dot" aria-hidden="true" />
          {t.replayMapBgm}
        </button>
      </div>
      <div className="replay-map-controls">
        <button
          type="button"
          className="replay-map-btn replay-map-btn--icon"
          aria-label={isPlaying ? t.replayMapPause : t.replayMapPlay}
          title={isPlaying ? t.replayMapPause : t.replayMapPlay}
          onClick={togglePlay}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="16" height="16">
            {isPlaying ? (
              // Two vertical bars — pause.
              <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
            ) : (
              // Right-pointing triangle — play.
              <path d="M7 4v16l14-8z" />
            )}
          </svg>
        </button>
        {/* Restart button — always visible. Rebuilds the entity table + damage-
            text pool from scratch (dead mobs alive again, floats cleared),
            seeks to t=0, and resumes playing. */}
        <button
          type="button"
          className="replay-map-btn replay-map-btn--icon"
          aria-label={t.replayMapRestart}
          title={t.replayMapRestart}
          onClick={() => restartRef.current?.()}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="16" height="16">
            {/* Circular-arrow "restart" glyph: an open ring with an arrowhead at
                the start position, hinting rewind-to-beginning. */}
            <path d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z" />
          </svg>
        </button>
        <span className="replay-map-time">
          {formatMs(nowMs)} / {formatMs(totalMs)}
        </span>
        {/* View-only progress indicator — dragging is disabled while the
            cursors are still forward-only (rewinding events isn't implemented
            yet, so an interactive scrubber would let you seek to a time whose
            state can't actually be reconstructed). Re-enable once seek-back
            rebuilds the entity table + damage pool cleanly. */}
        <input
          type="range"
          className="replay-map-scrub"
          min={0}
          max={totalMs}
          step={100}
          value={nowMs}
          readOnly
          disabled
          aria-label={`${formatMs(nowMs)} / ${formatMs(totalMs)}`}
        />
        <label className="replay-map-speed">
          {t.replayMapSpeedLabel}
          <select value={speed} onChange={(e) => setSpeedClamped(Number(e.target.value))}>
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                ×{s}
              </option>
            ))}
          </select>
        </label>
      </div>
      <a
        className="replay-map-credit"
        href="https://github.com/vthibault/roBrowser"
        target="_blank"
        rel="noreferrer"
      >
        {t.replayMapCredit}
      </a>
      {showIntro && (
        <div className="replay-map-intro" role="dialog" aria-modal="true">
          <div className="replay-map-intro-card">
            <h2>{t.replayMapIntroTitle}</h2>
            <p>{t.replayMapIntroBody}</p>
            <button
              type="button"
              className="replay-map-btn"
              onClick={() => {
                setShowIntro(false);
                timelineRef.current.setPlaying(true);
                audioRef.current?.resume(); // first gesture unlocks Web Audio
                setIsPlaying(true);
              }}
            >
              {t.replayMapIntroDismiss}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
