import { SuggestionsBoard } from "../features/suggestions/SuggestionsBoard";
import { SITE_URL, useSeo } from "../lib/seo";

export function SuggestionsPage() {
  useSeo({
    title: "Sugestões e comentários — RagnaRecap",
    description:
      "Deixe sua sugestão ou comentário sobre o RagnaRecap, a ferramenta de análise de replays .rrf do Ragnarok Online.",
    canonical: `${SITE_URL}/suggestions`,
  });
  return <SuggestionsBoard />;
}
