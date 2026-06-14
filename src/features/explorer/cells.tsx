import { useState } from "react";
import type { ReferenceDb } from "../../db/loader";
import { t } from "../../i18n";
import type { Replay } from "../../rrf/types";
import { playerClass } from "./entityNames";

/** Sprite icon that removes itself when the PNG asset is missing. */
function SelfHidingIcon({ src, className }: { src: string; className: string }) {
  const [ok, setOk] = useState(true);
  if (!ok) return null;
  return (
    <img className={className} src={src} alt="" loading="lazy" onError={() => setOk(false)} />
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
  return (
    <span className="class-cell">
      {view && name !== t.none && (
        <SelfHidingIcon className="class-icon" src={`./icons/job/${view}.png`} />
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
        <SelfHidingIcon className="skill-icon" src={`./icons/skill/${skillId}.png`} />
      ) : null}
      {name}
    </span>
  );
}
