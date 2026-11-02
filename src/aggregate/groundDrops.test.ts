import type { ItemAddEvent, PacketChunk } from "rrfparser";
import { describe, expect, it } from "vitest";
import { groundDropsFromChunks } from "./groundDrops";

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
    const drops = groundDropsFromChunks([chunk(394_664, FALL_617), chunk(394_667, FALL_1004)], []);
    expect(drops.map((d) => d.itemId)).toEqual([617, 1004]);
  });
});
