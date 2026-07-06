import { Link, useLocation } from "react-router-dom";
import { t } from "../i18n";
import { useAppStore } from "../store/useAppStore";

/**
 * Top header: home link + nav to the leaderboard/suggestions routes. Each nav
 * link hides itself while its own route is active (matches the old
 * `applyRoute` behaviour).
 */
export function TopBar() {
  const { pathname } = useLocation();
  const path = pathname.replace(/\/+$/, "").toLowerCase();
  const clearReplay = useAppStore((s) => s.clearReplay);

  return (
    <header className="topbar">
      <div className="topbar-row">
        <h1>
          {/* Soft-navigate home and drop any loaded replay so the recent list
              shows again (the old setupHomeLink behaviour). The Link itself
              navigates to "/", clearing ?r=/?tab=. */}
          <Link id="home-link" to="/" onClick={() => clearReplay()}>
            RagnaRecap
          </Link>
        </h1>
        <nav className="topnav">
          {path !== "/leaderboard" && (
            <Link className="topnav-link topnav-link--secondary" to="/leaderboard">
              {t.leaderboardNav}
            </Link>
          )}
          {path !== "/suggestions" && (
            <Link className="topnav-link" to="/suggestions">
              {t.suggestionsNav}
            </Link>
          )}
          <a
            className="topnav-link"
            href="https://discord.gg/JCXTqqWq9Q"
            target="_blank"
            rel="noopener noreferrer"
            title={t.discordTitle}
          >
            {t.discordLink}
          </a>
        </nav>
      </div>
      <p className="muted" id="tagline">
        {t.appTagline}
      </p>
    </header>
  );
}
