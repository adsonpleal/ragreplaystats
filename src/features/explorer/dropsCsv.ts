// CSV for the Drops tab. The project had no CSV export before this, so the
// flavour is picked for the audience rather than inherited:
//
//  - `;` as the separator, because pt-BR Windows sets the list separator to `;`
//    and Excel splits on that one. A comma-separated file opens as a single
//    column there, which is the whole reason people ask for CSV instead of the
//    XLSX this app already writes.
//  - A UTF-8 BOM, because Excel reads a BOM-less file as the ANSI code page and
//    turns "Poção Vermelha" into "PoÃ§Ã£o".
//  - CRLF, which Excel and every other spreadsheet accept.
//  - Decimal comma on itens/hora, to match the locale the separator assumes.

import { t } from "../../i18n";
import type { DropItemRow, GroundDrop } from "../../aggregate/drops";

const SEP = ";";
const EOL = "\r\n";
const BOM = "﻿";

function cell(value: string | number): string {
  const text = typeof value === "number" ? String(value) : value;
  if (!/[;"\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

/** Fixed-point with a decimal comma — `1234.5` → `"1234,50"`. */
function decimal(value: number): string {
  return value.toFixed(2).replace(".", ",");
}

/** `123456` → `"2:03,456"`, so a row can be found again on the timeline. */
function timestamp(ms: number): string {
  const total = Math.floor(ms / 1000);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm}:${String(ss).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}

function toCsv(header: string[], rows: (string | number)[][]): string {
  const lines = [header.map(cell).join(SEP)];
  for (const row of rows) lines.push(row.map(cell).join(SEP));
  return BOM + lines.join(EOL) + EOL;
}

export function csvBlob(text: string): Blob {
  return new Blob([text], { type: "text/csv;charset=utf-8" });
}

/** One row per drop event — the raw log, for pivoting in a spreadsheet. */
export function dropEventsCsv(
  drops: readonly GroundDrop[],
  resolveItem: (id: number) => string,
): string {
  return toCsv(
    [
      t.dropsColTime,
      t.colId,
      t.dropsColItem,
      t.dropsColAmount,
      t.dropsColCell,
      t.dropsColCollected,
      t.dropsColRemovedAt,
    ],
    drops.map((d) => [
      timestamp(d.time),
      d.itemId,
      resolveItem(d.itemId),
      d.amount,
      `${d.x},${d.y}`,
      d.collected ? t.dropsYes : t.dropsNo,
      d.removedAt == null ? "" : timestamp(d.removedAt),
    ]),
  );
}

/** One row per item — the same numbers the table shows, items/hora included. */
export function dropItemsCsv(rows: readonly DropItemRow[]): string {
  return toCsv(
    [
      t.colId,
      t.dropsColItem,
      t.dropsColDrops,
      t.dropsColQuantity,
      t.dropsColCollectedQty,
      t.dropsColPerHour,
      t.dropsColFirst,
      t.dropsColLast,
    ],
    rows.map((r) => [
      r.itemId,
      r.name,
      r.drops,
      r.quantity,
      r.collected,
      decimal(r.perHour),
      timestamp(r.firstMs),
      timestamp(r.lastMs),
    ]),
  );
}
