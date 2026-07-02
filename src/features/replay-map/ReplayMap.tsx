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
import { MAPS_ROOT } from "../../sim/ragassets";
import { findPath } from "../../sim/pathfind";
import { CursorAnimator } from "../../sim/cursor";
import { DamageTextLayer } from "./DamageText";
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

type Phase = "loading" | "ready" | "error";

const SPEEDS = [0.5, 1, 2, 4] as const;

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
  const [displayedTime, setDisplayedTime] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [isPlaying, setIsPlaying] = useState(true);
  // "Highly experimental" intro shown over the viewer on open, dismissed by the
  // user. It's purely informational (the scene keeps loading behind it).
  const [showIntro, setShowIntro] = useState(true);

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
    let cursor: CursorAnimator | null = null;

    let damageCursor: EventCursor<typeof events.damage[number]> | null = null;
    let vanishCursor: EventCursor<typeof events.vanishes[number]> | null = null;
    let optionCursor: EventCursor<typeof events.options[number]> | null = null;
    let moveCursor: EventCursor<typeof events.moves[number]> | null = null;
    let posCursor: EventCursor<typeof events.positions[number]> | null = null;
    let castCursor: EventCursor<typeof events.casts[number]> | null = null;
    let paramCursor: EventCursor<typeof events.params[number]> | null = null;
    let statusCursor: EventCursor<typeof events.status[number]> | null = null;

    // Local player's active buffs: EFST id → expiry time (ms, recording clock;
    // Infinity when the status has no timed duration). Rebuilt on restart. The
    // strip only re-renders when this set changes (`buffsDirty`).
    const activeBuffs = new Map<number, number>();
    let buffsDirty = false;

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
        setIsPlaying(timelineRef.current.isPlaying);
      }
    };
    window.addEventListener("keydown", onKey);

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
    const camUpTmp = new Vector3();
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

      const advanced = timelineRef.current.tick(dt);
      const nowMs = timelineRef.current.time;
      if (advanced) {
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
        });
        damageCursor!.advanceTo(nowMs, (ev) => {
          entities!.applyDamage(nowMs, ev.source, ev.target, ev.skillId);
          const pos = entities!.worldPosOf(ev.target, targetWorldTmp);
          if (pos) {
            damageLayer!.spawn(ev.target, pos, ev.damage, ev.hitType, ev.source === playerAid, nowMs, ev.hits);
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

      entities.update(dt, nowMs, engine.cam.direction, engine.cam.camera);
      damageLayer.update(nowMs, engine.cam.camera);

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
        setDisplayedTime(nowMs);
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
          entities = new EntityTable(engine.scene, world!, replay, playerAid, playerLook, db);
          damageLayer = new DamageTextLayer(engine.scene);
          damageCursor = new EventCursor(events.damage);
          vanishCursor = new EventCursor(events.vanishes);
          optionCursor = new EventCursor(events.options);
          moveCursor = new EventCursor(events.moves);
          posCursor = new EventCursor(events.positions);
          castCursor = new EventCursor(events.casts);
          paramCursor = new EventCursor(events.params);
          statusCursor = new EventCursor(events.status);
          vitals.hp = vitals.maxHp = vitals.sp = vitals.maxSp = vitals.ap = vitals.maxAp = 0;
          activeBuffs.clear();
          buffsDirty = true; // force one reconcile so a rewind clears the strip
        };
        buildRuntime();
        restartRef.current = () => {
          buildRuntime();
          timelineRef.current.seek(0);
          timelineRef.current.setPlaying(true);
          setDisplayedTime(0);
          setIsPlaying(true);
        };
        // Wait for Galmuri11 before unblocking playback — the first damage /
        // cast label / tooltip text draws its Canvas texture once at spawn, so
        // late-arrival of the font would leave those first labels frozen in
        // the fallback font for their entire lifetime.
        await fontReady;
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
                get entities() { return entities; },
                get damageLayer() { return damageLayer; },
                castNames,
                castBars,
                buffBar,
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
      damageLayer?.dispose();
      entities?.dispose();
      world?.dispose();
      engine.dispose();
      canvas.removeEventListener("mouseleave", onPointerLeave);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapName, playerAid]);

  const togglePlay = () => {
    timelineRef.current.togglePlay();
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
  // Silence the unused-var warning for now; kept for future "at end" UI.
  void displayedTime;

  return (
    <div className="replay-map-overlay" ref={wrapRef}>
      <canvas className="replay-map-canvas" ref={canvasRef} />
      {phase === "loading" && <div className="replay-map-status">{t.replayMapLoading}</div>}
      {phase === "error" && <div className="replay-map-status">{t.replayMapError}</div>}
      <button type="button" className="replay-map-close" title={t.replayMapClose} onClick={onClose}>
        ×
      </button>
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
            <button type="button" className="replay-map-btn" onClick={() => setShowIntro(false)}>
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
