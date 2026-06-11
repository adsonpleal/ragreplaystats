// Small shared form controls.

// Inline SVG chevrons rather than text glyphs (‹ ›): the glyph ink sits high
// within its line box on most fonts, so it never visually centers.
export const CHEVRON_LEFT = "M15 5l-7 7 7 7";
export const CHEVRON_RIGHT = "M9 5l7 7-7 7";

/** `.equip-arrow`-styled icon button with an SVG chevron (see CHEVRON_*). */
export function chevronButton(path: string, label: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "equip-arrow";
  btn.setAttribute("aria-label", label);
  btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${path}"/></svg>`;
  return btn;
}
