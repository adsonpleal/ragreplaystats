import { BrowserRouter, Route, Routes } from "react-router-dom";
import { HomePage } from "../pages/HomePage";
import { LeaderboardPage } from "../pages/LeaderboardPage";
import { useReferenceDb } from "../hooks/useReferenceDb";
import { SiteFooter } from "./SiteFooter";
import { TopBar } from "./TopBar";

export function App() {
  // Kick off the one-time reference DB load as soon as the app mounts; the
  // hook stashes it in the store so every component can resolve skill/mob/item
  // names without prop-drilling.
  useReferenceDb();

  return (
    <BrowserRouter>
      <TopBar />
      <main id="app">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/leaderboard" element={<LeaderboardPage />} />
          {/* /suggestions is retired — the unified tracker at
              issues.latam-tools.com.br took over the board. Firebase Hosting
              301s the old path (see `redirects` in firebase.json), so the route
              is intentionally gone from the router; any old link that escapes
              the redirect falls through to the catch-all below. */}
          <Route path="*" element={<HomePage />} />
        </Routes>
      </main>
      <SiteFooter />
    </BrowserRouter>
  );
}
