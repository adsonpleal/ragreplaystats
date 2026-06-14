// XLSX export — the same numbers the Estatísticas / Por jogador / Por monstro /
// Análise de DPS tabs show, written to a multi-sheet workbook with formatting
// (bold/coloured headers, frozen header rows, thousands-separated numbers, and
// sized columns). One sheet per logical table so each opens clean in Excel.
//
// Uses `write-excel-file` (browser build), which is small and produces a Blob
// without any server round-trip.

import writeXlsxFile, { type Row, type CellObject } from "write-excel-file/browser";
import {
  computeResumo,
  consumablesByItem,
  killsByPlayerAndMob,
  lootByItem,
  monstersWhoTookDamage,
  playersWhoDamaged,
  skillUsageByPlayer,
} from "../aggregate/index.js";
import { t, locale } from "../i18n.js";
import type { ReferenceDb } from "../db/loader.js";
import type { Replay } from "../rrf/types.js";

type SheetSpec = {
  data: Row[];
  sheet: string;
  columns?: { width: number }[];
  stickyRowsCount?: number;
};

const HEADER_BG = "#C5462A";
const HEADER_FG = "#FFFFFF";
const NUM_FORMAT = "#,##0";

function header(label: string, align: "left" | "right" = "left"): CellObject {
  return {
    value: label,
    type: String,
    fontWeight: "bold",
    backgroundColor: HEADER_BG,
    textColor: HEADER_FG,
    align,
  };
}

function str(value: string): CellObject {
  return { value: value ?? "", type: String };
}

function num(value: number): CellObject {
  return { value, type: Number, format: NUM_FORMAT, align: "right" };
}

function fieldLabel(label: string): CellObject {
  return { value: label, type: String, fontWeight: "bold" };
}

