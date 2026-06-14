import { useState } from "react";
import { t } from "../../i18n";
import { useAppStore } from "../../store/useAppStore";

function downloadReplayBytes(bytes: Uint8Array, fileName: string | null) {
  const name = fileName?.endsWith(".rrf") ? fileName : `${fileName ?? "replay"}.rrf`;
  // Copy into a fresh ArrayBuffer so the Blob owns its memory independently.
  const blob = new Blob([bytes.slice().buffer], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Download-replay + copy-share-link buttons shown under the loaded replay.
 * Download only appears for replays opened from a shared URL — if the user
 * dropped a local file they already have it on disk.
 */
export function ShareControls() {
  const replayBytes = useAppStore((s) => s.replayBytes);
  const openedFromUrl = useAppStore((s) => s.openedFromUrl);
  const shareId = useAppStore((s) => s.shareId);
  const replayFileName = useAppStore((s) => s.replayFileName);
  const [copyLabel, setCopyLabel] = useState(t.copyLink);

  let link = "";
  if (shareId) {
    const url = new URL(location.href);
    url.searchParams.set("r", shareId);
    link = url.toString();
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopyLabel(t.linkCopied);
      setTimeout(() => setCopyLabel(t.copyLink), 1500);
    } catch {
      // Fallback: surface the link so the user can copy it manually.
      window.prompt(t.copyLink, link);
    }
  };

  if (!shareId && !(replayBytes && openedFromUrl)) return null;

  return (
    <div id="share-controls" className="share-controls">
      {replayBytes && openedFromUrl && (
        <button
          type="button"
          className="share-btn"
          onClick={() => downloadReplayBytes(replayBytes, replayFileName)}
        >
          {t.downloadReplay}
        </button>
      )}
      {shareId && (
        <>
          <button type="button" className="share-btn" onClick={copy}>
            {copyLabel}
          </button>
          <code className="share-link">{link}</code>
        </>
      )}
    </div>
  );
}
