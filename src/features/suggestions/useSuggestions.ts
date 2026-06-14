import { useCallback, useEffect, useState } from "react";
import { createSuggestion, listSuggestions, type Suggestion, SUGGESTION_MAX_LENGTH, voteSuggestion } from "../../firebase";
import { t } from "../../i18n";

const SUGGESTION_VOTES_KEY = "ragnarecap.suggestionVotes";
type LocalVoteMap = Record<string, "up" | "down">;

// Single-key dedup persisted in localStorage. Not a real auth boundary — the
// user can wipe storage and vote again, which is fine per the product brief.
function readVotes(): LocalVoteMap {
  try {
    const raw = localStorage.getItem(SUGGESTION_VOTES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as LocalVoteMap) : {};
  } catch {
    return {};
  }
}
function persistVotes(votes: LocalVoteMap) {
  try {
    localStorage.setItem(SUGGESTION_VOTES_KEY, JSON.stringify(votes));
  } catch {
    // localStorage may be unavailable (Safari private mode) — accept the loss.
  }
}

export function useSuggestions() {
  const [items, setItems] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [votes, setVotes] = useState<LocalVoteMap>(() => readVotes());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await listSuggestions());
    } catch (e) {
      console.error(e);
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = useCallback(
    async (text: string): Promise<boolean> => {
      if (text.length > SUGGESTION_MAX_LENGTH) {
        setStatusMsg(t.suggestionsTooLong);
        return false;
      }
      setPosting(true);
      setStatusMsg(t.suggestionsSending);
      try {
        await createSuggestion(text);
        setStatusMsg(t.suggestionsSent);
        await load();
        return true;
      } catch (e) {
        console.error(e);
        setStatusMsg(t.suggestionsSubmitError((e as Error).message));
        return false;
      } finally {
        setPosting(false);
      }
    },
    [load],
  );

  const vote = useCallback(
    async (id: string, dir: "up" | "down") => {
      if (readVotes()[id]) {
        setStatusMsg(t.suggestionsAlreadyVoted);
        return;
      }
      const bump = (sign: number) =>
        setItems((prev) =>
          prev.map((s) =>
            s.id === id
              ? {
                  ...s,
                  upvotes: s.upvotes + (dir === "up" ? sign : 0),
                  downvotes: s.downvotes + (dir === "down" ? sign : 0),
                }
              : s,
          ),
        );
      // Optimistic local bump + persisted vote so the UI reacts instantly.
      bump(1);
      const next = { ...readVotes(), [id]: dir };
      persistVotes(next);
      setVotes(next);
      try {
        await voteSuggestion(id, dir);
      } catch (e) {
        console.error(e);
        // Roll back the optimistic counter + the local vote record.
        bump(-1);
        const rolled = readVotes();
        delete rolled[id];
        persistVotes(rolled);
        setVotes(rolled);
        setStatusMsg(t.suggestionsVoteError((e as Error).message));
      }
    },
    [],
  );

  return { items, loading, error, posting, statusMsg, votes, submit, vote };
}
