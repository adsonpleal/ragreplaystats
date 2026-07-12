// Web Audio SFX/BGM manager for the replay map viewer. HTMLAudioElement pools
// can't give us low-latency concurrent SFX, per-voice gain, or a shared bus, so
// this drives one AudioContext directly.
//
// Bus shape:  source → gain(+panner) → sfxBus ─┐
//                                    bgmBus ─┴→ master → destination
// `master.gain` is the volume; each bus mutes independently (0 gain) so the
// left-side SFX/BGM toggles are honoured without touching the master. BGM has no
// source in this repo yet — the bus is shaped so a future BGM player slots under
// the same master/mute.
//
// Buffer cache: name → Promise<AudioBuffer|null>. A 404 (or any decode failure)
// caches to null — no sound for this effect, silently, never a stand-in — the
// same miss contract the texture/sprite-bundle loaders use for visuals.
//
// Browsers block audio until a user gesture; call resume() on the first play
// gesture (the intro-dismiss / Play button). The context is created lazily there,
// and any names queued via preload() before the gesture are warmed on unlock.

import { effectSoundUrl } from "../ragassets";

// A sound whose fetch/decode lands more than this after its cue is dropped — a
// stale SFX (fired for a moment already gone) is worse than a missing one.
const LATE_PLAY_WINDOW_MS = 150;
// Concurrent SFX voice cap; the oldest is stopped when a new voice exceeds it, so
// fast playback (4×/8×) stays intelligible instead of turning into a wall of noise.
const MAX_VOICES = 8;
// Don't replay the same sound name within this window — collapses the burst of a
// multi-hit / many-actors-share-a-hit-spark at speed into a single audible hit.
const SAME_NAME_THROTTLE_MS = 60;
// Background level for the BGM bus (under the master). RO BGMs are mastered loud;
// this keeps the music behind the skill/hit SFX. Matches the sim's 0.35.
const BGM_VOLUME = 0.35;

interface PlayOpts {
  /** Per-voice gain (0..1+); distance attenuation lives here in a future v2. */
  gain?: number;
  /** Stereo pan (-1..1); 0 = centred (no panner node created). */
  pan?: number;
}

