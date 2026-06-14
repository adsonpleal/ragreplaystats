import { type KeyboardEvent, useRef, useState } from "react";

export type ComboboxItem = { value: string; label: string; iconSrc?: string };

/** Class-icon that removes itself when the sprite asset is missing. */
function OptionIcon({ src }: { src: string }) {
  const [ok, setOk] = useState(true);
  if (!ok) return null;
  return <img className="class-icon" src={src} alt="" loading="lazy" onError={() => setOk(false)} />;
}

/**
 * Filter-as-you-type combobox (the leaderboard's MVP picker + class filter).
 * Shows the committed selection's label when idle; an editable query when open.
 */
export function Combobox({
  id,
  items,
  selectedValue,
  onSelect,
}: {
  id: string;
  items: ComboboxItem[];
  selectedValue: string | null;
  onSelect: (item: ComboboxItem) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const blurTimer = useRef<number | undefined>(undefined);

  const q = query.trim().toLowerCase();
  const matches = q ? items.filter((o) => o.label.toLowerCase().includes(q)) : items;
  const selectedLabel = items.find((o) => o.value === selectedValue)?.label ?? "";
  const activeIdx = Math.min(active, Math.max(0, matches.length - 1));

  const commit = (item: ComboboxItem) => {
    onSelect(item);
    setOpen(false);
    setQuery("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(matches.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = matches[activeIdx];
      if (pick) commit(pick);
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
    }
  };

  const showList = open && matches.length > 0;

  return (
    <div className="leaderboard-combobox">
      <input
        id={id}
        type="text"
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showList}
        disabled={items.length === 0}
        value={open ? query : selectedLabel}
        onFocus={(e) => {
          setOpen(true);
          setQuery("");
          setActive(0);
          e.target.select();
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          // Delay so a click on an option is captured before the list unmounts.
          blurTimer.current = window.setTimeout(() => {
            setOpen(false);
            setQuery("");
          }, 120);
        }}
      />
      <ul className="leaderboard-combobox-options" role="listbox" hidden={!showList}>
        {showList &&
          matches.map((o, i) => (
            <li
              key={o.value}
              role="option"
              aria-selected={o.value === selectedValue || undefined}
              className={i === activeIdx ? "leaderboard-combobox-option is-active" : "leaderboard-combobox-option"}
              // mousedown rather than click so we beat the input's blur handler.
              onMouseDown={(e) => {
                e.preventDefault();
                commit(o);
              }}
            >
              {o.iconSrc && <OptionIcon src={o.iconSrc} />}
              {o.label}
            </li>
          ))}
      </ul>
    </div>
  );
}
