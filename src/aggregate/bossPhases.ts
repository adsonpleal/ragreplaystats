import type { Replay } from "rrfparser";

/**
 * Monsters that fight in phases, respawning under a new AID for each one — the
 * only species the explorer offers to group. Betelgeuse is three: 47766 → 52200
 * → 55538 in one recording, the same view id each time, with a teleport between
 * them and a death packet only for the last. Keyed by AID, that is three
 * monsters — three rows in "Por monstro", none with the whole fight's time to
 * kill, and every attacker's damage split three ways. Some people want exactly
 * that split, so grouping is a toggle (off by default), not a rewrite.
 *
 * A curated list rather than every MVP: fights are full of boss-flagged adds —
 * Naght Sieger's Espinho, Betelgeuse's Alma Morta — that spawn one after another
 * without dying, and chaining those would be wrong.
 */
export const GROUPABLE_MONSTERS: ReadonlySet<number> = new Set([
  20994, // Betelgeuse
]);

export type BossPhases = {
  /** Later-phase AID → the AID of the chain's first phase. */
  aliases: ReadonlyMap<number, number>;
  /** First-phase AID → when each later phase appeared (ms), in order. */
  phaseStarts: ReadonlyMap<number, readonly number[]>;
};

export const NO_BOSS_PHASES: BossPhases = { aliases: new Map(), phaseStarts: new Map() };

/**
 * Betelgeuse's transitions take ~11 s (last hit on one phase to the next
 * spawning). A minute leaves room for slower bosses without chaining a boss the
 * party walked away from to one found much later.
 */
const MAX_PHASE_GAP_MS = 60_000;

/**
 * Finds the phase chains of the groupable monsters. An instance continues the
 * previous one when:
 *   - both are unowned monsters of the same groupable species,
 *   - the previous one never died (a boss killed and found again is two fights),
 *   - it first shows up after the previous one's last event, and
 *   - no more than MAX_PHASE_GAP_MS after it.
 */
export function findBossPhases(replay: Replay): BossPhases {
  type Span = { aid: number; view: number; first: number; last: number; died: boolean };
  const spans = new Map<number, Span>();
  for (const [aid, ent] of replay.entities) {
    if (ent.kind !== "mob" || ent.ownerAid != null || !GROUPABLE_MONSTERS.has(ent.view)) continue;
    spans.set(aid, { aid, view: ent.view, first: ent.firstSeenMs, last: ent.firstSeenMs, died: false });
  }
  if (spans.size < 2) return NO_BOSS_PHASES;

  const touch = (aid: number, time: number) => {
    const s = spans.get(aid);
    if (!s) return;
    if (time < s.first) s.first = time;
    if (time > s.last) s.last = time;
  };
  for (const e of replay.damage) {
    touch(e.source, e.time);
    touch(e.target, e.time);
  }
  for (const e of replay.skillUses) {
    touch(e.source, e.time);
    touch(e.target, e.time);
  }
  for (const k of replay.kills) {
    const s = spans.get(k.aid);
    if (s) s.died = true;
  }

  const byView = new Map<number, Span[]>();
  for (const s of spans.values()) {
    let list = byView.get(s.view);
    if (!list) byView.set(s.view, (list = []));
    list.push(s);
  }

  const aliases = new Map<number, number>();
  const phaseStarts = new Map<number, number[]>();
  for (const list of byView.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.first - b.first);
    let root = list[0];
    let tail = list[0];
    for (const next of list.slice(1)) {
      const continues =
        !tail.died && next.first >= tail.last && next.first - tail.last <= MAX_PHASE_GAP_MS;
      if (continues) {
        aliases.set(next.aid, root.aid);
        let starts = phaseStarts.get(root.aid);
        if (!starts) phaseStarts.set(root.aid, (starts = []));
        starts.push(next.first);
      } else {
        root = next;
      }
      tail = next;
    }
  }
  return aliases.size ? { aliases, phaseStarts } : NO_BOSS_PHASES;
}

/**
 * Folds each phase chain into its first AID. Only the event lists the explorer
 * reads are rewritten, into a copy. The map viewer must keep the raw replay: it
 * places damage on the actor that took it, and the later phases spawn somewhere
 * else.
 */
export function mergeBossPhases(replay: Replay, phases: BossPhases): Replay {
  const { aliases } = phases;
  if (aliases.size === 0) return replay;

  const to = (aid: number) => aliases.get(aid) ?? aid;
  return {
    ...replay,
    damage: replay.damage.map((e) => ({ ...e, source: to(e.source), target: to(e.target) })),
    skillUses: replay.skillUses.map((e) => ({ ...e, source: to(e.source), target: to(e.target) })),
    skillCasts: replay.skillCasts.map((e) => ({ ...e, source: to(e.source), target: to(e.target) })),
    kills: replay.kills.map((e) => ({ ...e, aid: to(e.aid) })),
    vanishes: replay.vanishes.map((e) => ({ ...e, aid: to(e.aid) })),
    mobHp: replay.mobHp.map((e) => ({ ...e, aid: to(e.aid) })),
    statusEvents: replay.statusEvents.map((e) => ({ ...e, aid: to(e.aid) })),
  };
}
