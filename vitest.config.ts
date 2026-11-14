import { defineConfig } from "vitest/config";

// Kept separate from vite.config.ts on purpose: the tests cover the plain Node
// build scripts in tools/, the pure aggregations in src/aggregate/, the pure
// serializers in src/features/ and the data/lookup half of src/sim/, so there's
// no reason to drag the React/JSX pipeline (and its warnings) into the run.
//
// The run has no DOM environment, so a test matched here must not render a
// component — keep those out of this glob rather than adding jsdom for one file.
// src/sim/render/ is still fair game. three.js's scene graph — Scene, Mesh,
// BufferGeometry, Texture — needs no DOM at all; only WebGLRenderer does, and
// nothing here constructs one. So a renderer can be built and stepped in a test
// (strEffect and bandedEffect both do) as long as it is never asked to draw.
export default defineConfig({
  test: {
    include: [
      "tools/**/*.test.mjs",
      "tools/**/*.test.ts",
      "src/aggregate/**/*.test.ts",
      "src/features/**/*.test.ts",
      "src/sim/**/*.test.ts",
      "src/ui/**/*.test.ts",
    ],
  },
});
