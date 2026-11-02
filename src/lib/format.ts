import { locale, t } from "../i18n";

/** Locale-aware thousands formatting (the old `fmt` helper). */
export function fmt(n: number): string {
  return n.toLocaleString(locale);
}

/** Locale-aware fractional formatting — one definition of the decimal mark. */
export function fmtDecimal(n: number, digits = 2): string {
  return n.toLocaleString(locale, { maximumFractionDigits: digits });
}

/**
 * A moment inside the recording as a clock reading — "6:34", or "6:34,664" with
 * `withMillis`. `formatDuration`'s "6m 34s" reads as a length, which is wrong
 * for a table column or a CSV row naming *when* something happened.
 */
export function formatClock(ms: number, withMillis = false): string {
  const total = Math.floor(ms / 1000);
  const base = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  return withMillis ? `${base},${String(ms % 1000).padStart(3, "0")}` : base;
}

/** "1h 2m 3s" / "2m 3s" / "3s", or the em-dash placeholder for 0. */
export function formatDuration(ms: number): string {
  if (!ms) return t.none;
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}
