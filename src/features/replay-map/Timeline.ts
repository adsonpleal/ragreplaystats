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

  /** Rewind to before the first event. Cheaper than re-allocating the cursor,
   *  and the basis of a backward seek (replay from 0 to the new time). */
  reset(): void {
    this.i = 0;
  }

  /** Jump the index to the first event after `tMs` WITHOUT calling back for the
   *  ones skipped. Only valid for streams where the skipped events don't matter
   *  (pure last-write-wins folds) — anything that mutates entity state must be
   *  drained through advanceTo instead. */
  seekTo(tMs: number): void {
    let lo = 0;
    let hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.events[mid].time <= tMs) lo = mid + 1;
      else hi = mid;
    }
    this.i = lo;
  }

  /** Time of the next un-drained event, or Infinity when the stream is spent.
   *  Lets a slicing drain skip dead air instead of stepping through it. */
  get nextTime(): number {
    return this.i < this.events.length ? this.events[this.i].time : Infinity;
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

  constructor(durationMs: number, tailMs = 0) {
    this.playbackEndMs = durationMs + Math.max(0, tailMs);
  }

  get time(): number {
    return this.tMs;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** Upper bound for seeking — the recording plus the animation tail. Exposed so
   *  callers clamp against the same bound `seek` does. */
  get endMs(): number {
    return this.playbackEndMs;
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
