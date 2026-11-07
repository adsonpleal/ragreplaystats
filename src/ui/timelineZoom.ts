/**
 * Zoom math for the damage timeline — kept apart from the uPlot wiring so the
 * clamping rules can be tested without a canvas.
 *
 * A view of `null` means "the whole session", which is also uPlot's own default
 * for a numeric x scale (`[dataMin, dataMax]`, no padding). Every function here
 * collapses back to `null` once the window it would return covers the full span,
 * so zooming all the way out lands on exactly the unzoomed chart instead of on a
 * window that merely looks like it.
 */

export type TimelineSpan = { startMs: number; endMs: number };

/**
 * Shortest window the timeline zooms to. A second already spreads hits 100 ms
 * apart across a tenth of the chart each, so nothing is hidden by stopping
 * here — and the window label reads in whole seconds, which a shorter floor
 * would print as the same second twice.
 */
export const MIN_SPAN_MS = 1000;

/** One wheel notch. Chosen so ~6 notches cross a minute-long recording. */
export const ZOOM_STEP = 1.35;

/** One click of the zoom buttons — coarser than a notch, since clicking is slower. */
export const ZOOM_STEP_BUTTON = 2;

const width = (span: TimelineSpan) => span.endMs - span.startMs;

/** Slide `span` so it sits inside `full`, keeping its width. */
function slideInto(span: TimelineSpan, full: TimelineSpan): TimelineSpan {
  const w = width(span);
  let startMs = span.startMs;
  if (startMs < full.startMs) startMs = full.startMs;
  if (startMs + w > full.endMs) startMs = full.endMs - w;
  return { startMs: Math.round(startMs), endMs: Math.round(startMs + w) };
}

/** `null` whenever the window is the whole session, so callers never special-case it. */
function orFull(span: TimelineSpan, full: TimelineSpan): TimelineSpan | null {
  return span.startMs <= full.startMs && span.endMs >= full.endMs ? null : span;
}

/** How narrow this session can get: a recording shorter than `MIN_SPAN_MS` never zooms. */
function minWidth(full: TimelineSpan): number {
  return Math.min(MIN_SPAN_MS, width(full));
}

/**
 * Scale the window by `factor` (< 1 zooms in) while keeping `anchorMs` under the
 * same pixel, which is what makes wheel-zoom feel like it follows the cursor.
 * Without an anchor it holds the centre, which is what the buttons want.
 */
export function zoomAt(
  view: TimelineSpan | null,
  full: TimelineSpan,
  factor: number,
  anchorMs?: number,
): TimelineSpan | null {
  const cur = view ?? full;
  const curW = width(cur);
  if (curW <= 0) return null;
  anchorMs ??= (cur.startMs + cur.endMs) / 2;
  const nextW = Math.min(width(full), Math.max(minWidth(full), curW * factor));
  // Clamped before it becomes a ratio: an anchor off the edge of the current
  // window (the cursor can sit in the axis gutter) would otherwise push the
  // window past the data.
  const anchor = Math.min(Math.max(anchorMs, cur.startMs), cur.endMs);
  const ratio = (anchor - cur.startMs) / curW;
  const startMs = anchor - ratio * nextW;
  return orFull(slideInto({ startMs, endMs: startMs + nextW }, full), full);
}

/** Shift the window by `deltaMs` without resizing it. The whole session cannot pan. */
export function panBy(
  view: TimelineSpan | null,
  full: TimelineSpan,
  deltaMs: number,
): TimelineSpan | null {
  if (!view) return null;
  return orFull(
    slideInto({ startMs: view.startMs + deltaMs, endMs: view.endMs + deltaMs }, full),
    full,
  );
}

/**
 * Fit `span` (a dragged selection, usually) into a view: at least `MIN_SPAN_MS`
 * wide — grown around its centre — and inside the session.
 */
export function fitSpan(span: TimelineSpan, full: TimelineSpan): TimelineSpan | null {
  const w = Math.max(minWidth(full), width(span));
  const centre = (span.startMs + span.endMs) / 2;
  return orFull(slideInto({ startMs: centre - w / 2, endMs: centre + w / 2 }, full), full);
}
