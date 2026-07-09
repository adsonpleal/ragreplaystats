# Effect golden tests

Deterministic reference renders of the replay-map skill/world effects, produced by
[`../effectGolden.ts`](../effectGolden.ts). Each effect is drawn in isolation on a
neutral checkerboard ground under a fixed RO-style 3/4 camera on a dark background,
so scale, placement, and faint additive glow all read clearly and reproducibly
(Math.random is seeded; `cellSize` is pinned to the map scene's value).

## Cases

`GOLDEN_CASES` in `effectGolden.ts` is the manifest under test — currently every
skill from the "AB - Celine" replay (`?r=wGzeHZtz5w`), each mapped to the effect
ids it resolves to. Skills with no renderable effect are asserted to render
nothing, with the reason (unmapped / non-STR-CYLINDER / missing table row).

## Reference

- `ab-celine-effects.png` — the golden board: all 17 table skills, 6 renderable
  (Impositio 84, Suffragium 88, Magnificat 76, Magnus 113+152+318, Basílica 374,
  Adoramus 721) + 11 documented "renders nothing".

## Regenerate / compare

The renderer needs a browser (WebGL), so this is a visual golden, not a byte
diff (software-GL antialiasing varies by machine). To refresh or check for a
regression, from the dev preview console:

```js
const g = await import('/src/dev/effectGolden.ts');
const url = await g.board();      // dataURL of the full board — compare to ab-celine-effects.png
await g.mount(374);               // or scrub one effect interactively
__golden.montage([0,400,800]);    // per-effect time grid
```

Add a new skill/effect by appending to `GOLDEN_CASES`.
