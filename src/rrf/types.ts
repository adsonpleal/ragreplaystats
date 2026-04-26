export type EntityKind = "pc" | "mob" | "npc" | "merc" | "pet" | "homun" | "elem" | "unknown";

export type Entity = {
  aid: number;
  kind: EntityKind;
  /** Job id for PC, mob id for mob, sprite id for NPC. */
  view: number;
  name: string;
  isBoss: boolean;
  level: number;
  maxHp: number;
  /** First time we saw this entity (ms in session). */
  firstSeenMs: number;
  /** Last reported HP (mobs). */
  lastHp: number;
};

export type HitType = "normal" | "critical" | "double" | "lucky" | "miss";

export type DamageEvent = {
  /** ms in session */
  time: number;
  source: number;
  target: number;
  /** 0 means auto-attack. */
  skillId: number;
  skillLevel: number;
  damage: number;
  /** Hit count for multi-hit skills (count) */
  hits: number;
  hitType: HitType;
  /** "auto" (0x02e1) or "skill" (0x01de) */
  source_packet: "auto" | "skill";
};

export type SkillCast = {
  time: number;
  source: number;
  target: number;
  skillId: number;
  castMs: number;
};

export type SkillUse = {
  time: number;
  source: number;
  target: number;
  skillId: number;
  skillLevel: number;
};

export type VanishEvent = {
  time: number;
  aid: number;
  /** 0 = out of sight, 1 = died, 2 = logged out, 3 = teleported */
  kind: number;
};

export type MobHpUpdate = {
  time: number;
  aid: number;
  hp: number;
  maxHp: number;
};

export type MapChange = {
  time: number;
  map: string;
};

export type SessionInfo = {
  player: string;
  map: string;
  recordedAt: Date;
  durationMs: number;
  aid: number;
};

export type Replay = {
  sessionInfo: SessionInfo;
  entities: Map<number, Entity>;
  damage: DamageEvent[];
  kills: VanishEvent[];
  skillCasts: SkillCast[];
  skillUses: SkillUse[];
  mobHp: MobHpUpdate[];
  mapChanges: MapChange[];
  totals: {
    packetCount: number;
    handledPackets: number;
    knownPacketIds: number[];
  };
};
