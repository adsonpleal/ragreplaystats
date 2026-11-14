import { PerspectiveCamera, Scene, Vector3 } from "three";
import { describe, expect, it } from "vitest";

import type { LoadedStr, StrLayer } from "./effectAssets";
import { StrEffect, pingPong, sampleLayer } from "./strEffect";

// The .str keyframe rules, tested on hand-built layers. A .str layer holds two
// kinds of key: type 0 is a SNAPSHOT (this is the quad's state now) and type 1
// is a VELOCITY that only applies when it sits at the same frame as the
// snapshot right before it (a "morph pair"). Everything a .str does follows
// from which pair is active at a given frame, so that is what these pin.

type Anim = StrLayer["animations"][number];

/** A keyframe with every field at rest; override just what the test is about. */
const key = (over: Partial<Anim>): Anim => ({
  frame: 0,
  type: 0,
  pos: [0, 0],
  uv: [0, 0, 0, 0, 0, 0, 0, 0],
  xy: [0, 0, 0, 0, 0, 0, 0, 0],
  aniframe: 0,
  anitype: 0,
  delay: 0,
  angle: 0,
  color: [255, 255, 255, 255],
  srcalpha: 5,
  destalpha: 2,
  mtpreset: 0,
  ...over,
});

const layer = (animations: Anim[], textures = 4): StrLayer => ({
  animations,
  textures: Array.from({ length: textures }, () => null),
});

describe("pingPong", () => {
  it("counts up to the last texture, back down, and up again", () => {
    const n = 4; // indices 0..3
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map((c) => pingPong(c, n))).toEqual([
      0, 1, 2, 3, 2, 1, 0, 1, 2,
    ]);
  });

  it("stays put when there is nowhere to go", () => {
    expect(pingPong(7, 1)).toBe(0);
    expect(pingPong(7, 0)).toBe(0);
  });

  it("never returns a negative index", () => {
    expect(pingPong(-5, 4)).toBe(0);
  });
});

