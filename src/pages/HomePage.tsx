import { DropZone } from "../features/dropzone/DropZone";
import { SeoIntro } from "../features/home/SeoIntro";
import { RecentReplays } from "../features/recent/RecentReplays";
import { ReplayView } from "../features/replay/ReplayView";
import { useReplayUrlSync } from "../hooks/useReplayUrlSync";
import { useAppStore } from "../store/useAppStore";

export function HomePage() {
  // Keeps ?r= and the loaded replay in sync; returns the current ?r= value.
  const r = useReplayUrlSync();
  const replay = useAppStore((s) => s.replay);
  const openedFromUrl = useAppStore((s) => s.openedFromUrl);
  const shareId = useAppStore((s) => s.shareId);

  // Whether to show the loaded replay vs. the home (dropzone + recent) view.
  // For a URL-opened replay the visibility is tied to the URL so the browser
  // Back button returns to the list: with no ?r= it hides (Back), and with a
  // ?r= it only shows once the loaded replay matches that id (otherwise we're
  // still fetching a different one). A locally-dropped replay (not opened from a
  // URL) stays visible regardless. The store isn't cleared, so Forward re-shows
  // it without a refetch.
  const showReplay = replay != null && (r == null ? !openedFromUrl : shareId === r);

  if (showReplay) return <ReplayView />;

  return (
    <>
      <SeoIntro />
      <DropZone />
      {/* Hide the recent list while a shared replay (?r=) is still loading. */}
      {r == null && <RecentReplays />}
    </>
  );
}
