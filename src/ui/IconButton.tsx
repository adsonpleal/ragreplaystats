// Inline SVG rather than text glyphs (‹ › + −): the glyph ink sits high within
// its line box on most fonts, so it never visually centers.
//
// Every path is drawn in a 24×24 box, stroked (never filled), and sized by the
// button's font-size — see `.icon-btn svg`.

export const CHEVRON_LEFT = "M15 5l-7 7 7 7";
export const CHEVRON_RIGHT = "M9 5l7 7-7 7";

/** Plus / minus, for zooming a chart in and out. */
export const ZOOM_IN = "M12 5v14M5 12h14";
export const ZOOM_OUT = "M5 12h14";

/** Four corners pushed outwards: fit the selected window to the whole frame. */
export const ZOOM_SELECTION = "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5";

/**
 * Widen the view to both ends of the recording. Drawn as a bare double arrow:
 * the version with end bars read as a letter H at 16px, and adding arrowheads
 * between the bars closed the gaps up into a blob.
 */
export const ZOOM_FULL = "M3 12h18M8 7l-5 5 5 5M16 7l5 5-5 5";

/**
 * Icon-only button. `label` is both the accessible name and, when `tip` is set,
 * a tooltip that fades in after a hover delay — the button carries no text, so
 * without one of the two nothing says what it does.
 */
export function IconButton({
  path,
  label,
  tip,
  onClick,
  disabled,
}: {
  path: string;
  label: string;
  tip?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label={label}
      // The tooltip is CSS (`.icon-btn[data-tip]::after`) rather than `title`:
      // it follows the app's theme and its delay is ours to set, and it also
      // appears on keyboard focus, which a native tooltip never does.
      data-tip={tip ? label : undefined}
      onClick={onClick}
      disabled={disabled}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d={path} />
      </svg>
    </button>
  );
}
