import type { Replay } from "../../rrf/types";
import { useTabUrlSync } from "../../hooks/useTabUrlSync";
import { useAppStore } from "../../store/useAppStore";
import { PrintReport } from "../export/PrintReport";
import { useExports } from "../export/useExports";
import { usePrintReport } from "../export/usePrintReport";
import { Breadcrumb } from "./Breadcrumb";
import { ByMonsterTab } from "./ByMonsterTab";
import { ByPlayerTab } from "./ByPlayerTab";
import { DpsAnalysisTab } from "./DpsAnalysisTab";
import { ExplorerToolbar } from "./ExplorerToolbar";
import { StatsTab } from "./StatsTab";

/**
 * The tabbed explorer for a loaded replay: mode toolbar + export buttons,
 * drill-down breadcrumb (player/monster tabs only), and the active tab view.
 */
export function Explorer({ replay }: { replay: Replay }) {
  useTabUrlSync();
  const mode = useAppStore((s) => s.mode);
  const { printTab, run: runPrintReport } = usePrintReport(replay);
  const { exportPdf, exportXlsx, pdfBusy, xlsxBusy } = useExports(runPrintReport);

  return (
    <section id="explorer">
      <ExplorerToolbar
        onExportPdf={exportPdf}
        onExportXlsx={exportXlsx}
        pdfBusy={pdfBusy || printTab !== null}
        xlsxBusy={xlsxBusy}
      />
      {(mode === "byPlayer" || mode === "byMonster") && <Breadcrumb replay={replay} />}
      {mode === "stats" && <StatsTab replay={replay} />}
      {mode === "byPlayer" && <ByPlayerTab replay={replay} />}
      {mode === "byMonster" && <ByMonsterTab replay={replay} />}
      {mode === "dpsAnalysis" && <DpsAnalysisTab replay={replay} />}
      {printTab !== null && <PrintReport replay={replay} tabIndex={printTab} />}
    </section>
  );
}
