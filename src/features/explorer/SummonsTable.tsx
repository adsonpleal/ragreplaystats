import type { PlayerAgg } from "../../aggregate/index";
import { t } from "../../i18n";
import { fmt } from "../../lib/format";
import type { Replay } from "rrfparser";
import { type Column, DataTable, type TableOptions } from "../../ui/DataTable";
import { hasCritData, summonDisplayName, summonKindLabel, summonOwnerName } from "./entityNames";

/**
 * The summons' twin of a players table: same damage columns, with the class and
 * level swapped for what the summon is and whose it is. `killsLabel` follows the
 * players table it sits next to ("Abates" / "Golpe fatal").
 */
export function SummonsTable({
  replay,
  rows,
  killsLabel,
  showMonstersHit,
  options,
}: {
  replay: Replay;
  rows: PlayerAgg[];
  killsLabel: string;
  showMonstersHit: boolean;
  options?: TableOptions<PlayerAgg>;
}) {
  const crit = hasCritData(replay);
  const cols: Column<PlayerAgg>[] = [
    {
      key: "name",
      label: t.colSummon,
      format: (r) => summonDisplayName(replay, r.aid),
      sortValue: (r) => summonDisplayName(replay, r.aid),
    },
    {
      key: "kind",
      label: t.colSummonKind,
      format: (r) => summonKindLabel(replay, r.aid),
      sortValue: (r) => summonKindLabel(replay, r.aid),
    },
    {
      key: "owner",
      label: t.colOwner,
      format: (r) => summonOwnerName(replay, r.aid),
      sortValue: (r) => summonOwnerName(replay, r.aid),
    },
    { key: "totalDealt", label: t.colDamageDealt, numeric: true, format: (r) => fmt(r.totalDealt) },
    { key: "hits", label: t.colHits, numeric: true, format: (r) => fmt(r.hits) },
    ...(crit
      ? [{ key: "crits", label: t.colCrits, numeric: true, format: (r: PlayerAgg) => fmt(r.crits) } as Column<PlayerAgg>]
      : []),
    { key: "misses", label: t.colMisses, numeric: true, format: (r) => fmt(r.misses) },
    ...(showMonstersHit
      ? [
          {
            key: "monstersHit",
            label: t.colMonstersHit,
            numeric: true,
            format: (r: PlayerAgg) => fmt(r.monstersHit),
          } as Column<PlayerAgg>,
        ]
      : []),
    { key: "kills", label: killsLabel, numeric: true, format: (r) => fmt(r.kills) },
  ];
  return (
    <DataTable
      cols={cols}
      rows={rows}
      options={{ initialSort: { key: "totalDealt", asc: false }, ...options }}
    />
  );
}
