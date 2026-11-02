import type { ItemAddEvent, PacketChunk } from "rrfparser";
import { describe, expect, it } from "vitest";
import {
  dropTimeline,
  dropsByItem,
  filterDrops,
  groundDropsFromChunks,
  pickBucketMs,
  type GroundDrop,
} from "./drops";

/**
 * Every `hex` below is a real packet, copied byte for byte out of a LATAM `.rrf`
 * recording (the file is named with each one). Offsets guessed from a wiki are
 * how field-shift bugs get in, so the layout is pinned against the wire.
 */
function chunk(time: number, hex: string): PacketChunk {
  const bytes = Uint8Array.from(hex.split(" ").map((h) => parseInt(h, 16)));
  return {
    id: 210,
    time,
    length: bytes.length,
    data: bytes,
    packetId: bytes[0] | (bytes[1] << 8),
  };
}

function add(time: number, itemId: number, amount: number): ItemAddEvent {
  return { time, slot: 0, itemId, amount, refine: 0 };
}

// UetJ9zxC6u.rrf — an Old Blue Box (617) falls at cell (160,242) and the
// recorder picks it up ~2.4 s later.
const FALL_617 = "dd 0a c1 b4 00 00 69 02 00 00 02 00 01 a0 00 f2 00 06 0c 01 00 01 00 00";
const DISAPPEAR_617 = "a1 00 c1 b4 00 00";
// UetJ9zxC6u.rrf — a second drop in the same burst, item 1004 at (161,241).
const FALL_1004 = "dd 0a c9 b4 00 00 ec 03 00 00 03 00 01 a1 00 f1 00 06 03 01 00 01 00 00";
// dwxib3eNEH.rrf — a stack of 3, which is what pins the amount offset.
const FALL_611_X3 = "dd 0a ac 47 00 00 63 02 00 00 02 00 01 de 00 08 01 09 06 03 00 00 00 00";
// 8pAVujGdKR.rrf — an unidentified armour whose id does not fit in 16 bits,
// which is what pins the item id as a u32.
const FALL_500026 = "dd 0a e8 b9 00 00 3a a1 07 00 05 00 00 7c 00 22 01 0c 06 01 00 01 02 00";

describe("groundDropsFromChunks", () => {
  it("decodes a real ZC_ITEM_FALL_ENTRY", () => {
    const [drop] = groundDropsFromChunks([chunk(394_664, FALL_617)], []);
    expect(drop).toEqual({
      time: 394_664,
      groundId: 46273,
      itemId: 617,
      amount: 1,
      x: 160,
      y: 242,
      identified: true,
      removedAt: null,
      collected: false,
    });
  });

  it("reads a stacked drop's amount", () => {
    const [drop] = groundDropsFromChunks([chunk(1_000, FALL_611_X3)], []);
    expect(drop.itemId).toBe(611);
    expect(drop.amount).toBe(3);
    expect(drop.x).toBe(222);
    expect(drop.y).toBe(264);
  });

  it("reads an item id above 65535 and an unidentified flag", () => {
    const [drop] = groundDropsFromChunks([chunk(1_000, FALL_500026)], []);
    expect(drop.itemId).toBe(500026);
    expect(drop.identified).toBe(false);
  });

  it("records when the item left the ground", () => {
    const [drop] = groundDropsFromChunks(
      [chunk(394_664, FALL_617), chunk(397_105, DISAPPEAR_617)],
      [],
    );
    expect(drop.removedAt).toBe(397_105);
  });

  it("leaves removedAt null for an item still lying there at the end", () => {
    const [drop] = groundDropsFromChunks([chunk(394_664, FALL_617)], []);
    expect(drop.removedAt).toBeNull();
  });

  it("ignores a removal for a ground id that never fell", () => {
    // An item already on the floor when the player came into view: the recording
    // saw it go, never saw it drop, so it is not a drop of this session.
    expect(groundDropsFromChunks([chunk(397_105, DISAPPEAR_617)], [])).toEqual([]);
  });

  it("counts the drop as collected when a pickup ack matches the removal", () => {
    const [drop] = groundDropsFromChunks(
      [chunk(394_664, FALL_617), chunk(397_105, DISAPPEAR_617)],
      [add(397_103, 617, 1)],
    );
    expect(drop.collected).toBe(true);
  });

  it("does not count a removal with no pickup ack — someone else took it", () => {
    const [drop] = groundDropsFromChunks(
      [chunk(394_664, FALL_617), chunk(397_105, DISAPPEAR_617)],
      [],
    );
    expect(drop.collected).toBe(false);
  });

  it("does not match a pickup ack of a different item", () => {
    const [drop] = groundDropsFromChunks(
      [chunk(394_664, FALL_617), chunk(397_105, DISAPPEAR_617)],
      [add(397_103, 1004, 1)],
    );
    expect(drop.collected).toBe(false);
  });

  it("does not match a pickup ack far from the removal", () => {
    // A bought or withdrawn item of the same kind must not turn a drop someone
    // else looted into one of ours.
    const [drop] = groundDropsFromChunks(
      [chunk(394_664, FALL_617), chunk(397_105, DISAPPEAR_617)],
      [add(300_000, 617, 1)],
    );
    expect(drop.collected).toBe(false);
  });

  it("spends each pickup ack once", () => {
    // Two identical items leave the floor together; one ack means one of them
    // was ours, not both.
    const drops = groundDropsFromChunks(
      [
        chunk(394_664, FALL_617),
        chunk(394_665, FALL_617.replace("c1 b4", "c2 b4")),
        chunk(397_105, DISAPPEAR_617),
        chunk(397_106, DISAPPEAR_617.replace("c1 b4", "c2 b4")),
      ],
      [add(397_103, 617, 1)],
    );
    expect(drops.map((d) => d.collected)).toEqual([true, false]);
  });

  it("skips a truncated packet instead of reading past its end", () => {
    expect(groundDropsFromChunks([chunk(1_000, "dd 0a c1 b4 00 00")], [])).toEqual([]);
  });

  it("keeps drops in packet order", () => {
    const drops = groundDropsFromChunks(
      [chunk(394_664, FALL_617), chunk(394_667, FALL_1004)],
      [],
    );
    expect(drops.map((d) => d.itemId)).toEqual([617, 1004]);
  });
});

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

describe("dropTimeline", () => {
  it("buckets what fell against what was picked up", () => {
    const series = dropTimeline(
      [
        drop({ time: 1_000, amount: 1, collected: true }),
        drop({ time: 4_000, amount: 2 }),
        drop({ time: 11_000, amount: 5, collected: true }),
      ],
      15_000,
      5_000,
    );
    expect(series.ts).toEqual([2_500, 7_500, 12_500]);
    expect(series.dropped).toEqual([3, 0, 5]);
    expect(series.collected).toEqual([1, 0, 5]);
  });

  it("extends past the declared duration rather than dropping a late drop", () => {
    const series = dropTimeline([drop({ time: 12_000, amount: 1 })], 5_000, 5_000);
    expect(series.dropped).toEqual([0, 0, 1]);
  });

  it("is empty for a recording with no drops", () => {
    expect(dropTimeline([], 60_000, 5_000).ts).toEqual([]);
  });
});

describe("pickBucketMs", () => {
  it("keeps a short recording fine-grained", () => {
    expect(pickBucketMs(180_000)).toBe(5_000);
  });

  it("coarsens a long one instead of drawing a thousand points", () => {
    expect(pickBucketMs(7_200_000)).toBe(120_000);
  });
});
