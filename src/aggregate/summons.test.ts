import type { DamageEvent, Entity, Replay, SkillUse } from "rrfparser";
import { describe, expect, it } from "vitest";
import { findBossPhases, mergeBossPhases, NO_BOSS_PHASES } from "./bossPhases";
import {
  allyName,
  monstersWhoTookDamage,
  playersWhoDamaged,
  skillUsageByPlayer,
  summonsWhoDamaged,
} from "./index";

function ent(aid: number, kind: Entity["kind"], extra: Partial<Entity> = {}): Entity {
  return { aid, kind, view: 0, name: "", isBoss: false, level: 0, maxHp: 0, firstSeenMs: 0, lastHp: 0, ...extra };
}

function hit(time: number, source: number, target: number, damage: number, skillId = 0): DamageEvent {
  return {
    time,
    source,
    target,
    skillId,
    skillLevel: 1,
    damage,
    hits: 1,
    hitType: "normal",
    source_packet: skillId ? "skill" : "auto",
    rawAction: 0,
  } as DamageEvent;
}

function use(time: number, source: number, target: number, skillId: number): SkillUse {
  return { time, source, target, skillId, skillLevel: 1 };
}

function replayOf(entities: Entity[], rest: Partial<Replay> = {}): Replay {
  return {
    sessionInfo: { aid: entities[0]?.aid ?? 0, durationMs: 100_000 },
    entities: new Map(entities.map((e) => [e.aid, e])),
    damage: [],
    skillUses: [],
    skillCasts: [],
    kills: [],
    vanishes: [],
    mobHp: [],
    statusEvents: [],
    groundUnits: new Set(),
    ...rest,
  } as unknown as Replay;
}

const MOBS = new Map([
  [20835, "ABR Canhoneiro"],
  [20817, "Ardor"],
  [20994, "Betelgeuse"],
]);
const resolveMob = (view: number) => MOBS.get(view) ?? `mob#${view}`;

describe("summons", () => {
  const replay = replayOf(
    [
      ent(1, "pc", { name: "Dudazou" }),
      ent(2, "pc", { name: "Yiuiz.." }),
      ent(10, "abr", { view: 20835, name: "\x1cUZEB\x1c", ownerAid: 1 }),
      ent(11, "elem", { view: 20817, name: "Ardor", ownerAid: 2 }),
      ent(12, "homun", { view: 6051, name: "\x1cFIkB\x1c", ownerAid: 1 }),
      ent(13, "homun", { view: 6051, name: "Hoppet" }),
      ent(100, "mob", { view: 1002 }),
    ],
    {
      damage: [
        hit(1000, 1, 100, 500),
        hit(1100, 10, 100, 300),
        hit(1200, 11, 100, 200),
        // A summon healing another summon is not damage to a monster.
        hit(1300, 10, 10, 50),
      ],
    },
  );

  it("splits players from summons", () => {
    expect(playersWhoDamaged(replay).map((p) => p.aid)).toEqual([1]);
    expect(summonsWhoDamaged(replay).map((p) => p.aid)).toEqual([10, 11]);
    // The ABR's self-repair is not damage dealt.
    expect(summonsWhoDamaged(replay)[0]).toMatchObject({ totalDealt: 300, hits: 1 });
  });

  it("counts a summon as an attacker, and never as a monster", () => {
    const rows = monstersWhoTookDamage(replay);
    expect(rows.map((m) => m.aid)).toEqual([100]);
    expect(rows[0].attackers).toBe(3);
  });

  it("names a summon by species with its owner, a homunculus by the name it was given", () => {
    expect(allyName(replay, 10, resolveMob)).toBe("ABR Canhoneiro (Dudazou)");
    expect(allyName(replay, 11, resolveMob)).toBe("Ardor (Yiuiz..)");
    expect(allyName(replay, 12, resolveMob)).toBe("Dieter (Dudazou)");
    expect(allyName(replay, 13, resolveMob)).toBe("Hoppet");
    expect(allyName(replay, 1, resolveMob)).toBe("Dudazou");
  });
});

