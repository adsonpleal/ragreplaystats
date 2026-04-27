export type Column<T> = {
  key: string;
  label: string;
  numeric?: boolean;
  format?: (row: T) => string;
  sortValue?: (row: T) => number | string;
  /** If provided, renders the cell as `<a href=...>` opening in a new tab. */
  href?: (row: T) => string | null | undefined;
};

export type TableOptions<T> = {
  initialSort?: { key: string; asc: boolean };
  onRowClick?: (row: T) => void;
  isSelected?: (row: T) => boolean;
};

export function renderTable<T>(
  host: HTMLElement,
  cols: Column<T>[],
  rows: T[],
  options: TableOptions<T> = {},
) {
  const initialSort = options.initialSort;
  let sortKey = initialSort?.key ?? cols[0].key;
  let asc = initialSort?.asc ?? false;

  function sortRows(): T[] {
    const col = cols.find((c) => c.key === sortKey);
    if (!col) return rows;
    const getter =
      col.sortValue ??
      ((row: T) => (row as unknown as Record<string, unknown>)[col.key] as number | string);
    const dir = asc ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = getter(a);
      const vb = getter(b);
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }

  function paint() {
    const sorted = sortRows();
    host.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const trh = document.createElement("tr");
    for (const c of cols) {
      const th = document.createElement("th");
      th.textContent = c.label;
      if (c.numeric) th.classList.add("num");
      if (c.key === sortKey) {
        th.classList.add("sorted");
        if (asc) th.classList.add("asc");
      }
      th.addEventListener("click", () => {
        if (sortKey === c.key) {
          asc = !asc;
        } else {
          sortKey = c.key;
          asc = false;
        }
        paint();
      });
      trh.appendChild(th);
    }
    thead.appendChild(trh);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    for (const row of sorted) {
      const tr = document.createElement("tr");
      if (options.onRowClick) {
        tr.classList.add("clickable");
        tr.addEventListener("click", () => options.onRowClick!(row));
      }
      if (options.isSelected?.(row)) tr.classList.add("selected");
      for (const c of cols) {
        const td = document.createElement("td");
        if (c.numeric) td.classList.add("num");
        const text = c.format
          ? c.format(row)
          : String((row as unknown as Record<string, unknown>)[c.key] ?? "");
        const href = c.href?.(row);
        if (href) {
          const a = document.createElement("a");
          a.className = "cell-link";
          a.href = href;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = text;
          // Don't trigger the row's drill-down when the link is clicked.
          a.addEventListener("click", (e) => e.stopPropagation());
          td.appendChild(a);
        } else {
          td.textContent = text;
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    if (!rows.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = cols.length;
      td.style.textAlign = "center";
      td.style.color = "var(--muted)";
      td.textContent = "Sem dados.";
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    host.appendChild(wrap);
  }

  paint();
}
