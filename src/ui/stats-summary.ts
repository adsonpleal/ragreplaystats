export type SummaryCell = {
  label: string;
  value: string;
  /** Optional small caption under the value. */
  hint?: string;
};

/**
 * Render a stat-grid card. Reuses the same `.summary-grid` CSS that the
 * session card uses, just with more cells.
 */
export function renderSummaryCard(
  host: HTMLElement,
  title: string,
  cells: SummaryCell[],
) {
  host.innerHTML = "";
  const wrap = document.createElement("section");
  wrap.className = "stats-card";
  const h2 = document.createElement("h2");
  h2.textContent = title;
  wrap.appendChild(h2);

  const grid = document.createElement("div");
  grid.className = "summary-grid";
  for (const cell of cells) {
    const div = document.createElement("div");
    const label = document.createElement("span");
    label.textContent = cell.label;
    const value = document.createElement("span");
    value.textContent = cell.value;
    div.appendChild(label);
    div.appendChild(value);
    if (cell.hint) {
      const hint = document.createElement("span");
      hint.className = "stats-cell-hint";
      hint.textContent = cell.hint;
      div.appendChild(hint);
    }
    grid.appendChild(div);
  }
  wrap.appendChild(grid);
  host.appendChild(wrap);
}
