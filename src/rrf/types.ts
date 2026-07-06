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
  /** 0 = female, 1 = male; undefined = unknown. From spawn packets, with the
   *  local player falling back to the session snapshot. */
  sex?: number;
  /**
   * Appearance for the paper-doll viewer (local player only, from the Session
   * container; undefined elsewhere). `hairStyle` is a sprite id; `hairColor` /
   * `clothesColor` are palette indices (undefined = default/standard palette).
   */
  hairStyle?: number;
  hairColor?: number;
  clothesColor?: number;
  /**
   * Other-player worn gear as client sprite VIEW/look ids straight from the
   * spawn packet (0/undefined = none). The map viewer's billboard hands these
   * to the ragassets URL builder directly — no item→view lookup, unlike the
   * local player whose gear is derived from the inventory snapshot. Absent for
   * mobs/NPCs and the local player.
   */
  weaponView?: number;
  shieldView?: number;
  headTopView?: number;
  headMidView?: number;
  headLowView?: number;
  robeView?: number;
  /** OPTION/effectState bitmask from the spawn packet — carries mount flags
   *  (Peco, Mado Gear, Dragon, Warg). Undefined for entities we never saw a
   *  spawn packet for. */
  option?: number;
};

/**
 * A single random option ("Bônus Aleatório") on an equipped item. `id` indexes
 * the client's option-name table (public/db/randomopt.json) whose template is
 * filled with `value` for display, e.g. id 19 + value 7 → "ATQM +7". `param` is
 * a secondary byte (element/race for a few options; 0 for most).
 */
export type RandomOption = { id: number; value: number; param: number };

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

/** A ground-skill unit placement (0x09ca) with its cell, plus the skill it most
 *  likely belongs to (correlated from the caster's latest skill use/cast — the
 *  packet itself only carries the unit graphic, not the skill id). Drives the map
 *  viewer's ground effects (Storm Gust, Arrow Storm, Pneuma, …). skillId is 0 when
 *  no recent skill could be attributed. */
export type GroundSkillUnit = {
  time: number;
  unitAid: number;
  casterAid: number;
  gx: number;
  gy: number;
  skillId: number;
};

export type VanishEvent = {
  time: number;
  aid: number;
  /** 0 = out of sight, 1 = died, 2 = logged out, 3 = teleported */
  kind: number;
};

/** An entity's OPTION/effectState bitmask changed mid-recording (ZC_STATE_CHANGE3
 *  0x0229). Carries mounts/summons (Falcon, Warg) AND visibility (cloakonnpc /
 *  hideonnpc set OPTION_HIDE/CLOAK to make a script NPC vanish and reappear). */
export type OptionChangeEvent = {
  time: number;
  aid: number;
  option: number;
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
  /** Local player's cell after the map change (from the packet). 0,0 when the
   *  recording's variant of the packet doesn't carry coords. */
  gx: number;
  gy: number;
};

/** A walk command observed for an entity: the server told it to walk from
 *  `from` to `to`, starting at the server clock `startTime`. We only use
 *  client-clock `time` for playback; `startTime` is carried for completeness. */
export type MoveEvent = {
  time: number;
  aid: number;
  from: { gx: number; gy: number };
  to: { gx: number; gy: number };
  startTime: number;
};

/** A forced position snap (spawn position, ZC_STOPMOVE, or post-knockback
 *  fix-pos). The entity teleports to the cell immediately at `time`. */
export type FixPosEvent = {
  time: number;
  aid: number;
  gx: number;
  gy: number;
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

/**
 * A worn/removed equipment change for the local player, decoded from the
 * equip/take-off ack packets (0x0999 / 0x099a). The packet only carries the
 * inventory slot + equip location; `itemId`/`refine`/`cards` are resolved at
 * decode time from the running inventory snapshot (0 / empty if unknown).
 */
export type EquipChangeEvent = {
  time: number;
  /** Inventory slot the item lives in (raw index - 2). */
  slot: number;
  /** `equipLocation` bitmask the item was worn at / removed from. */
  location: number;
  /** True = item was put on; false = item was taken off. */
  equipped: boolean;
  itemId: number;
  refine: number;
  cards: number[];
  /** Random options ("Bônus Aleatórios") resolved from the inventory snapshot. */
  options: RandomOption[];
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
  /**
   * Random options ("Bônus Aleatórios") — present on newer (221-byte) equip
   * records; empty for older snapshots or non-equipment.
   */
  options: RandomOption[];
};

export type Replay = {
  sessionInfo: SessionInfo;
  entities: Map<number, Entity>;
  damage: DamageEvent[];
  /** Deaths only (vanish kind 1) — drives kill counts / attribution stats. */
  kills: VanishEvent[];
  /** EVERY vanish (died / out-of-sight / logged-out / teleported), for the map
   *  viewer to despawn an entity when it leaves — `kills` alone would leave mobs
   *  that walked off-screen or teleported visible forever. */
  vanishes: VanishEvent[];
  /** OPTION/effectState changes over time (mounts, summons, NPC cloak/hide). */
  optionChanges: OptionChangeEvent[];
  skillCasts: SkillCast[];
  skillUses: SkillUse[];
  mobHp: MobHpUpdate[];
  mapChanges: MapChange[];
  /** Every walk command (0x0086/0x0087 and the spawn's MoveData). Drives the
   *  map viewer's entity movement playback. */
  moves: MoveEvent[];
  /** Every forced position snap (spawn PosDir + 0x0088 fix-pos). Lets the
   *  viewer place an entity at its initial cell before the first walk lands. */
  positions: FixPosEvent[];
  initialInventory: Map<number, InventoryRecord>;
  itemDeletes: ItemDeleteEvent[];
  itemAdds: ItemAddEvent[];
  equipChanges: EquipChangeEvent[];
  paramChanges: ParamChangeEvent[];
  statusEvents: StatusEvent[];
  chats: ChatEvent[];
  /**
   * AIDs that arrived via 0x09ca (ground-skill-unit placements). These are
   * the AoE skill's own ground markers — Storm Gust, Arrow Shower, etc. —
   * which the server uses as a placeholder target/source for per-tick
   * damage. Excluded from monster aggregations even when missing from
   * `entities`.
   */
  groundUnits: Set<number>;
  /** Ground-skill-unit placements with cells + attributed skill id, in packet
   *  order. Drives the map viewer's ground effects. */
  groundSkillUnits: GroundSkillUnit[];
  totals: {
    packetCount: number;
    handledPackets: number;
    knownPacketIds: number[];
  };
};
