import { type MouseEvent as ReactMouseEvent, type ReactNode, useMemo, useState } from "react";

export type Column<T> = {
  key: string;
  label: string;
  numeric?: boolean;
  format?: (row: T) => string;
  sortValue?: (row: T) => number | string;
  /** If provided, renders the cell as an external link. */
  href?: (row: T) => string | null | undefined;
  /**
   * Escape hatch: render arbitrary cell content (e.g. a class icon + linked
   * name). When set, the `format` / `href` fallbacks are ignored. Replaces the
   * old DOM-mutating `render(row, td)` signature.
   */
  render?: (row: T) => ReactNode;
};

export type TableOptions<T> = {
  initialSort?: { key: string; asc: boolean };
  onRowClick?: (row: T, event: ReactMouseEvent) => void;
  isSelected?: (row: T) => boolean;
};

export function DataTable<T>({
  cols,
  rows,
  options = {},
}: {
  cols: Column<T>[];
  rows: T[];
  options?: TableOptions<T>;
}) {
  const [sortKey, setSortKey] = useState(options.initialSort?.key ?? cols[0].key);
  const [asc, setAsc] = useState(options.initialSort?.asc ?? false);

  const sorted = useMemo(() => {
    const col = cols.find((c) => c.key === sortKey);
    if (!col) return rows;
    const getter =
      col.sortValue ??
      ((row: T) => (row as Record<string, unknown>)[col.key] as number | string);
    const dir = asc ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = getter(a);
      const vb = getter(b);
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }, [cols, rows, sortKey, asc]);

  function onHeaderClick(key: string) {
    if (sortKey === key) {
      setAsc((a) => !a);
    } else {
      setSortKey(key);
      setAsc(false);
    }
  }

  function cellContent(c: Column<T>, row: T): ReactNode {
    if (c.render) return c.render(row);
    const text = c.format
      ? c.format(row)
      : String((row as Record<string, unknown>)[c.key] ?? "");
    const href = c.href?.(row);
    if (href) {
      return (
        <a
          className="cell-link"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          // Don't trigger the row's drill-down when the link is clicked.
          onClick={(e) => e.stopPropagation()}
        >
          {text}
        </a>
      );
    }
    return text;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {cols.map((c) => {
              const classes = [
                c.numeric ? "num" : "",
                c.key === sortKey ? "sorted" : "",
                c.key === sortKey && asc ? "asc" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <th
                  key={c.key}
                  className={classes || undefined}
                  onClick={() => onHeaderClick(c.key)}
                >
                  {c.label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, ri) => (
            <tr
              key={ri}
              className={[
                options.onRowClick ? "clickable" : "",
                options.isSelected?.(row) ? "selected" : "",
              ]
                .filter(Boolean)
                .join(" ") || undefined}
              onClick={options.onRowClick ? (e) => options.onRowClick!(row, e) : undefined}
            >
              {cols.map((c) => (
                <td key={c.key} className={c.numeric ? "num" : undefined}>
                  {cellContent(c, row)}
                </td>
              ))}
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td
                colSpan={cols.length}
                style={{ textAlign: "center", color: "var(--muted)" }}
              >
                Sem dados.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
