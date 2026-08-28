import { defineConfig } from "vitest/config";

// Kept separate from vite.config.ts on purpose: the tests cover the plain Node
// build scripts in tools/, so there's no reason to drag the React/JSX pipeline
// (and its warnings) into the run.
export default defineConfig({
  test: {
    include: ["tools/**/*.test.mjs", "tools/**/*.test.ts"],
  },
});
