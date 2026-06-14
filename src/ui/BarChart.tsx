import { Fragment, useState } from "react";
import { PALETTE_DARK, PALETTE_LIGHT, useDarkMode } from "./palette";

export type BarLabelSegment = {
  text: string;
  /** When set, this segment renders as an external link. */
  href?: string;
};

export type BarRow = {
  /** Stable key — also used to pick a palette colour. */
  key: number | string;
  label: string;
  /**
   * If set, replaces `label` with multiple segments — useful when only part of
   * the label should be linkable (e.g. "Player · Monster" where only the
   * monster goes to its DP page).
   */
  labelSegments?: BarLabelSegment[];
  /** Optional icon shown before the label (e.g. a skill sprite). */
  iconSrc?: string;
  /** Bar value (used for fill width). */
  value: number;
  /** Optional pre-formatted right-hand label (e.g. "1.2M / 23.4k DPS"). */
  display?: string;
  /** If set, the entire label becomes an external link (opens in a new tab). */
  href?: string;
};

/** Sprite icon that quietly removes itself if the image fails to load. */
function BarLabelIcon({ src }: { src: string }) {
  const [ok, setOk] = useState(true);
  if (!ok) return null;
  return (
    <img
      className="bar-label-icon"
      src={src}
      alt=""
      loading="lazy"
      onError={() => setOk(false)}
    />
  );
}

function BarLabel({ row }: { row: BarRow }) {
  const icon = row.iconSrc ? <BarLabelIcon src={row.iconSrc} /> : null;

  if (row.labelSegments?.length) {
    return (
      <span className="bar-label" title={row.label}>
        {icon}
        {row.labelSegments.map((s, i) =>
          s.href ? (
            <a
              key={i}
              className="bar-label-link"
              href={s.href}
              target="_blank"
              rel="noopener noreferrer"
            >
              {s.text}
            </a>
          ) : (
            <Fragment key={i}>{s.text}</Fragment>
          ),
        )}
      </span>
    );
  }

  if (row.href) {
    return (
      <a
        className="bar-label"
        href={row.href}
        target="_blank"
        rel="noopener noreferrer"
        title={row.label}
      >
        {icon}
        {row.label}
      </a>
    );
  }

  return (
    <span className="bar-label" title={row.label}>
      {icon}
      {row.label}
    </span>
  );
}

export function BarChart({ rows }: { rows: BarRow[] }) {
  const dark = useDarkMode();
  if (!rows.length) return <>Sem dados.</>;

  const pal = dark ? PALETTE_DARK : PALETTE_LIGHT;
  const max = Math.max(...rows.map((r) => r.value), 1);

  return (
    <div className="bar-chart">
      {rows.map((r, i) => {
        const pct = Math.max(2, (r.value / max) * 100);
        const color = pal[i % pal.length];
        return (
          <div className="bar-row" key={r.key}>
            <BarLabel row={r} />
            <span className="bar-track">
              <span
                className="bar-fill"
                style={{ width: `${pct.toFixed(2)}%`, background: color }}
              />
            </span>
            <span className="bar-value">{r.display ?? String(r.value)}</span>
          </div>
        );
      })}
    </div>
  );
}
