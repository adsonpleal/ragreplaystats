import { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../../i18n";
import { formatDuration } from "../../lib/format";
import type { ReferenceDb } from "../../db/loader";
import type { Replay } from "../../rrf/types";
import { CHEVRON_LEFT, CHEVRON_RIGHT, ChevronButton } from "../../ui/ChevronButton";
import { CharacterViewer } from "../../ui/CharacterViewer";
import { useAppStore } from "../../store/useAppStore";
import {
  buildEquipmentPages,
  EQUIP_SLOTS,
  ESPECIAL_SLOT_ORDERS,
  type EquippedRow,
  NORMAL_SLOT_ORDERS,
} from "./equipmentPages";
import { itemDpUrl, resolveItemName } from "./resolvers";

/** Item-icon `<img>` that hides itself when the PNG asset is missing. */
function EquipIcon({ id, className, size }: { id: number; className: string; size: number }) {
  const [ok, setOk] = useState(true);
  if (!ok) return null;
  return (
    <img
      className={className}
      src={`./icons/item/${id}.png`}
      alt=""
      width={size}
      height={size}
      onError={() => setOk(false)}
    />
  );
}

function EquipCard({
  slotLabel,
  row,
  isChanged,
  isOpen,
  onToggle,
  db,
}: {
  slotLabel: string;
  row: EquippedRow | null;
  isChanged: boolean;
  isOpen: boolean;
  onToggle: () => void;
  db: ReferenceDb | null;
}) {
  // Empty slot — a non-interactive placeholder so the grid stays aligned.
  if (!row) {
    return (
      <div className="equip-item-card equip-item-card--empty">
        <span className="equip-item-name">{slotLabel}</span>
      </div>
    );
  }

  const displayName = row.refine > 0 ? `+${row.refine} ${row.itemName}` : row.itemName;
  const cls =
    "equip-item-card" +
    (isChanged ? " equip-item-card--changed" : "") +
    (isOpen ? " is-open" : "");

  return (
    <div className={cls} tabIndex={0} onClick={onToggle}>
      <EquipIcon id={row.itemId} className="equip-item-icon" size={24} />
      <span className="equip-item-name">{displayName}</span>
      <div className="equip-popover">
        <div className="equip-popover-slot">{row.slotLabel}</div>
        <a
          className="equip-popover-name"
          href={itemDpUrl(row.itemId)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
        >
          {displayName}
        </a>
        {row.cards.length > 0 && (
          <>
            <span className="equip-popover-section">{t.equipCardsTitle}</span>
            {row.cards.map((cardId, i) => (
              <a
                key={i}
                className="equip-popover-card-row"
                href={itemDpUrl(cardId)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                <EquipIcon id={cardId} className="equip-popover-card-icon" size={16} />
                <span>{resolveItemName(db, cardId)}</span>
              </a>
            ))}
          </>
        )}
        {row.options.length > 0 && (
          <>
            <span className="equip-popover-section">{t.equipOptionsTitle}</span>
            {row.options.map((opt, i) => (
              <span key={i} className="equip-popover-option-row">
                {db?.resolveRandomOption(opt.id, opt.value) ?? `#${opt.id}: ${opt.value}`}
              </span>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/** The "Equipamento" card: paged worn-gear grid (Equip / viewer / Especial). */
export function Equipment({ replay }: { replay: Replay }) {
  const db = useAppStore((s) => s.db);
  // `db` is a stable reference once loaded; the item/skill/mob names land later
  // and only bump `namesVersion`. Depend on it so the resolved
  // item names (captured into the pages here) refresh once that data arrives.
  const namesVersion = useAppStore((s) => s.namesVersion);
  const pages = useMemo(() => buildEquipmentPages(replay, db), [replay, db, namesVersion]);
  const [pageIdx, setPageIdx] = useState(0);
  const [openSlot, setOpenSlot] = useState<number | null>(null);
  const resolveItemView = useCallback((id: number) => db?.resolveItemView(id) ?? null, [db]);

  // A click outside any equip card dismisses the sticky-open popover.
  useEffect(() => {
    if (openSlot === null) return;
    const onDoc = (e: MouseEvent) => {
      if ((e.target as HTMLElement | null)?.closest(".equip-item-card")) return;
      setOpenSlot(null);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [openSlot]);

  // Nothing worn at any point — keep the pane empty.
  if (pages.length === 1 && pages[0].rows.length === 0) return null;

  const safePage = Math.min(pageIdx, pages.length - 1);
  const page = pages[safePage];
  const wornByOrder = new Map(page.rows.map((r) => [r.slotOrder, r]));
  // Catch-all items (mask matched no known bit) tack onto the Especial group.
  const extraEspecial = page.rows
    .filter((r) => r.slotOrder >= EQUIP_SLOTS.length)
    .map((r) => r.slotOrder);

  const player = replay.entities.get(replay.sessionInfo.aid);
  const showViewer = player?.kind === "pc";

  const renderGroup = (label: string, slotOrders: readonly number[]) => (
    <div className="equip-group">
      <div className="equip-group-heading">{label}</div>
      <div className="equip-cards">
        {slotOrders.map((order) => {
          const slotLabel = order < EQUIP_SLOTS.length ? EQUIP_SLOTS[order][1]() : t.slotOther;
          return (
            <EquipCard
              key={order}
              slotLabel={slotLabel}
              row={wornByOrder.get(order) ?? null}
              isChanged={page.changedSlots.has(order)}
              isOpen={openSlot === order}
              onToggle={() => setOpenSlot((cur) => (cur === order ? null : order))}
              db={db}
            />
          );
        })}
      </div>
    </div>
  );

  return (
    <div id="equipment-pane">
      <h2 className="section-title">{t.equipmentTitle}</h2>
      {pages.length > 1 && (
        <div id="equipment-pager">
          <div className="equip-pager">
            <ChevronButton
              path={CHEVRON_LEFT}
              label={t.paginationPrev}
              disabled={safePage === 0}
              onClick={() => setPageIdx((i) => Math.max(0, i - 1))}
            />
            <span className="equip-page-counter">{t.equipmentPageOf(safePage + 1, pages.length)}</span>
            <ChevronButton
              path={CHEVRON_RIGHT}
              label={t.paginationNext}
              disabled={safePage === pages.length - 1}
              onClick={() => setPageIdx((i) => Math.min(pages.length - 1, i + 1))}
            />
            <span className="equip-page-caption">
              {safePage === 0 ? t.equipmentPageStart : t.equipmentChangedAt(formatDuration(page.timeMs))}
            </span>
          </div>
        </div>
      )}
      <div id="equipment-view">
        <div className="equip-groups">
          {renderGroup(t.equipGroupEquip, NORMAL_SLOT_ORDERS)}
          {showViewer && (
            <CharacterViewer
              jobView={player.view}
              sex={player.sex}
              hairStyle={player.hairStyle}
              hairColor={player.hairColor}
              clothesColor={player.clothesColor}
              resolveItemView={resolveItemView}
              rows={page.rows}
            />
          )}
          {renderGroup(t.equipGroupEspecial, [...ESPECIAL_SLOT_ORDERS, ...extraEspecial])}
        </div>
      </div>
    </div>
  );
}
