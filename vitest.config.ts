import { defineConfig } from "vitest/config";

// Kept separate from vite.config.ts on purpose: the tests cover the plain Node
// build scripts in tools/, the pure aggregations in src/aggregate/ and the pure
// serializers in src/features/, so there's no reason to drag the React/JSX
// pipeline (and its warnings) into the run.
//
// The run has no DOM environment, so a test matched here must not render a
// component — keep those out of this glob rather than adding jsdom for one file.
export default defineConfig({
  test: {
    include: [
      "tools/**/*.test.mjs",
      "tools/**/*.test.ts",
      "src/aggregate/**/*.test.ts",
      "src/features/**/*.test.ts",
      "src/ui/**/*.test.ts",
    ],
  },
});
