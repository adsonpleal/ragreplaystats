import { locale, t } from "../../i18n";
import type { Replay } from "../../rrf/types";
import { ByMonsterTab } from "../explorer/ByMonsterTab";
import { ByPlayerTab } from "../explorer/ByPlayerTab";
import { DpsAnalysisTab } from "../explorer/DpsAnalysisTab";
import { StatsTab } from "../explorer/StatsTab";
import { SessionSummary } from "../replay/SessionSummary";

export const PRINT_TABS = [
  { title: t.modeStats, Comp: StatsTab },
  { title: t.modeByPlayer, Comp: ByPlayerTab },
  { title: t.modeByMonster, Comp: ByMonsterTab },
  { title: t.modeDpsAnalysis, Comp: DpsAnalysisTab },
] as const;

/**
 * Off-screen render of a SINGLE report tab (the caller snapshots it, then asks
 * for the next index — one at a time, mirroring the old export's sequential
 * render so a big replay never blocks the main thread by mounting every tab's
 * charts at once). The header + session card ride along with the first tab.
 * Kept visible-but-off-screen so uPlot charts + the sprite actually paint.
 */
export function PrintReport({ replay, tabIndex }: { replay: Replay; tabIndex: number }) {
  const tab = PRINT_TABS[tabIndex];
  if (!tab) return null;
  const { title, Comp } = tab;
  return (
    <div
      id="report-live"
      // In-viewport but invisible/behind the page, so lazy-loaded icons still
      // enter the viewport and fetch before we snapshot. (Off-screen left:-99999
      // would keep them from ever loading.)
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "820px",
        opacity: 0,
        zIndex: -1,
        pointerEvents: "none",
      }}
    >
      {tabIndex === 0 && (
        <>
          <div className="report-header">
            <h1>{t.exportReportTitle}</h1>
            <p className="muted small">
              {t.exportReportGeneratedAt(new Date().toLocaleString(locale))}
            </p>
          </div>
          <SessionSummary replay={replay} />
        </>
      )}
      <section className="print-tab">
        <h2 className="print-tab-title">{title}</h2>
        <Comp replay={replay} />
      </section>
    </div>
  );
}
