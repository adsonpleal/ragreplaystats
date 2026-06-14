import { t } from "../../i18n";
import { type Mode, useAppStore } from "../../store/useAppStore";

const MODES: ReadonlyArray<{ mode: Mode; label: string }> = [
  { mode: "stats", label: t.modeStats },
  { mode: "byPlayer", label: t.modeByPlayer },
  { mode: "byMonster", label: t.modeByMonster },
  { mode: "dpsAnalysis", label: t.modeDpsAnalysis },
];

export function ExplorerToolbar({
  onExportPdf,
  onExportXlsx,
  pdfBusy,
  xlsxBusy,
}: {
  onExportPdf: () => void;
  onExportXlsx: () => void;
  pdfBusy: boolean;
  xlsxBusy: boolean;
}) {
  const mode = useAppStore((s) => s.mode);
  const setMode = useAppStore((s) => s.setMode);

  return (
    <div className="explorer-toolbar">
      <div className="mode-toggle" role="tablist">
        {MODES.map(({ mode: m, label }) => (
          <button
            key={m}
            type="button"
            className={mode === m ? "mode-btn active" : "mode-btn"}
            role="tab"
            onClick={() => {
              if (mode !== m) setMode(m);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="export-controls">
        <button type="button" className="export-btn" disabled={pdfBusy} onClick={onExportPdf}>
          {pdfBusy ? t.exportGenerating : t.exportPdf}
        </button>
        <button type="button" className="export-btn" disabled={xlsxBusy} onClick={onExportXlsx}>
          {xlsxBusy ? t.exportGenerating : t.exportXlsx}
        </button>
      </div>
    </div>
  );
}
