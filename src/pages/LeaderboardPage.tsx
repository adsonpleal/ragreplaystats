import { Leaderboard } from "../features/leaderboard/Leaderboard";
import { SITE_URL, useSeo } from "../lib/seo";

export function LeaderboardPage() {
  useSeo({
    title: "Leaderboard de MVPs — RagnaRecap",
    description:
      "Ranking dos melhores replays de MVP do Ragnarok Online: maior dano, menor tempo até o abate e mais, a partir dos replays .rrf compartilhados no RagnaRecap.",
    canonical: `${SITE_URL}/leaderboard`,
  });
  return <Leaderboard />;
}
