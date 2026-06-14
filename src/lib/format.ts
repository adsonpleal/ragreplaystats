import { locale, t } from "../i18n";

/** Locale-aware thousands formatting (the old `fmt` helper). */
export function fmt(n: number): string {
  return n.toLocaleString(locale);
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
