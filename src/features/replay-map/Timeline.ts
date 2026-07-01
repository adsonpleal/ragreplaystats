// Playback clock for the replay map viewer. The engine advances real time per
// frame; the timeline maps that into the recording's time axis (ms from session
// start), exposes play/pause/seek/speed, and walks sorted event arrays via a
// cursor so per-frame "events between last and now" is O(1).

export type EventTime = { time: number };

export class EventCursor<T extends EventTime> {
  private i = 0;
  constructor(private readonly events: ReadonlyArray<T>) {}

  /** Advance the cursor to the first event after `tMs`, calling `onEach` for
   *  every event that became newly current (time ≤ tMs and time > the previous
   *  call's threshold). Cheap because events are pre-sorted. */
  advanceTo(tMs: number, onEach: (e: T) => void): void {
    while (this.i < this.events.length && this.events[this.i].time <= tMs) {
      onEach(this.events[this.i]);
      this.i++;
    }
  }

  /** Reset to the first event whose time is ≥ tMs (used on seek/rewind). */
  seek(tMs: number): void {
    // Binary search; arrays here are typically thousands of entries.
    let lo = 0;
    let hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.events[mid].time < tMs) lo = mid + 1;
      else hi = mid;
    }
    this.i = lo;
  }

  /** All events strictly before `tMs` — used after a seek to catch up state
   *  that needs to remain "remembered" (positions, equip changes). */
  takeUpTo(tMs: number): T[] {
    const out: T[] = [];
    while (this.i < this.events.length && this.events[this.i].time < tMs) {
      out.push(this.events[this.i]);
      this.i++;
    }
    return out;
  }
}

export class Timeline {
  private playing = true;
  private speed = 1;
  /** Current time in ms from session start. */
  private tMs = 0;
  /** Playback runs to here (durationMs + tail) so events on the very last frame
   *  can animate out; the scrubber still reports the real recording duration. */
  private readonly playbackEndMs: number;

  constructor(private readonly durationMs: number, tailMs = 0) {
    this.playbackEndMs = durationMs + Math.max(0, tailMs);
  }

  get time(): number {
    return this.tMs;
  }

  /** Real recording duration (for the scrubber / time readout), excluding the
   *  playback tail. */
  get duration(): number {
    return this.durationMs;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get currentSpeed(): number {
    return this.speed;
  }

  setSpeed(s: number): void {
    this.speed = Math.max(0.25, Math.min(8, s));
  }

  togglePlay(): void {
    this.playing = !this.playing;
  }

  setPlaying(p: boolean): void {
    this.playing = p;
  }

  seek(tMs: number): void {
    this.tMs = Math.max(0, Math.min(this.playbackEndMs, tMs));
  }

  /** Advance the clock by `dtSec` real seconds (scaled by playback speed).
   *  Returns true when the playback time actually changed (paused = false).
   *  Runs to `playbackEndMs` (past the recording end) so trailing animations
   *  finish before it auto-pauses. */
  tick(dtSec: number): boolean {
    if (!this.playing) return false;
    const next = Math.min(this.playbackEndMs, this.tMs + dtSec * 1000 * this.speed);
    if (next === this.tMs) {
      // Hit the end — auto-pause so the UI shows the final frame at rest.
      this.playing = false;
      return false;
    }
    this.tMs = next;
    return true;
  }
}
