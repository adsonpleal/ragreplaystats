import { describe, expect, it } from "vitest";
import { dropsByItem, dropsSummary, filterDrops } from "./drops";
import type { GroundDrop } from "./groundDrops";

function drop(over: Partial<GroundDrop> = {}): GroundDrop {
  return {
    time: 0,
    groundId: 1,
    itemId: 617,
    amount: 1,
    x: 0,
    y: 0,
    identified: true,
    removedAt: null,
    collected: false,
    ...over,
  };
}

describe("filterDrops", () => {
  const drops = [drop({ collected: true }), drop({ groundId: 2 })];

  it("keeps everything by default", () => {
    expect(filterDrops(drops, "all")).toHaveLength(2);
  });

  it("narrows to the collected ones", () => {
    expect(filterDrops(drops, "collected").map((d) => d.groundId)).toEqual([1]);
  });

  it("narrows to the ones that got away", () => {
    expect(filterDrops(drops, "uncollected").map((d) => d.groundId)).toEqual([2]);
  });
});

describe("dropsSummary", () => {
  it("counts units, not drops, and keeps the collected part apart", () => {
    const summary = dropsSummary(
      [
        drop({ itemId: 617, amount: 3, collected: true, removedAt: 100 }),
        drop({ itemId: 617, amount: 1, removedAt: 200 }),
        drop({ itemId: 611, amount: 2 }),
      ],
      3_600_000,
    );
    expect(summary).toEqual({
      drops: 3,
      units: 6,
      collectedUnits: 3,
      distinctItems: 2,
      stillOnGround: 1,
      unitsPerHour: 6,
    });
  });

  it("is all zeroes for a recording with no drops", () => {
    expect(dropsSummary([], 60_000)).toEqual({
      drops: 0,
      units: 0,
      collectedUnits: 0,
      distinctItems: 0,
      stillOnGround: 0,
      unitsPerHour: 0,
    });
  });
});

describe("dropsByItem", () => {
  const resolveItem = (id: number) => (id === 617 ? "Caixa Azul Antiga" : `item#${id}`);

  it("sums units per item and keeps the collected part apart", () => {
    const rows = dropsByItem(
      [
        drop({ itemId: 617, amount: 1, time: 1_000, collected: true }),
        drop({ itemId: 617, amount: 2, time: 5_000 }),
        drop({ itemId: 611, amount: 2, time: 2_000, collected: true }),
      ],
      3_600_000,
      resolveItem,
    );
    expect(rows).toEqual([
      {
        itemId: 617,
        name: "Caixa Azul Antiga",
        drops: 2,
        quantity: 3,
        collected: 1,
        firstMs: 1_000,
        lastMs: 5_000,
        perHour: 3,
      },
      {
        itemId: 611,
        name: "item#611",
        drops: 1,
        quantity: 2,
        collected: 2,
        firstMs: 2_000,
        lastMs: 2_000,
        perHour: 2,
      },
    ]);
  });

  it("scales items/hour by the window it is given", () => {
    // 4 units in 30 minutes is 8 an hour — the same duration the Estatísticas
    // tab divides by for DPS, so the two never disagree about the session.
    const [row] = dropsByItem([drop({ amount: 4 })], 1_800_000, resolveItem);
    expect(row.perHour).toBe(8);
  });

  it("never divides by zero on a duration-less recording", () => {
    const [row] = dropsByItem([drop({ amount: 1 })], 0, resolveItem);
    expect(Number.isFinite(row.perHour)).toBe(true);
  });

  it("has no rows for a recording with no drops", () => {
    expect(dropsByItem([], 60_000, resolveItem)).toEqual([]);
  });
});
