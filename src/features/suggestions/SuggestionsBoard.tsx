import { useState } from "react";
import { type Suggestion } from "../../firebase";
import { locale, t } from "../../i18n";
import { useSuggestions } from "./useSuggestions";

function SuggestionRow({
  s,
  myVote,
  onVote,
}: {
  s: Suggestion;
  myVote: "up" | "down" | undefined;
  onVote: (id: string, dir: "up" | "down") => void;
}) {
  return (
    <div className="suggestion-row">
      <div className="suggestion-body">
        <div className="suggestion-text">{s.text}</div>
        <div className="suggestion-meta">
          {s.createdAt ? t.suggestionPostedAt(s.createdAt.toLocaleString(locale)) : ""}
        </div>
      </div>
      <div className="suggestion-votes">
        <button
          type="button"
          className={myVote === "up" ? "suggestion-vote-btn active" : "suggestion-vote-btn"}
          title={t.suggestionUpvote}
          disabled={!!myVote}
          onClick={() => onVote(s.id, "up")}
        >
          ▲ {s.upvotes}
        </button>
        <button
          type="button"
          className={myVote === "down" ? "suggestion-vote-btn active" : "suggestion-vote-btn"}
          title={t.suggestionDownvote}
          disabled={!!myVote}
          onClick={() => onVote(s.id, "down")}
        >
          ▼ {s.downvotes}
        </button>
      </div>
    </div>
  );
}

export function SuggestionsBoard() {
  const { items, loading, error, posting, statusMsg, votes, submit, vote } = useSuggestions();
  const [text, setText] = useState("");

  const hint = error ? t.suggestionsError(error) : loading ? t.suggestionsLoading : t.suggestionsHint;

  return (
    <section id="suggestions" className="suggestions">
      <h2>{t.suggestionsTitle}</h2>
      <p className="muted small">{hint}</p>
      <form
        className="suggestions-form"
        onSubmit={(e) => {
          e.preventDefault();
          const v = text.trim();
          if (!v || posting) return;
          void submit(v).then((ok) => {
            if (ok) setText("");
          });
        }}
      >
        <input
          type="text"
          maxLength={500}
          autoComplete="off"
          placeholder={t.suggestionsPlaceholder}
          value={text}
          disabled={posting}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className="share-btn" disabled={posting}>
          {posting ? t.suggestionsSending : t.suggestionsSubmit}
        </button>
      </form>
      <p className="muted small">{statusMsg ?? ""}</p>
      <div id="suggestions-list">
        {loading || error ? null : items.length === 0 ? (
          <p className="muted small">{t.suggestionsEmpty}</p>
        ) : (
          items.map((s) => <SuggestionRow key={s.id} s={s} myVote={votes[s.id]} onVote={vote} />)
        )}
      </div>
    </section>
  );
}
