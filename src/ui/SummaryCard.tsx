import type { ReactNode } from "react";

export type SummaryCell = {
  label: string;
  value: string;
  /** Optional small caption under the value. */
  hint?: string;
  /**
   * Render arbitrary content for the value instead of plain text (e.g. an
   * external link). Replaces the old `valueIsHtml` escape hatch — React
   * escapes text automatically.
   */
  valueNode?: ReactNode;
};

/**
 * Stat-grid card. Reuses the same `.summary-grid` CSS the session card uses,
 * just with more cells.
 */
export function SummaryCard({
  title,
  cells,
}: {
  title: string;
  cells: SummaryCell[];
}) {
  return (
    <section className="stats-card">
      <h2>{title}</h2>
      <div className="summary-grid">
        {cells.map((cell, i) => (
          <div key={i}>
            <span>{cell.label}</span>
            <span>{cell.valueNode ?? cell.value}</span>
            {cell.hint && <span className="stats-cell-hint">{cell.hint}</span>}
          </div>
        ))}
      </div>
    </section>
  );
}