export class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private bgmBus: GainNode | null = null;

  private readonly buffers = new Map<string, Promise<AudioBuffer | null>>();
  private readonly voices: AudioBufferSourceNode[] = [];
  private readonly lastPlayedAt = new Map<string, number>();
  /** Names requested via preload() before the context existed; warmed on unlock. */
  private pendingPreload: string[] = [];

  private volume = 1;
  private sfxMuted = false;
  private bgmMuted = false;
  private disposed = false;

  // --- BGM (looping map music) --------------------------------------------
  // Streamed via an HTMLAudioElement (not a decoded AudioBuffer — a multi-minute
  // track would balloon memory) routed through the shared graph on the bgmBus, so
  // the master volume + BGM mute govern it like every other voice.
  private bgmUrl: string | null = null;
  private bgmEl: HTMLAudioElement | null = null;
  private bgmSource: MediaElementAudioSourceNode | null = null;

  // --- unlock / lifecycle -------------------------------------------------

  /** Create the context (first call) and resume it. MUST be called from a user
   *  gesture — browsers keep a context suspended until then. Idempotent. */
  resume(): void {
    if (this.disposed) return;
    if (!this.ctx) {
      try {
        const Ctx =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) return;
        const ctx = new Ctx();
        const master = ctx.createGain();
        const sfxBus = ctx.createGain();
        const bgmBus = ctx.createGain();
        sfxBus.connect(master);
        bgmBus.connect(master);
        master.connect(ctx.destination);
        this.ctx = ctx;
        this.master = master;
        this.sfxBus = sfxBus;
        this.bgmBus = bgmBus;
        this.applyGains();
        // Warm anything queued before the gesture unlocked the context.
        if (this.pendingPreload.length) {
          for (const n of this.pendingPreload) this.load(n);
          this.pendingPreload = [];
        }
      } catch (err) {
        console.warn("[audio] context init failed", err);
        return;
      }
    }
    if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
    // Start the map BGM if one was requested before the gesture unlocked audio.
    this.startBgm();
  }

  /** Suspend output (tab hidden). Cheap; resume() brings it back. */
  suspend(): void {
    if (this.ctx && this.ctx.state === "running") this.ctx.suspend().catch(() => {});
  }

  // --- volume / mute ------------------------------------------------------

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    this.applyGains();
  }

  setSfxMuted(muted: boolean): void {
    this.sfxMuted = muted;
    this.applyGains();
  }

  setBgmMuted(muted: boolean): void {
    this.bgmMuted = muted;
    this.applyGains();
    // Tear down / (re)start the streamed element so a muted BGM isn't downloaded
    // (a multi-MB track), and toggling back on resumes it.
    if (muted) this.stopBgmEl();
    else this.startBgm();
  }

  /** Set the map's looping BGM track (null stops it). Starts once the context is
   *  unlocked (resume() retries) and BGM isn't muted; swapping the url changes
   *  tracks. Governed by the master volume + BGM mute like every other voice. */
  setBgm(url: string | null): void {
    if (url === this.bgmUrl) return;
    this.bgmUrl = url;
    this.startBgm();
  }

  private startBgm(): void {
    if (this.disposed || !this.ctx || !this.bgmBus) return; // wait for unlock
    this.stopBgmEl();
    // Don't fetch a multi-MB track while BGM is off; setBgmMuted(false) restarts it.
    if (!this.bgmUrl || this.bgmMuted) return;
    try {
      const el = new Audio();
      el.crossOrigin = "anonymous"; // needed to route a cross-origin stream through Web Audio
      el.loop = true;
      el.preload = "auto";
      el.src = this.bgmUrl;
      const src = this.ctx.createMediaElementSource(el);
      src.connect(this.bgmBus);
      this.bgmEl = el;
      this.bgmSource = src;
      el.play().catch(() => {}); // 404 / not-yet-served / autoplay-blocked → silent
    } catch (err) {
      console.debug("[audio] bgm start failed", err);
    }
  }

  private stopBgmEl(): void {
    if (this.bgmEl) {
      try {
        this.bgmEl.pause();
        this.bgmEl.src = "";
      } catch {
        /* ignore */
      }
      this.bgmEl = null;
    }
    if (this.bgmSource) {
      try {
        this.bgmSource.disconnect();
      } catch {
        /* ignore */
      }
      this.bgmSource = null;
    }
  }

  private applyGains(): void {
    if (this.master) this.master.gain.value = this.volume;
    if (this.sfxBus) this.sfxBus.gain.value = this.sfxMuted ? 0 : 1;
    // RO BGMs are mastered loud — keep the music well under the SFX so it sits
    // in the background rather than drowning the skill/hit sounds.
    if (this.bgmBus) this.bgmBus.gain.value = this.bgmMuted ? 0 : BGM_VOLUME;
  }

  // --- playback -----------------------------------------------------------

  /** Play one SFX by wav name. No-op before resume() (no context yet), while the
   *  same name is throttled, or if the buffer 404'd. If the buffer isn't decoded
   *  yet, the fetch is kicked and it plays on resolve only if still within
   *  LATE_PLAY_WINDOW_MS of this cue. */
  play(name: string, opts: PlayOpts = {}): void {
    if (this.disposed || !this.ctx || !this.sfxBus) return;
    // Muted: skip the fetch/decode entirely (playing at gain 0 would only waste
    // bandwidth). Unmuting takes effect on the next sound — SFX are momentary.
    if (this.sfxMuted) return;
    const cue = performance.now();
    const last = this.lastPlayedAt.get(name);
    if (last != null && cue - last < SAME_NAME_THROTTLE_MS) return;
    this.lastPlayedAt.set(name, cue);
    this.load(name)
      .then((buffer) => {
        // Decoded null = 404/undecodable → silence. Drop a late arrival so a
        // stale sound doesn't fire after its moment has passed.
        if (!buffer || this.disposed || !this.ctx) return;
        if (performance.now() - cue > LATE_PLAY_WINDOW_MS) return;
        this.start(buffer, opts);
      })
      .catch(() => {});
  }

  private start(buffer: AudioBuffer, opts: PlayOpts): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = opts.gain ?? 1;
    src.connect(g);
    let tail: AudioNode = g;
    if (opts.pan && ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, opts.pan));
      g.connect(panner);
      tail = panner;
    }
    tail.connect(this.sfxBus!);
    // Voice cap: stop the oldest live voice so concurrency stays bounded at speed.
    this.voices.push(src);
    if (this.voices.length > MAX_VOICES) {
      const oldest = this.voices.shift();
      try {
        oldest?.stop();
      } catch {
        /* already ended */
      }
    }
    src.onended = () => {
      const i = this.voices.indexOf(src);
      if (i >= 0) this.voices.splice(i, 1);
    };
    src.start();
  }

  /** Cut every live voice — used on rebuild/seek so nothing bleeds across a reset. */
  stopAll(): void {
    for (const v of this.voices) {
      try {
        v.stop();
      } catch {
        /* already ended */
      }
    }
    this.voices.length = 0;
  }

  /** Warm a set of sound buffers (session's frequent skills). Before the context
   *  exists (pre-gesture) the names are queued and fetched on resume(). */
  preload(names: string[]): void {
    // A warmup optimization only — skip entirely when SFX is off (nothing will
    // play). If unmuted later, sounds warm on first use (its first play may be
    // dropped by the late-play window, then it's cached).
    if (this.disposed || this.sfxMuted) return;
    if (this.ctx) {
      for (const n of names) this.load(n);
    } else {
      this.pendingPreload.push(...names);
    }
  }

  /** fetch → arrayBuffer → decode, cached per name. 404/failure caches null
   *  (silent, never retried, no console spam). Requires a live context. */
  private load(name: string): Promise<AudioBuffer | null> {
    let p = this.buffers.get(name);
    if (!p) {
      p = fetch(effectSoundUrl(name))
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .then((ab) => (ab && this.ctx ? this.ctx.decodeAudioData(ab) : null))
        .catch(() => null);
      this.buffers.set(name, p);
    }
    return p;
  }

  dispose(): void {
    this.disposed = true;
    this.stopAll();
    this.stopBgmEl();
    if (this.ctx) this.ctx.close().catch(() => {});
    this.ctx = this.master = this.sfxBus = this.bgmBus = null;
  }
}
