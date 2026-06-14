import { useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { t } from "../../i18n";
import { useAppStore } from "../../store/useAppStore";

/**
 * Drag/drop + file-picker for `.rrf` files. Decoding runs in the browser via
 * the store; the "Enviar para o servidor" toggle additionally uploads the
 * bytes + summary for public sharing.
 */
export function DropZone() {
  const [, setSearchParams] = useSearchParams();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isOver, setIsOver] = useState(false);
  const [share, setShare] = useState(false);
  const status = useAppStore((s) => s.status);

  const handleFile = async (file: File) => {
    const store = useAppStore.getState();
    store.setStatus(t.parsing(file.name, (file.size / 1024).toFixed(1)));
    // Drop any stale ?r=/?tab= so a refresh doesn't reload the previous shared
    // replay (done while still mounted, before decode swaps in the replay view).
    setSearchParams(
      (prev) => {
        prev.delete("r");
        prev.delete("tab");
        return prev;
      },
      { replace: true },
    );
    try {
      const buf = await file.arrayBuffer();
      store.loadReplayFromBytes(buf, file.name, null);
      // Default is view-only; opt in to public sharing via the toggle. The
      // upload lives in the store so it survives this component unmounting once
      // the replay view takes over.
      if (share) void useAppStore.getState().uploadCurrent();
    } catch (err) {
      console.error(err);
      store.setStatus(t.parseError((err as Error).message));
    }
  };

  return (
    <section
      id="drop-zone"
      className={isOver ? "drop-zone is-over" : "drop-zone"}
      onDragOver={(e) => {
        e.preventDefault();
        setIsOver(true);
      }}
      onDragLeave={() => setIsOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsOver(false);
        const f = e.dataTransfer?.files?.[0];
        if (f) void handleFile(f);
      }}
    >
      <p id="drop-prompt">
        <span dangerouslySetInnerHTML={{ __html: t.dropPrompt }} />{" "}
        <label className="link" onClick={() => inputRef.current?.click()}>
          {t.browse}
        </label>
        .
      </p>
      <input
        ref={inputRef}
        type="file"
        accept=".rrf"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
        }}
      />
      <label className="drop-share-toggle">
        <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} />
        <span>{t.dropShareLabel}</span>
      </label>
      <p className="muted small drop-share-hint">{t.dropShareHint}</p>
      <p className="muted small">{status}</p>
    </section>
  );
}