describe("skillUsageByPlayer", () => {
  const parentOf = (id: number) => (id === 5236 ? 5235 : id);

  it("counts one Flecha Escarlate cast once, not once per packet", () => {
    // What the server sends per cast: the skill-use, the arrow, the explosion.
    const replay = replayOf([ent(1, "pc", { name: "Vini" }), ent(100, "mob")], {
      skillUses: [use(39028, 1, 100, 5235), use(39497, 1, 100, 5235)],
      damage: [
        hit(39029, 1, 100, 226371, 5235),
        hit(39029, 1, 100, 673310, 5236),
        hit(39497, 1, 100, 226255, 5235),
        hit(39497, 1, 100, 750710, 5236),
      ],
    });
    const rows = skillUsageByPlayer(replay, {}, String, parentOf);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ skillId: 5235, count: 2 });
  });

  it("counts an AoE that hit several monsters in the same tick once", () => {
    const replay = replayOf([ent(1, "pc"), ent(100, "mob"), ent(101, "mob"), ent(102, "mob")], {
      damage: [hit(5000, 1, 100, 1, 2017), hit(5000, 1, 101, 1, 2017), hit(5001, 1, 102, 1, 2017)],
    });
    expect(skillUsageByPlayer(replay, {}, String)[0].count).toBe(1);
  });

  it("keeps auto-attacks tens of ms apart as separate uses", () => {
    const replay = replayOf([ent(1, "pc"), ent(100, "mob")], {
      damage: [hit(0, 1, 100, 1), hit(150, 1, 100, 1), hit(300, 1, 100, 1)],
    });
    expect(skillUsageByPlayer(replay, {}, String)[0].count).toBe(3);
  });
});

describe("mergeBossPhases", () => {
  const BETELGEUSE = 20994;
  const boss = (aid: number, firstSeenMs: number, view = BETELGEUSE) =>
    ent(aid, "mob", { view, isBoss: true, firstSeenMs, maxHp: -1 });

  it("does not chain monsters that are not groupable", () => {
    // Naght Sieger's Espinho: boss-flagged, one after another, rarely killed.
    const adds = replayOf([ent(1, "pc"), boss(101, 0, 20581), boss(102, 5000, 20581), boss(103, 9000, 20581)], {
      damage: [hit(1000, 1, 101, 10), hit(6000, 1, 102, 10), hit(10_000, 1, 103, 10)],
    });
    expect(findBossPhases(adds).aliases.size).toBe(0);
  });

  // The shape of the Betelgeuse recording: three AIDs, a teleport between each,
  // a death packet only for the last.
  const betel = replayOf([ent(1, "pc"), boss(47766, 8781), boss(52200, 29575), boss(55538, 55773)], {
    damage: [
      hit(9296, 1, 47766, 100),
      hit(18833, 1, 47766, 100),
      hit(30514, 1, 52200, 200),
      hit(45003, 1, 52200, 200),
      hit(56176, 1, 55538, 300),
      hit(79022, 1, 55538, 300),
    ],
    kills: [{ time: 79022, aid: 55538, kind: 1 }],
  });

  it("folds the phases into the first AID", () => {
    const phases = findBossPhases(betel);
    expect([...phases.aliases]).toEqual([
      [52200, 47766],
      [55538, 47766],
    ]);
    const merged = mergeBossPhases(betel, phases);
    const rows = monstersWhoTookDamage(merged);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ aid: 47766, totalReceived: 1200, hits: 6 });
    expect(rows[0].ttkMs).toBe(79022 - 9296);
    expect(merged.kills[0].aid).toBe(47766);
  });

  it("records when each later phase appeared", () => {
    expect([...findBossPhases(betel).phaseStarts]).toEqual([[47766, [29575, 55773]]]);
  });

  it("leaves the decoded replay alone", () => {
    mergeBossPhases(betel, findBossPhases(betel));
    expect(betel.damage[5].target).toBe(55538);
    expect(monstersWhoTookDamage(betel)).toHaveLength(3);
  });

  it("does not chain a boss that was killed to the next one of its kind", () => {
    const farm = replayOf([ent(1, "pc"), boss(101, 0), boss(102, 20_000)], {
      damage: [hit(1000, 1, 101, 10), hit(25_000, 1, 102, 10)],
      kills: [{ time: 1000, aid: 101, kind: 1 }],
    });
    expect(findBossPhases(farm).aliases.size).toBe(0);
  });

  it("does not chain two of the same boss fought at the same time", () => {
    const pair = replayOf([ent(1, "pc"), boss(101, 0), boss(102, 500)], {
      damage: [hit(1000, 1, 101, 10), hit(1100, 1, 102, 10), hit(2000, 1, 101, 10)],
    });
    expect(findBossPhases(pair).aliases.size).toBe(0);
  });

  it("does not chain a boss found long after the last one was left", () => {
    const later = replayOf([ent(1, "pc"), boss(101, 0), boss(102, 200_000)], {
      damage: [hit(1000, 1, 101, 10), hit(200_500, 1, 102, 10)],
    });
    expect(findBossPhases(later).aliases.size).toBe(0);
  });

  it("returns the same object when there is nothing to merge", () => {
    const plain = replayOf([ent(1, "pc"), ent(2, "mob", { view: 1002 })]);
    const phases = findBossPhases(plain);
    expect(phases).toBe(NO_BOSS_PHASES);
    expect(mergeBossPhases(plain, phases)).toBe(plain);
  });
});
