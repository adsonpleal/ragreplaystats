import { useState } from "react";
import type { ReferenceDb } from "../../db/loader";
import { t } from "../../i18n";
import type { Replay } from "rrfparser";
import { jobIconUrl, skillIconUrl } from "../../sim/ragassets";
import { playerClass } from "./entityNames";

/**
 * Sprite icon that removes itself when the PNG asset is missing. `fallbackSrc`
 * is tried once before giving up, for ids the client ships no art of.
 */
function SelfHidingIcon({
  src,
  fallbackSrc,
  className,
}: {
  src: string;
  fallbackSrc?: string;
  className: string;
}) {
  const [srcIndex, setSrcIndex] = useState(0);
  const chain = fallbackSrc ? [src, fallbackSrc] : [src];
  if (srcIndex >= chain.length) return null;
  return (
    <img
      key={chain[srcIndex]}
      className={className}
      src={chain[srcIndex]}
      alt=""
      loading="lazy"
      onError={() => setSrcIndex((i) => i + 1)}
    />
  );
}

/** Class cell: job icon (keyed by view id) + resolved class name. */
export function ClassCell({
  replay,
  db,
  aid,
}: {
  replay: Replay;
  db: ReferenceDb | null;
  aid: number;
}) {
  const name = playerClass(replay, db, aid);
  const view = replay.entities.get(aid)?.view;
  // The view id is the sharpest icon there is — it draws the peco, the dragon,
  // the madogear. The client ships no party icon for a few of those mounted
  // sprites (4278-4281, the mounted 4th classes), so fall back to the canonical
  // id for the same class name rather than showing a gap next to it.
  const canonical = name !== t.none ? db?.pcClassIconId(name) : undefined;
  return (
    <span className="class-cell">
      {view && name !== t.none && (
        <SelfHidingIcon
          className="class-icon"
          src={jobIconUrl(view)}
          fallbackSrc={canonical != null && canonical !== view ? jobIconUrl(canonical) : undefined}
        />
      )}
      {name}
    </span>
  );
}

/** Skill cell: skill icon (keyed by id) + name. Auto-attack/missing → plain text. */
export function SkillCell({ skillId, name }: { skillId?: number; name: string }) {
  return (
    <span className="skill-cell">
      {skillId ? (
        <SelfHidingIcon className="skill-icon" src={skillIconUrl(skillId)} />
      ) : null}
      {name}
    </span>
  );
}
