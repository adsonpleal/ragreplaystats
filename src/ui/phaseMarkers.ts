import type uPlot from "uplot";
import { t } from "../i18n";

/**
 * Draws a dashed vertical line, labelled "Fase N", at each time a grouped
 * monster's next phase appeared (see src/aggregate/bossPhases.ts). The first
 * phase has no line: the chart starts with it. Meant for a uPlot `draw` hook;
 * times are ms, on an x scale in seconds.
 */
export function drawPhaseMarkers(u: uPlot, phaseStartsMs: readonly number[], dark: boolean) {
  if (!phaseStartsMs.length) return;
  const ctx = u.ctx;
  const { left, top, width, height } = u.bbox;
  const color = dark ? "#e0e0e0" : "#333";
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = devicePixelRatio;
  ctx.setLineDash([6 * devicePixelRatio, 4 * devicePixelRatio]);
  ctx.font = `${11 * devicePixelRatio}px system-ui, sans-serif`;
  // uPlot leaves the axes' alignment on the context.
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  phaseStartsMs.forEach((ms, i) => {
    const x = Math.round(u.valToPos(ms / 1000, "x", true));
    if (x < left || x > left + width) return;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, top + height);
    ctx.stroke();
    ctx.fillText(t.phaseMarker(i + 2), x + 4 * devicePixelRatio, top + 2 * devicePixelRatio);
  });
  ctx.restore();
}
