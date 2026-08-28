import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Absolute, NOT "./". Relative asset URLs are resolved against the current
  // document, so they only work while every route is reached without a trailing
  // slash. Firebase Hosting guaranteed that with `trailingSlash: false`;
  // Cloudflare Workers static assets does the OPPOSITE — it 307s /leaderboard to
  // /leaderboard/ — and from there "./assets/index-<hash>.js" resolves to
  // /leaderboard/assets/index-<hash>.js, which misses and gets answered by the
  // SPA fallback with index.html. The browser then tries to execute HTML as a
  // module and the app never boots. Verified against `wrangler dev`.
  //
  // The app is only ever served from the domain root, so "/" is correct and
  // cannot drift. Same reasoning as the absolute paths in src/db/manifest.ts.
  base: "/",
  plugins: [react()],
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
