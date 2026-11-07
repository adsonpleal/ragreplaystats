import { describe, expect, it } from "vitest";
import { fitSpan, MIN_SPAN_MS, panBy, zoomAt, ZOOM_STEP } from "./timelineZoom";

/** A ten-minute recording, which is the shape a long replay has. */
const FULL = { startMs: 0, endMs: 600_000 };

describe("zoomAt", () => {
  it("narrows the window around the anchor, which stays put", () => {
    const view = zoomAt(null, FULL, 0.5, 300_000)!;
    expect(view).toEqual({ startMs: 150_000, endMs: 450_000 });
    // The anchor sat at the middle of the old window and still does.
    expect((300_000 - view.startMs) / (view.endMs - view.startMs)).toBeCloseTo(0.5);
  });

  it("keeps the anchor's relative position off-centre too", () => {
    const view = zoomAt(null, FULL, 0.5, 120_000)!;
    expect((120_000 - view.startMs) / (view.endMs - view.startMs)).toBeCloseTo(0.2);
  });

  it("holds the centre when no anchor is given, which is what the buttons do", () => {
    expect(zoomAt(null, FULL, 0.5)).toEqual({ startMs: 150_000, endMs: 450_000 });
    expect(zoomAt({ startMs: 100_000, endMs: 200_000 }, FULL, 0.5)).toEqual({
      startMs: 125_000,
      endMs: 175_000,
    });
  });

  it("anchors near the start without crossing it", () => {
    expect(zoomAt(null, FULL, 0.5, 10_000)).toEqual({ startMs: 5_000, endMs: 305_000 });
  });

  it("slides a window that would run off the start back inside the session", () => {
    expect(zoomAt({ startMs: 100_000, endMs: 200_000 }, FULL, 4, 150_000)).toEqual({
      startMs: 0,
      endMs: 400_000,
    });
  });

  it("slides a window that would run off the end back inside the session", () => {
    expect(zoomAt({ startMs: 400_000, endMs: 500_000 }, FULL, 4, 450_000)).toEqual({
      startMs: 200_000,
      endMs: 600_000,
    });
  });

  it("collapses to the whole session instead of a window that covers it", () => {
    expect(zoomAt({ startMs: 100_000, endMs: 500_000 }, FULL, 4, 300_000)).toBeNull();
    expect(zoomAt(null, FULL, ZOOM_STEP, 300_000)).toBeNull();
  });

  it("stops narrowing at MIN_SPAN_MS", () => {
    let view = zoomAt(null, FULL, 0.5, 300_000);
    for (let i = 0; i < 40; i++) view = zoomAt(view, FULL, 0.5, 300_000);
    expect(view!.endMs - view!.startMs).toBe(MIN_SPAN_MS);
  });

  it("never zooms a session shorter than the minimum window", () => {
    const tiny = { startMs: 0, endMs: 800 };
    expect(zoomAt(null, tiny, 0.5, 400)).toBeNull();
  });

  it("treats a session with a single event as nothing to zoom", () => {
    expect(zoomAt(null, { startMs: 5_000, endMs: 5_000 }, 0.5, 5_000)).toBeNull();
  });

  it("clamps an anchor outside the window (the cursor can sit in the gutter)", () => {
    const view = { startMs: 200_000, endMs: 300_000 };
    expect(zoomAt(view, FULL, 0.5, 0)).toEqual({ startMs: 200_000, endMs: 250_000 });
    expect(zoomAt(view, FULL, 0.5, 600_000)).toEqual({ startMs: 250_000, endMs: 300_000 });
  });
});

describe("panBy", () => {
  it("shifts the window without resizing it", () => {
    expect(panBy({ startMs: 100_000, endMs: 200_000 }, FULL, 50_000)).toEqual({
      startMs: 150_000,
      endMs: 250_000,
    });
  });

  it("stops at the edges of the session, keeping the width", () => {
    expect(panBy({ startMs: 10_000, endMs: 110_000 }, FULL, -50_000)).toEqual({
      startMs: 0,
      endMs: 100_000,
    });
    expect(panBy({ startMs: 500_000, endMs: 600_000 }, FULL, 50_000)).toEqual({
      startMs: 500_000,
      endMs: 600_000,
    });
  });

  it("does nothing while the whole session is visible", () => {
    expect(panBy(null, FULL, 50_000)).toBeNull();
  });
});

describe("fitSpan", () => {
  it("takes a dragged selection as the window", () => {
    expect(fitSpan({ startMs: 120_000, endMs: 180_000 }, FULL)).toEqual({
      startMs: 120_000,
      endMs: 180_000,
    });
  });

  it("widens a selection narrower than MIN_SPAN_MS around its centre", () => {
    const view = fitSpan({ startMs: 100_000, endMs: 100_400 }, FULL)!;
    expect(view.endMs - view.startMs).toBe(MIN_SPAN_MS);
    expect((view.startMs + view.endMs) / 2).toBe(100_200);
  });

  it("pulls a selection that overhangs the session back inside it", () => {
    expect(fitSpan({ startMs: -5_000, endMs: 95_000 }, FULL)).toEqual({
      startMs: 0,
      endMs: 100_000,
    });
  });

  it("collapses a selection that spans everything to the whole session", () => {
    expect(fitSpan({ startMs: 0, endMs: 600_000 }, FULL)).toBeNull();
  });
});