describe("sampleLayer", () => {
  it("draws nothing before the layer's first snapshot", () => {
    const l = layer([key({ frame: 10 })]);
    expect(sampleLayer(l, 5)).toBeNull();
  });

  it("shows a lone snapshot only up to the layer's last key", () => {
    // A layer stops drawing once the playhead is past every key it has — a
    // single snapshot is on screen for its own frame and then gone, rather
    // than hanging there for the rest of the effect.
    const l = layer([key({ frame: 10, pos: [7, 8] })]);
    const s = sampleLayer(l, 10);
    expect(s).not.toBeNull();
    expect([s!.posX, s!.posY]).toEqual([7, 8]);
    expect(sampleLayer(l, 40)).toBeNull();
  });

  it("holds the snapshot while a later key keeps the layer alive", () => {
    const l = layer([key({ frame: 10, pos: [7, 8] }), key({ frame: 90, pos: [0, 0] })]);
    const s = sampleLayer(l, 40)!;
    expect([s.posX, s.posY]).toEqual([7, 8]);
  });

  it("drives every field by the velocity key, per elapsed frame", () => {
    const l = layer([
      key({ frame: 0, pos: [10, 20], angle: 100, color: [100, 100, 100, 200] }),
      key({ frame: 0, type: 1, pos: [2, -1], angle: 5, color: [0, 0, 0, -10] }),
    ]);
    const s = sampleLayer(l, 4)!;
    expect([s.posX, s.posY]).toEqual([18, 16]);
    expect(s.angleRaw).toBe(120);
    expect(s.a).toBeCloseTo(160 / 255, 5);
  });

  it("does not apply a velocity key that is not paired with the snapshot", () => {
    // Pairing is positional AND same-frame. A velocity key at a LATER frame
    // belongs to a movement this snapshot is not part of, and since there is
    // no further snapshot the layer is finished: it must not drift by 9 a
    // frame, and it must not sit there either.
    const l = layer([key({ frame: 0, pos: [1, 1] }), key({ frame: 5, type: 1, pos: [9, 9] })]);
    expect(sampleLayer(l, 5)).toBeNull();
  });

  it("ends the layer once its movement is over", () => {
    // A finished morph: the snapshot at 0 is the LAST snapshot the layer has,
    // and a velocity key has already been passed. The client stops drawing it —
    // it does not freeze the quad on its final state for the rest of the file.
    const l = layer([
      key({ frame: 0 }),
      key({ frame: 0, type: 1, pos: [1, 0] }),
      key({ frame: 20, type: 1, pos: [1, 0] }),
    ]);
    expect(sampleLayer(l, 25)).toBeNull();
  });

  it("keeps drawing while a later snapshot is still to come", () => {
    const l = layer([
      key({ frame: 0 }),
      key({ frame: 0, type: 1, pos: [1, 0] }),
      key({ frame: 30, pos: [99, 0] }),
    ]);
    expect(sampleLayer(l, 25)).not.toBeNull();
  });

  it("drops a layer that has faded out", () => {
    const l = layer([
      key({ frame: 0, color: [255, 255, 255, 10] }),
      key({ frame: 0, type: 1, color: [0, 0, 0, -1] }),
    ]);
    expect(sampleLayer(l, 5)).not.toBeNull();
    expect(sampleLayer(l, 20)).toBeNull();
  });

  describe("texture motion", () => {
    const motion = (anitype: number, delay: number, at: number, textures = 4) =>
      sampleLayer(
        layer([key({ frame: 0 }), key({ frame: 0, type: 1, anitype, delay })], textures),
        at,
      )!.texIdx;

    it("stops at the last texture (2)", () => {
      expect(motion(2, 1, 2)).toBe(2);
      expect(motion(2, 1, 9)).toBe(3);
    });

    it("loops (3)", () => {
      expect(motion(3, 1, 2)).toBe(2);
      expect(motion(3, 1, 5)).toBe(1);
    });

    it("loops backwards without ever going negative (4)", () => {
      // Walking backwards from 0 through a 4-texture layer: 0, 3, 2, 1, 0, …
      // A plain JS remainder gives −1 at the first step. The multiples of the
      // count are what tell a correct wrap from the usual wrong fixes: at
      // frame 4 the index is back at 0, not at 4 or at the last texture.
      expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map((at) => motion(4, 1, at))).toEqual([
        0, 3, 2, 1, 0, 3, 2, 1, 0,
      ]);
    });

    it("ping-pongs (5)", () => {
      expect([0, 1, 2, 3, 4, 5, 6].map((at) => motion(5, 1, at))).toEqual([0, 1, 2, 3, 2, 1, 0]);
    });

    it("leaves the texture alone with no motion (0)", () => {
      const l = layer([
        key({ frame: 0, aniframe: 2 }),
        key({ frame: 0, type: 1, anitype: 0, delay: 1 }),
      ]);
      expect(sampleLayer(l, 9)!.texIdx).toBe(2);
    });
  });
});

describe("how long an effect runs", () => {
  // The .str header's frame count is not when the effect is over. Many files
  // declare far more frames than they animate, and roBrowser believed the
  // header: a one-shot lingered doing nothing and a LOOPED effect sat blank for
  // the whole dead tail of every cycle.
  const str = (animations: Anim[], header: number): LoadedStr => ({
    fps: 60,
    maxKey: header,
    layers: [layer(animations)],
  });

  const run = (effect: LoadedStr) => {
    const e = new StrEffect(new Scene(), effect);
    const camera = new PerspectiveCamera();
    const anchor = new Vector3();
    const aliveAt = (frame: number) => e.update((frame / 60) * 1000, camera, anchor, false);
    return { aliveAt, dispose: () => e.dispose() };
  };

  it("ends just after its last keyframe, not at the header's count", () => {
    const { aliveAt, dispose } = run(str([key({ frame: 0 }), key({ frame: 5 })], 120));
    expect(aliveAt(5.5)).toBe(true); // the last key is a frame that gets drawn
    expect(aliveAt(6.5)).toBe(false);
    expect(aliveAt(50)).toBe(false); // nowhere near the header's 120
    dispose();
  });

  it("still runs a file whose header is honest", () => {
    const { aliveAt, dispose } = run(str([key({ frame: 0 }), key({ frame: 30 })], 31));
    expect(aliveAt(29)).toBe(true);
    // The inclusive frame is what makes this bite: a port that ends AT the last
    // key instead of after it passes every other assertion here.
    expect(aliveAt(30.5)).toBe(true);
    expect(aliveAt(31.5)).toBe(false);
    dispose();
  });
});
