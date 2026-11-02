// The Drops tab's two CSVs: the raw event log, and the per-item table. The
// separator, the BOM and the quoting live in features/export/csv.ts.

import { t } from "../../i18n";
import { fmtDecimal, formatClock } from "../../lib/format";
import { toCsv } from "../export/csv";
import type { DropItemRow } from "../../aggregate/drops";
import type { GroundDrop } from "../../aggregate/groundDrops";

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
      // Two columns rather than the table's single "160, 242": pt-BR Excel
      // reads that as the number 160,242.
      "X",
      "Y",
      t.dropsColIdentified,
      t.dropsColCollected,
      t.dropsColRemovedAt,
    ],
    drops.map((d) => [
      formatClock(d.time, true),
      d.itemId,
      resolveItem(d.itemId),
      d.amount,
      d.x,
      d.y,
      d.identified ? t.dropsYes : t.dropsNo,
      d.collected ? t.dropsYes : t.dropsNo,
      d.removedAt == null ? "" : formatClock(d.removedAt, true),
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
      fmtDecimal(r.perHour),
      formatClock(r.firstMs, true),
      formatClock(r.lastMs, true),
    ]),
  );
}
