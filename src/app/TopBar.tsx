import { Link, useLocation } from "react-router-dom";
import { t } from "../i18n";
import { useAppStore } from "../store/useAppStore";

const ISSUES_URL = "https://issues.latam-tools.com.br";

/** Speech bubble — the simulador's `pi pi-comment` on its Reportar button. */
function CommentIcon() {
  return (
    <svg className="topnav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M21 12a8 8 0 0 1-8 8H8l-5 3 1.4-4.2A8 8 0 1 1 21 12z" />
    </svg>
  );
}

/** Bulleted list — the simulador's `pi pi-list` on its Acompanhar button. */
function ListIcon() {
  return (
    <svg className="topnav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />
    </svg>
  );
}

/**
 * Top header: home link + nav to the leaderboard route plus the external links
 * (report an issue, follow the issue board, Discord). The internal link hides
 * itself while its own route is active (matches the old `applyRoute`
 * behaviour); the external ones are always visible since no route can match
 * them. The Reportar/Acompanhar pair mirrors the simulador's topbar — same
 * labels and icons — but keeps this site's accent instead of the simulador's
 * per-button severity colours, so the nav stays one palette.
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
          <a
            className="topnav-link"
            href={`${ISSUES_URL}/novo?projeto=recap`}
            target="_blank"
            rel="noopener noreferrer"
            title={t.issuesReportTitle}
          >
            <CommentIcon />
            {t.issuesReportNav}
          </a>
          <a
            className="topnav-link"
            href={`${ISSUES_URL}/?projeto=recap`}
            target="_blank"
            rel="noopener noreferrer"
            title={t.issuesBoardTitle}
          >
            <ListIcon />
            {t.issuesBoardNav}
          </a>
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
