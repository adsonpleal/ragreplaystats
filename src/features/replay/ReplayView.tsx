import { useAppStore } from "../../store/useAppStore";
import { ShareControls } from "../dropzone/ShareControls";
import { Explorer } from "../explorer/Explorer";
import { SessionSummary } from "./SessionSummary";

/**
 * The loaded-replay view: share controls + session card + the tabbed explorer.
 * Subscribes to `namesVersion` so the whole subtree re-renders (and re-resolves
 * `mob#123` → real names) once the reference DB / bundled name data lands.
 */
export function ReplayView() {
  const replay = useAppStore((s) => s.replay);
  useAppStore((s) => s.namesVersion);
  if (!replay) return null;
  return (
    <>
      <ShareControls />
      <SessionSummary replay={replay} />
      <Explorer replay={replay} />
    </>
  );
}
