import { useCallback, useState } from "react";
import type { Replay } from "../../rrf/types";
import { useAppStore } from "../../store/useAppStore";
import { PRINT_TABS } from "./PrintReport";
import { delay, snapshotNode, waitForImages } from "./reportSnapshot";
import { reportBaseName } from "./reportName";

/**
 * Drives the "Baixar PDF" flow: renders each tab off-screen **one at a time**,
 * snapshots it (canvas → img) into a static `#report-root`, then hands the
 * assembled root to the browser's print dialog ("Save as PDF"). Rendering one
 * tab per frame keeps a big replay from blocking the main thread. The live
 * drill-down selection is cleared for the report and restored afterwards.
 *
 * `printTab` is the index currently being rendered (or null when idle) — render
 * `<PrintReport tabIndex={printTab}/>` while it is non-null.
 */
export function usePrintReport(replay: Replay) {
  const [printTab, setPrintTab] = useState<number | null>(null);

  const run = useCallback(async () => {
    const store = useAppStore.getState();
    const saved = {
      selectedPlayers: store.selectedPlayers,
      selectedMonster: store.selectedMonster,
      selectedTimeRange: store.selectedTimeRange,
      selectedMobSkillTarget: store.selectedMobSkillTarget,
      dpsAnalysisRange: store.dpsAnalysisRange,
      byPlayerCompareRange: store.byPlayerCompareRange,
    };
    // Render every tab at top level (no drill-down) for the report.
    useAppStore.setState({
      selectedPlayers: new Set(),
      selectedMonster: null,
      selectedTimeRange: null,
      selectedMobSkillTarget: null,
      dpsAnalysisRange: null,
      byPlayerCompareRange: null,
    });

    const root = document.createElement("div");
    root.id = "report-root";
    try {
      for (let i = 0; i < PRINT_TABS.length; i++) {
        setPrintTab(i);
        // Yield so React mounts this tab and its charts/sprite settle.
        await delay(60);
        const live = document.getElementById("report-live");
        await waitForImages(live, 1200);
        await delay(40);
        // Snapshot (canvas -> img) so the print never catches a blank canvas.
        if (live) for (const child of live.childNodes) root.appendChild(snapshotNode(child));
      }
    } finally {
      // Tear down the live report + restore the on-screen drill-down.
      setPrintTab(null);
      useAppStore.setState(saved);
    }

    document.body.appendChild(root);
    await waitForImages(root, 2000);

    const prevTitle = document.title;
    document.title = reportBaseName(replay);
    document.body.classList.add("printing-report");
    window.addEventListener(
      "afterprint",
      () => {
        root.remove();
        document.body.classList.remove("printing-report");
        document.title = prevTitle;
      },
      { once: true },
    );
    window.print();
  }, [replay]);

  return { printTab, run };
}
