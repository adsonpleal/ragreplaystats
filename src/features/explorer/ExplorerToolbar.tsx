import { lazy, Suspense, useState } from "react";
import { t } from "../../i18n";
import { type Mode, useAppStore } from "../../store/useAppStore";

const MODES: ReadonlyArray<{ mode: Mode; label: string }> = [
  { mode: "stats", label: t.modeStats },
  { mode: "byPlayer", label: t.modeByPlayer },
  { mode: "byMonster", label: t.modeByMonster },
  { mode: "dpsAnalysis", label: t.modeDpsAnalysis },
];

// Pulls in three.js + the whole sim chunk; only fetched when the viewer opens.
const ReplayMap = lazy(() => import("../replay-map/ReplayMap"));

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
  const replay = useAppStore((s) => s.replay);
  const db = useAppStore((s) => s.db);
  const [mapOpen, setMapOpen] = useState(false);

  const canOpenMap = !!replay && !!replay.sessionInfo.aid && replay.entities.has(replay.sessionInfo.aid);

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
        {canOpenMap && (
          <button type="button" className="export-btn" onClick={() => setMapOpen(true)}>
            {t.replayMapButton}
          </button>
        )}
        <button type="button" className="export-btn" disabled={pdfBusy} onClick={onExportPdf}>
          {pdfBusy ? t.exportGenerating : t.exportPdf}
        </button>
        <button type="button" className="export-btn" disabled={xlsxBusy} onClick={onExportXlsx}>
          {xlsxBusy ? t.exportGenerating : t.exportXlsx}
        </button>
      </div>
      {mapOpen && replay && (
        <Suspense fallback={<div className="replay-map-status">{t.replayMapLoading}</div>}>
          <ReplayMap replay={replay} db={db} onClose={() => setMapOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}
