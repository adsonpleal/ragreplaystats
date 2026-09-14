import { t } from "../../i18n";
import { useAppStore } from "../../store/useAppStore";

/**
 * "Agrupar fases dos MVPs" — folds a groupable monster's phases into one row.
 * Renders nothing when the replay has no such monster.
 */
export function GroupPhasesToggle() {
  const hasPhases = useAppStore((s) => s.bossPhases.aliases.size > 0);
  const groupPhases = useAppStore((s) => s.groupPhases);
  const setGroupPhases = useAppStore((s) => s.setGroupPhases);
  if (!hasPhases) return null;
  return (
    <label className="group-phases-toggle" title={t.groupPhasesHint}>
      <input type="checkbox" checked={groupPhases} onChange={(e) => setGroupPhases(e.target.checked)} />
      <span>{t.groupPhasesLabel}</span>
    </label>
  );
}
