const PALETTE_LIGHT = [
  "#c5462a", "#1f77b4", "#2ca02c", "#9467bd", "#ff7f0e",
  "#17becf", "#d62728", "#8c564b", "#e377c2", "#7f7f7f",
  "#bcbd22", "#5b8c5a",
];
const PALETTE_DARK = [
  "#ff7a55", "#62a4d9", "#52d36b", "#bf99ee", "#ffae42",
  "#56dde9", "#ff5b5d", "#c89388", "#f7a3da", "#a6a6a6",
  "#e3e266", "#7fc185",
];

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
  /** Bar value (used for fill width). */
  value: number;
  /** Optional pre-formatted right-hand label (e.g. "1.2M / 23.4k DPS"). */
  display?: string;
  /** If set, the entire label becomes an external link (opens in a new tab). */
  href?: string;
};

export function renderBarChart(host: HTMLElement, rows: BarRow[]) {
  host.innerHTML = "";
  if (!rows.length) {
    host.textContent = "Sem dados.";
    return;
  }

  const palette = isDark() ? PALETTE_DARK : PALETTE_LIGHT;
  const max = Math.max(...rows.map((r) => r.value), 1);

  const wrap = document.createElement("div");
  wrap.className = "bar-chart";

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const pct = Math.max(2, (r.value / max) * 100);
    const color = palette[i % palette.length];

    const row = document.createElement("div");
    row.className = "bar-row";
    const labelHtml = renderLabelHtml(r);
    row.innerHTML = `
      ${labelHtml}
      <span class="bar-track">
        <span class="bar-fill" style="width:${pct.toFixed(2)}%; background:${color};"></span>
      </span>
      <span class="bar-value">${escape(r.display ?? String(r.value))}</span>
    `;
    wrap.appendChild(row);
  }
  host.appendChild(wrap);
}

function renderLabelHtml(r: BarRow): string {
  if (r.labelSegments?.length) {
    const inner = r.labelSegments
      .map((s) =>
        s.href
          ? `<a class="bar-label-link" href="${escape(s.href)}" target="_blank" rel="noopener noreferrer">${escape(s.text)}</a>`
          : escape(s.text),
      )
      .join("");
    return `<span class="bar-label" title="${escape(r.label)}">${inner}</span>`;
  }
  if (r.href) {
    return `<a class="bar-label" href="${escape(r.href)}" target="_blank" rel="noopener noreferrer" title="${escape(r.label)}">${escape(r.label)}</a>`;
  }
  return `<span class="bar-label" title="${escape(r.label)}">${escape(r.label)}</span>`;
}

function isDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]!);
}
