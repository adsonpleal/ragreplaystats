import type { Replay } from "../../rrf/types";

/** Slug for download filenames: player + recording date, ascii-safe. */
export function reportBaseName(replay: Replay | null): string {
  const player =
    (replay?.sessionInfo.player || "replay")
      .normalize("NFKD")
      .replace(/[^\w]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "replay";
  const d = replay?.sessionInfo.recordedAt ?? new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `RagnaRecap-${player}-${stamp}`;
}

/** Trigger a browser download of a Blob under `fileName`. */
export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
