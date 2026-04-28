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
  /** Raw `e_damage_type` byte from the packet — for debugging. */
  rawAction: number;
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

export type ItemDeleteEvent = {
  time: number;
  /** Inventory slot. */
  slot: number;
  amount: number;
  /** Server reason byte (0=normal/dropped, 6=consumed, etc.). Mapped to a label by the UI. */
  reason: number;
  /** Resolved at decode time from the running inventory map; 0 if unknown. */
  itemId: number;
};

export type ItemAddEvent = {
  time: number;
  slot: number;
  itemId: number;
  amount: number;
  refine: number;
};

export type ParamChangeEvent = {
  time: number;
  /** Parameter type — 1=base exp, 2=job exp, 5=hp, 7=sp, 11=base lvl, 12=job lvl, 20=zeny, 22=next base exp, 23=next job exp. */
  type: number;
  /** Always stored as bigint so 64-bit values from 0x0b1b survive without precision loss. */
  value: bigint;
};

export type StatusEvent = {
  time: number;
  statusId: number;
  /** Entity the status was applied to. */
  aid: number;
  /** True when the buff/debuff starts; false when it ends. */
  isOn: boolean;
  /** Total duration in ms (0x043f / 0x0983 only; 0 otherwise). */
  totalMs: number;
  /** Remaining duration in ms (0x043f / 0x0983 only; 0 otherwise). */
  leftMs: number;
};

export type SessionInfo = {
  player: string;
  map: string;
  recordedAt: Date;
  durationMs: number;
  aid: number;
};

/**
 * The recording's local player chat (0x008e ZC_NOTIFY_PLAYERCHAT). Source is
 * always the session player; we don't carry the AID on the event itself.
 */
export type ChatEvent = {
  time: number;
  message: string;
};

export type InventoryRecord = {
  itemId: number;
  qty: number;
  /**
   * `equipLocation` bitmask from the spawn record. 0 = not equipped.
   * Bits follow rAthena's `e_equip_pos` (1 head-low, 2 weapon, 4 garment,
   * 16 armor, 32 shield, 64 shoes, etc.).
   */
  equipped: number;
  refine: number;
  /** Up to 4 card item ids. 0 = empty slot. */
  cards: [number, number, number, number];
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
  initialInventory: Map<number, InventoryRecord>;
  itemDeletes: ItemDeleteEvent[];
  itemAdds: ItemAddEvent[];
  paramChanges: ParamChangeEvent[];
  statusEvents: StatusEvent[];
  chats: ChatEvent[];
  totals: {
    packetCount: number;
    handledPackets: number;
    knownPacketIds: number[];
  };
};
