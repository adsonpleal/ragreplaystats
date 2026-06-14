import { useState } from "react";
import { useAppStore } from "../../store/useAppStore";
import { downloadBlob, reportBaseName } from "./reportName";

/**
 * Toolbar export actions. XLSX builds a multi-sheet workbook from the same
 * numbers the tabs show (lazy-loaded writer). `runPrintReport` is provided by
 * the PrintReport flow and wired up in the export task.
 */
export function useExports(runPrintReport?: () => Promise<void>) {
  const [xlsxBusy, setXlsxBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);

  const exportXlsx = async () => {
    const { replay, db } = useAppStore.getState();
    if (!replay || xlsxBusy) return;
    setXlsxBusy(true);
    try {
      // Lazy-load the xlsx writer so its ~70 kB only ships when actually used.
      const { buildReplayXlsxBlob } = await import("../../ui/export-xlsx");
      const blob = await buildReplayXlsxBlob(replay, db);
      downloadBlob(blob, `${reportBaseName(replay)}.xlsx`);
    } finally {
      setXlsxBusy(false);
    }
  };

  const exportPdf = async () => {
    if (!runPrintReport || pdfBusy) return;
    setPdfBusy(true);
    try {
      await runPrintReport();
    } finally {
      setPdfBusy(false);
    }
  };

  return { exportXlsx, exportPdf, xlsxBusy, pdfBusy };
}