function fmtDuration(ms: number | null): string {
  if (ms == null || !ms) return t.none;
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Mirror the UI's preference for the DB species name over the per-instance label. */
function mobDisplay(
  row: { view: number; aid: number; name: string },
  resolveMob: (id: number) => string,
): string {
  const dbName = row.view ? resolveMob(row.view) : "";
  if (dbName && !dbName.startsWith("mob#")) return dbName;
  return row.name || resolveMob(row.view || row.aid);
}

// Excel worksheet names must be ≤31 chars and exclude : \ / ? * [ ]. Sanitize
// defensively so a long/odd localized name can never abort the whole export.
function safeSheetName(name: string): string {
  return name.replace(/[:\\/?*[\]]/g, " ").trim().slice(0, 31) || "Sheet";
}

/** Build a sheet of one key/value table (2 columns, header + bold field names). */
function keyValueSheet(
  name: string,
  pairs: [string, CellObject][],
): SheetSpec {
  const data: Row[] = [[header(t.exportXlsxFieldCol), header(t.exportXlsxValueCol)]];
  for (const [label, valueCell] of pairs) data.push([fieldLabel(label), valueCell]);
  return {
    sheet: safeSheetName(name),
    data,
    columns: [{ width: 28 }, { width: 26 }],
    stickyRowsCount: 1,
  };
}

/** Build a sheet of one tabular dataset (header row + data rows). */
function tableSheet(
  name: string,
  cols: { label: string; width: number; align?: "left" | "right" }[],
  rows: CellObject[][],
): SheetSpec {
  const data: Row[] = [cols.map((c) => header(c.label, c.align ?? "left"))];
  for (const r of rows) data.push(r);
  return {
    sheet: safeSheetName(name),
    data,
    columns: cols.map((c) => ({ width: c.width })),
    stickyRowsCount: 1,
  };
}

export async function buildReplayXlsxBlob(
  replay: Replay,
  db: ReferenceDb | null,
): Promise<Blob> {
  const resolveSkill = (id: number) =>
    id === 0 ? t.autoAttack : db?.resolveSkill(id) ?? t.skillFallback(id);
  const resolveMob = (id: number) => db?.resolveMob(id) ?? t.mobFallback(id);
  const resolveItem = (id: number) => db?.resolveItem(id) ?? t.itemFallback(id);

  const sheets: SheetSpec[] = [];

  // --- Sessão -------------------------------------------------------------
  const totalDmg = replay.damage.reduce((s, e) => s + e.damage, 0);
  const seconds = replay.sessionInfo.durationMs / 1000;
  const avgDps = seconds > 0 ? Math.round(totalDmg / seconds) : 0;
  sheets.push(
    keyValueSheet(t.exportSheetSession, [
      [t.player, str(replay.sessionInfo.player || t.none)],
      [t.map, str(replay.sessionInfo.map || t.none)],
      [t.recordedAt, str(replay.sessionInfo.recordedAt.toLocaleString(locale))],
      [t.duration, str(fmtDuration(replay.sessionInfo.durationMs))],
      [t.totalDamage, num(totalDmg)],
      [t.avgDps, num(avgDps)],
      [t.damageEvents, num(replay.damage.length)],
      [t.kills, num(replay.kills.length)],
      [t.entitiesSeen, num(replay.entities.size)],
    ]),
  );

  // --- Resumo (Estatísticas) ---------------------------------------------
  const r = computeResumo(replay, null);
  sheets.push(
    keyValueSheet(t.exportSheetSummary, [
      [t.cellTotalDealt, num(r.totalDealt)],
      [t.cellTotalTaken, num(r.totalTaken)],
      [t.cellEffectiveDps, num(r.effectiveDps)],
      [t.cellHits, num(r.hitsLanded)],
      [t.cellCrits, num(r.crits)],
      [t.cellMisses, num(r.hitsMissed)],
      [t.cellHighestHit, r.highestHit ? num(r.highestHit.damage) : str(t.none)],
      [
        t.cellMostUsedSkill,
        str(r.mostUsedSkillId ? resolveSkill(r.mostUsedSkillId) : t.none),
      ],
      [t.cellKills, num(r.kills)],
      [t.cellBossKills, num(r.bossKills)],
      [t.cellTtfk, str(fmtDuration(r.timeToFirstKillMs))],
      [t.cellAvgKillInterval, str(fmtDuration(r.avgKillIntervalMs))],
      [
        t.cellTopSpecies,
        str(r.topKilledSpecies ? resolveMob(r.topKilledSpecies.view) : t.none),
      ],
      [t.cellLevelsGained, num(r.baseLevelsGained)],
      [t.cellJobLevelsGained, num(r.jobLevelsGained)],
      [t.cellZenyDelta, num(r.zenyDelta)],
      [t.cellMapsVisited, num(r.mapsVisited)],
      [t.cellDeaths, num(r.deaths)],
    ]),
  );

  // --- Por jogador --------------------------------------------------------
  sheets.push(
    tableSheet(
      t.exportSheetByPlayer,
      [
        { label: t.colPlayer, width: 22 },
        { label: t.colDamageDealt, width: 16, align: "right" },
        { label: t.colHits, width: 10, align: "right" },
        { label: t.colCrits, width: 10, align: "right" },
        { label: t.colMisses, width: 10, align: "right" },
        { label: t.colMonstersHit, width: 12, align: "right" },
        { label: t.colKills, width: 10, align: "right" },
      ],
      playersWhoDamaged(replay).map((p) => [
        str(p.name),
        num(p.totalDealt),
        num(p.hits),
        num(p.crits),
        num(p.misses),
        num(p.monstersHit),
        num(p.kills),
      ]),
    ),
  );

  // --- Por monstro --------------------------------------------------------
  sheets.push(
    tableSheet(
      t.exportSheetByMonster,
      [
        { label: t.colMonster, width: 24 },
        { label: t.colMobId, width: 10, align: "right" },
        { label: t.cellBoss, width: 8 },
        { label: t.colMaxHp, width: 14, align: "right" },
        { label: t.colDamageTaken, width: 16, align: "right" },
        { label: t.colHits, width: 10, align: "right" },
        { label: t.colAttackers, width: 11, align: "right" },
        { label: t.colTtk, width: 14, align: "right" },
      ],
      monstersWhoTookDamage(replay).map((m) => [
        str(mobDisplay(m, resolveMob)),
        num(m.view || m.aid),
        str(m.isBoss ? t.cellBoss : ""),
        m.maxHp > 0 ? num(m.maxHp) : str(""),
        num(m.totalReceived),
        num(m.hits),
        num(m.attackers),
        str(fmtDuration(m.ttkMs)),
      ]),
    ),
  );

  // --- Habilidades mais usadas (por jogador) -----------------------------
  sheets.push(
    tableSheet(
      t.exportSheetSkills,
      [
        { label: t.colPlayer, width: 22 },
        { label: t.colSkill, width: 26 },
        { label: t.colId, width: 8, align: "right" },
        { label: t.exportXlsxUsesCol, width: 10, align: "right" },
      ],
      skillUsageByPlayer(replay, {}, resolveSkill).map((s) => [
        str(s.playerName),
        str(s.skillName),
        num(s.skillId),
        num(s.count),
      ]),
    ),
  );

  // --- Abates -------------------------------------------------------------
  sheets.push(
    tableSheet(
      t.exportSheetKills,
      [
        { label: t.colPlayer, width: 22 },
        { label: t.colMonster, width: 24 },
        { label: t.colKills, width: 10, align: "right" },
      ],
      killsByPlayerAndMob(replay, {}, resolveMob).map((k) => [
        str(k.playerName),
        str(k.monsterName),
        num(k.count),
      ]),
    ),
  );

  // --- Itens consumidos / recebidos --------------------------------------
  const itemCols = [
    { label: t.exportXlsxItemCol, width: 28 },
    { label: t.colId, width: 10, align: "right" as const },
    { label: t.colHits, width: 10, align: "right" as const },
    { label: t.exportXlsxQuantityCol, width: 12, align: "right" as const },
  ];
  const consumed = consumablesByItem(replay, null, resolveItem);
  if (consumed.length) {
    sheets.push(
      tableSheet(
        t.exportSheetConsumed,
        itemCols,
        consumed.map((it) => [
          str(it.name),
          it.itemId ? num(it.itemId) : str(""),
          num(it.count),
          num(it.quantity),
        ]),
      ),
    );
  }
  const loot = lootByItem(replay, null, resolveItem);
  if (loot.length) {
    sheets.push(
      tableSheet(
        t.exportSheetLoot,
        itemCols,
        loot.map((it) => [
          str(it.name),
          it.itemId ? num(it.itemId) : str(""),
          num(it.count),
          num(it.quantity),
        ]),
      ),
    );
  }

  return writeXlsxFile(sheets as never).toBlob();
}
