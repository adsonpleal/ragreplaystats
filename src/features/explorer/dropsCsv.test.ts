import { describe, expect, it } from "vitest";
import type { DropItemRow, GroundDrop } from "../../aggregate/drops";
import { dropEventsCsv, dropItemsCsv } from "./dropsCsv";

function drop(over: Partial<GroundDrop> = {}): GroundDrop {
  return {
    time: 123_456,
    groundId: 1,
    itemId: 617,
    amount: 1,
    x: 160,
    y: 242,
    identified: true,
    removedAt: null,
    collected: false,
    ...over,
  };
}

function row(over: Partial<DropItemRow> = {}): DropItemRow {
  return {
    itemId: 617,
    name: "Caixa Azul Antiga",
    drops: 2,
    quantity: 3,
    collected: 1,
    firstMs: 1_000,
    lastMs: 123_456,
    perHour: 12.345,
    ...over,
  };
}

/** Everything after the BOM, split into lines. */
function lines(csv: string): string[] {
  expect(csv.startsWith("﻿")).toBe(true);
  return csv.slice(1).trimEnd().split("\r\n");
}

describe("dropEventsCsv", () => {
  const resolveItem = () => "Caixa Azul Antiga";

  it("writes one semicolon-separated row per drop", () => {
    const out = lines(dropEventsCsv([drop({ collected: true, removedAt: 125_000 })], resolveItem));
    expect(out[0].split(";")).toHaveLength(7);
    expect(out[1]).toBe("2:03,456;617;Caixa Azul Antiga;1;160,242;Sim;2:05,000");
  });

  it("leaves the removal column empty for an item still on the ground", () => {
    const out = lines(dropEventsCsv([drop()], resolveItem));
    expect(out[1].endsWith(";")).toBe(true);
  });

  it("quotes an item name that contains the separator", () => {
    // Nothing stops a future item name from carrying a `;`, and an unquoted one
    // would shift every column after it.
    const out = lines(dropEventsCsv([drop()], () => 'Espada; "Longa"'));
    expect(out[1]).toContain('"Espada; ""Longa"""');
  });

  it("writes the header alone when nothing dropped", () => {
    expect(lines(dropEventsCsv([], resolveItem))).toHaveLength(1);
  });
});

describe("dropItemsCsv", () => {
  it("writes itens/hora with a decimal comma", () => {
    // The separator is `;` because pt-BR Excel splits on it; a `.` decimal in
    // the same file would then be read as text, not a number.
    const out = lines(dropItemsCsv([row()]));
    expect(out[1]).toBe("617;Caixa Azul Antiga;2;3;1;12,35;0:01,000;2:03,456");
  });

  it("writes the header alone when nothing dropped", () => {
    expect(lines(dropItemsCsv([]))).toHaveLength(1);
  });
});
