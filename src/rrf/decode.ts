import {
  type AnyContainer,
  ContainerType,
  type GenericContainer,
  type PacketStreamContainer,
  readContainers,
} from "./containers.js";
import { deriveKeys } from "./crypt.js";
import { readHeader } from "./header.js";
import { decodePacket } from "./packets/index.js";
import { readKoreanZ } from "./reader.js";
import type {
  ChatEvent,
  DamageEvent,
  Entity,
  EntityKind,
  EquipChangeEvent,
  FixPosEvent,
  InventoryRecord,
  ItemAddEvent,
  ItemDeleteEvent,
  MapChange,
  MobHpUpdate,
  MoveEvent,
  OptionChangeEvent,
  ParamChangeEvent,
  RandomOption,
  GroundSkillUnit,
  Replay,
  SkillCast,
  SkillUse,
  StatusEvent,
  VanishEvent,
} from "./types.js";

export function inspectEntityPackets(buf: ArrayBuffer, max = 6) {
  const header = readHeader(buf);
  const keys = deriveKeys(header.recordedAt);
  const containers = readContainers(buf, header.containerTableOffset, keys);
  const ps = containers.find(
    (c): c is PacketStreamContainer => c.kind === "packetStream",
  );
  const entries: Array<{ packetId: string; len: number; hex: string; tail: string }> = [];
  if (!ps) return entries;
  for (const chunk of ps.chunks) {
    if (
      chunk.packetId === 0x09fd ||
      chunk.packetId === 0x09fe ||
      chunk.packetId === 0x09ff ||
      chunk.packetId === 0x0915
    ) {
      entries.push({
        packetId: chunk.packetId.toString(16),
        len: chunk.data.length,
        hex: Array.from(chunk.data)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(" "),
        tail: "",
      });
      if (entries.length >= max) break;
    }
  }
  return entries;
}

export function inspectPacketStream(buf: ArrayBuffer) {
  const header = readHeader(buf);
  const keys = deriveKeys(header.recordedAt);
  const containers = readContainers(buf, header.containerTableOffset, keys);
  const ps = containers.find(
    (c): c is PacketStreamContainer => c.kind === "packetStream",
  );
  if (!ps) return [];
  return ps.chunks.map((ch) => ({
    time: ch.time,
    id: ch.packetId,
    len: ch.length,
    hex: Array.from(ch.data)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" "),
  }));
}

export function inspectContainers(buf: ArrayBuffer) {
  const header = readHeader(buf);
  const keys = deriveKeys(header.recordedAt);
  const containers = readContainers(buf, header.containerTableOffset, keys);
  return containers.map((c, i) => ({
    index: i,
    type: c.type,
    kind: c.kind,
    declaredLength: c.declaredLength,
    realLength: c.realLength,
    offset: c.offset,
    chunkCount: c.chunks.length,
    chunkPreview: c.chunks.map((ch) => ({
      id: (ch as { id: number }).id,
      length: (ch as { length: number }).length,
      first16: Array.from((ch as { data: Uint8Array }).data)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" "),
    })),
  }));
}

export function decodeReplay(buf: ArrayBuffer): Replay {
  const header = readHeader(buf);
  const keys = deriveKeys(header.recordedAt);
  const containers = readContainers(buf, header.containerTableOffset, keys);

  const recordedAt = new Date(
    header.recordedAt.year,
    header.recordedAt.month - 1,
    header.recordedAt.day,
    header.recordedAt.hour,
    header.recordedAt.minute,
    header.recordedAt.second,
  );

  const session = extractSessionInfo(containers, recordedAt);

  const entities = new Map<number, Entity>();
  if (session.aid > 0) {
    entities.set(session.aid, {
      aid: session.aid,
      kind: "pc",
      view: session.job,
      name: session.player,
      isBoss: false,
      level: session.baseLevel,
      maxHp: 0,
      firstSeenMs: 0,
      lastHp: 0,
      sex: session.sex === 0 || session.sex === 1 ? session.sex : undefined,
      hairStyle: session.hairStyle || undefined,
      hairColor: session.hairColor || undefined,
      clothesColor: session.clothesColor || undefined,
    });
  }
  const damage: DamageEvent[] = [];
  const kills: VanishEvent[] = [];
  const vanishes: VanishEvent[] = [];
  const optionChanges: OptionChangeEvent[] = [];
  const skillCasts: SkillCast[] = [];
  const skillUses: SkillUse[] = [];
  const mobHp: MobHpUpdate[] = [];
  const mapChanges: MapChange[] = [];
  const itemDeletes: ItemDeleteEvent[] = [];
  const itemAdds: ItemAddEvent[] = [];
  const equipChanges: EquipChangeEvent[] = [];
  const paramChanges: ParamChangeEvent[] = [];
  const statusEvents: StatusEvent[] = [];
  const chats: ChatEvent[] = [];
  const moves: MoveEvent[] = [];
  const positions: FixPosEvent[] = [];
  // Seed the local player's recording-start cell from the ReplayData container.
  // The client never self-spawns via an entity packet, so without this the map
  // viewer would have nothing to place the player on at t=0 (recordings that
  // start mid-map — no 0x0091 either — leave the player invisible).
  if (session.aid && (session.gx || session.gy)) {
    positions.push({ time: 0, aid: session.aid, gx: session.gx, gy: session.gy });
  }
  // Seed the local player's OPTION at t=0 from the Session snapshot so any
  // mount/summon they already had (falcon, warg, mado gear) is present from the
  // first frame — the packet stream often doesn't re-broadcast their 0x0229
  // until seconds in, which otherwise left companions popping in late.
  if (session.aid) {
    optionChanges.push({ time: 0, aid: session.aid, option: session.option });
  }
  const knownPacketIdSet = new Set<number>();
  // Map from ground-skill-unit AID → caster AID. Skills like Onda Psíquica
  // (Psychic Wave), Storm Gust, Comet, etc. spawn a "skill unit" entity that
  // deals the damage in subsequent ticks; the damage packets list the unit's
  // AID as the source. We rewrite source back to the caster when we see one.
  const groundUnitOwner = new Map<number, number>();
  const groundUnits = new Set<number>();
  // Ground-skill-unit placements (0x09ca) with their cell + the skill they belong
  // to. The packet only carries the unit graphic, not the skill id, so we
  // attribute it from the caster's most recent skill use/cast (the AoE's own
  // activation packet, sent just before its units) — see lastSkillByCaster.
  const groundSkillUnits: GroundSkillUnit[] = [];
  const lastSkillByCaster = new Map<number, { skillId: number; time: number }>();
  // Widest cast we care to bridge (a long channel like Storm Gust) — beyond this
  // the "last skill" is too stale to trust as this unit's source.
  const GROUND_SKILL_ATTR_MS = 6000;

  // Initial inventory snapshot from the Items container — used to resolve
  // `itemId` for slots when 0x07fa fires later. Mutated as 0x0a37 / 0x07fa
  // packets stream in.
  const initialInventory = readItemsContainer(containers);
  // Copy the records, not just the map: the running inventory mutates `qty`
  // (itemDelete) and `equipped` (equipChange), and those records are shared by
  // reference with `initialInventory` — without a per-record copy those edits
  // would retroactively corrupt the start-of-recording snapshot.
  const inventory = new Map<number, InventoryRecord>(
    [...initialInventory].map(([slot, rec]) => [slot, { ...rec }]),
  );

  let packetCount = 0;
  let handledPackets = 0;
  let earliestTime = Number.POSITIVE_INFINITY;
  let latestTime = Number.NEGATIVE_INFINITY;

  // Process initial packets first (treat as t=0).
  const initialContainer = containers.find(
    (c): c is GenericContainer =>
      c.kind === "generic" && c.type === ContainerType.InitialPackets,
  );
  if (initialContainer) {
    for (const chunk of initialContainer.chunks) {
      handlePacket(chunk.data, 0);
    }
  }

  // Container 15 holds 0x0857 spawn snapshots for entities that were
  // already in view when the recording started — without these, dummies
  // attacked from the recording's first frame have no entity row and
  // render as "Alvo desconhecido".
  const initialEntitiesContainer = containers.find(
    (c): c is GenericContainer =>
      c.kind === "generic" && c.type === ContainerType.InitialEntities,
  );
  if (initialEntitiesContainer) {
    for (const chunk of initialEntitiesContainer.chunks) {
      handlePacket(chunk.data, 0);
    }
  }

  // Persistent buffs active at recording start (food, EXP/drop boosts, etc.)
  // live in the EfstList container, NOT the packet stream — they never generate
  // a status-change packet during the recording. Seed each as a synthetic
  // "on" status event at t=0 for the local player so the buff strip shows them.
  const efstListContainer = containers.find(
    (c): c is GenericContainer =>
      c.kind === "generic" && c.type === ContainerType.EfstList,
  );
  if (efstListContainer && session.aid) {
    for (const chunk of efstListContainer.chunks) {
      // Each record is 28 bytes; the first u32 (LE) is the EFST id. Empty
      // begin/end markers (len 0) and any short chunk are skipped.
      if (chunk.data.length < 4) continue;
      const efst = chunk.data[0] | (chunk.data[1] << 8) | (chunk.data[2] << 16) | (chunk.data[3] << 24);
      if (efst <= 0 || efst > 3000) continue; // guard against non-record chunks
      statusEvents.push({ time: 0, statusId: efst, aid: session.aid, isOn: true, totalMs: 0, leftMs: 0 });
    }
  }

  const packetStream = containers.find(
    (c): c is PacketStreamContainer => c.kind === "packetStream",
  );
  if (packetStream) {
    for (const chunk of packetStream.chunks) {
      packetCount++;
      knownPacketIdSet.add(chunk.packetId);
      const t = chunk.time;
      if (t < earliestTime) earliestTime = t;
      if (t > latestTime) latestTime = t;
      handlePacket(chunk.data, t);
    }
  }

  function ensureEntity(aid: number, kind: EntityKind, time: number): Entity {
    let e = entities.get(aid);
    if (!e) {
      e = {
        aid,
        kind,
        view: 0,
        name: "",
        isBoss: false,
        level: 0,
        maxHp: 0,
        firstSeenMs: time,
        lastHp: 0,
      };
      entities.set(aid, e);
    }
    return e;
  }

  function handlePacket(raw: Uint8Array, time: number) {
    const decoded = decodePacket(raw, time);
    if (!decoded) return;
    handledPackets++;

    switch (decoded.type) {
      case "entity": {
        const ep = decoded.data;
        const e = ensureEntity(ep.aid, ep.kind, time);
        if (ep.kind !== "unknown") e.kind = ep.kind;
        if (ep.view) e.view = ep.view;
        if (ep.name) e.name = ep.name;
        if (ep.level) e.level = ep.level;
        if (ep.maxHp) e.maxHp = ep.maxHp;
        if (ep.hp) e.lastHp = ep.hp;
        if (ep.isBoss) e.isBoss = true;
        // Documented sex field (spawn packets only); authoritative over the
        // session-snapshot fallback used to seed the local player.
        if (ep.sex === 0 || ep.sex === 1) e.sex = ep.sex;
        // Appearance for remote players — the spawn packet's view/look ids feed
        // the map viewer's billboard directly. Only stamp for PCs (mob/NPC
        // spawns reuse the struct but leave these zeroed/garbage).
        if (ep.look && e.kind === "pc") {
          e.hairStyle = ep.look.hairStyle;
          e.hairColor = ep.look.hairColor;
          e.clothesColor = ep.look.clothesColor;
          e.weaponView = ep.look.weapon;
          e.shieldView = ep.look.shield;
          e.headTopView = ep.look.headTop;
          e.headMidView = ep.look.headMid;
          e.headLowView = ep.look.headLow;
          e.robeView = ep.look.robe;
        }
        // Spawn-time OPTION for EVERY kind — the map viewer needs it to know a
        // script NPC starts cloaked (tr_box spawns hidden, shows only at the
        // end), and it seeds the option timeline for mounts/summons. The server
        // re-sends the full spawn (0x09ff) periodically carrying the CURRENT
        // cloak state, so each spawn is also an option-timeline entry (the
        // initial snapshot lands at t=0) — a single `e.option` would only hold
        // the LAST value and miss when the NPC was hidden.
        e.option = ep.option;
        optionChanges.push({ time, aid: ep.aid, option: ep.option });
        // Spawn position → synthetic fix-pos so the map viewer can place the
        // entity at its initial cell before any walk lands. A walking spawn
        // also queues the in-flight step as a move event.
        if (ep.pos) positions.push({ time, aid: ep.aid, gx: ep.pos.gx, gy: ep.pos.gy });
        if (ep.walk) moves.push({ time, aid: ep.aid, from: ep.walk.from, to: ep.walk.to, startTime: 0 });
        break;
      }
      case "moveOther":
        moves.push(decoded.data);
        break;
      case "moveSelfRaw": {
        if (session.aid) {
          const m = decoded.data;
          moves.push({ time: m.time, aid: session.aid, from: m.from, to: m.to, startTime: m.startTime });
        }
        break;
      }
      case "fixPos":
        positions.push(decoded.data);
        break;
      case "vanish":
        // Every vanish drives the map viewer's despawn; only deaths (kind 1)
        // count toward kill stats.
        vanishes.push(decoded.data);
        if (decoded.data.kind === 1) kills.push(decoded.data);
        break;
      case "option":
        optionChanges.push(decoded.data);
        break;
      case "mobHp": {
        const ev = decoded.data;
        mobHp.push(ev);
        const e = entities.get(ev.aid);
        if (e) {
          e.lastHp = ev.hp;
          if (ev.maxHp) e.maxHp = ev.maxHp;
        }
        break;
      }
      case "damage": {
        const d = decoded.data;
        // Skip skill-cast marker packets — the server emits an action=6
        // (DMG_SINGLE) damage=0 packet right before the real splash-damage
        // event (action=5) for the same target. The marker is animation
        // metadata, not a miss.
        if (d.skillId !== 0 && d.damage === 0 && d.rawAction === 6) break;
        // Reattribute ground-skill-unit damage back to the caster.
        const owner = groundUnitOwner.get(d.source);
        if (owner) d.source = owner;
        damage.push(d);
        break;
      }
      case "skillUse": {
        const u = decoded.data;
        const owner = groundUnitOwner.get(u.source);
        if (owner) u.source = owner;
        skillUses.push(u);
        lastSkillByCaster.set(u.source, { skillId: u.skillId, time: u.time });
        break;
      }
      case "skillCast": {
        const c = decoded.data;
        const owner = groundUnitOwner.get(c.source);
        if (owner) c.source = owner;
        skillCasts.push(c);
        lastSkillByCaster.set(c.source, { skillId: c.skillId, time: c.time });
        break;
      }
      case "groundSkillEntry": {
        const ev = decoded.data;
        if (ev.unitAid && ev.casterAid) {
          groundUnitOwner.set(ev.unitAid, ev.casterAid);
        }
        if (ev.unitAid) groundUnits.add(ev.unitAid);
        // Attribute the unit to the caster's most recent skill (its activation
        // packet fires just before its units) so the viewer can pick the right
        // ground effect; 0 when nothing recent enough matched.
        const recent = lastSkillByCaster.get(ev.casterAid);
        const skillId = recent && ev.time - recent.time <= GROUND_SKILL_ATTR_MS ? recent.skillId : 0;
        groundSkillUnits.push({
          time: ev.time,
          unitAid: ev.unitAid,
          casterAid: ev.casterAid,
          gx: ev.gx,
          gy: ev.gy,
          skillId,
        });
        break;
      }
      case "chat":
        chats.push(decoded.data);
        break;
      case "mapChange": {
        const mc = decoded.data;
        mapChanges.push(mc);
        // The local player never self-spawns via an entity packet; the map-load
        // packet's (x,y) is the canonical source for their cell, so stamp it as
        // a synthetic position event so the map viewer can place them and
        // follow the camera there.
        if (session.aid && (mc.gx || mc.gy)) {
          positions.push({ time, aid: session.aid, gx: mc.gx, gy: mc.gy });
        }
        break;
      }
      case "itemDelete": {
        const ev = decoded.data;
        const inv = inventory.get(ev.slot);
        if (inv) {
          ev.itemId = inv.itemId;
          // Decrement the running count but DON'T drop the slot from the
          // map at qty=0. The equipped-items chunks (4601-4606) report
          // qty=1 even for ammo-style stacks whose real count lives in the
          // main-bag chunk; if we delete on the first decrement we lose
          // the itemId for the next 13 ammo consumes. The slot only
          // genuinely changes identity when 0x0a37 lands a new itemId.
          inv.qty = Math.max(0, inv.qty - ev.amount);
        }
        itemDeletes.push(ev);
        break;
      }
      case "itemAdd": {
        const ev = decoded.data;
        const existing = inventory.get(ev.slot);
        if (existing && existing.itemId === ev.itemId) {
          existing.qty += ev.amount;
        } else {
          inventory.set(ev.slot, {
            itemId: ev.itemId,
            qty: ev.amount,
            equipped: 0,
            refine: ev.refine,
            cards: [0, 0, 0, 0],
            options: [],
          });
        }
        itemAdds.push(ev);
        break;
      }
      case "itemUseAck": {
        // 0x01c8 broadcasts to nearby observers, so most of these aren't
        // for our character. Only act on packets where aid matches.
        const ev = decoded.data;
        if (ev.aid !== session.aid) break;
        // Patch the inventory map so subsequent 0x07fa for the same slot
        // can resolve to itemId.
        inventory.set(ev.slot, {
          itemId: ev.itemId,
          qty: ev.amount,
          equipped: 0,
          refine: 0,
          cards: [0, 0, 0, 0],
          options: [],
        });
        // For a successful use, also emit a synthetic delete event so the
        // consumables panel counts it. Stackable consumables only fire
        // 0x01c8 per use; 0x07fa wouldn't fire until the slot drains.
        if (ev.success) {
          itemDeletes.push({
            time: ev.time,
            slot: ev.slot,
            amount: 1,
            reason: 0,
            itemId: ev.itemId,
          });
        }
        break;
      }
      case "equipChange": {
        // 0x0999 / 0x099a are sent only to the acting client, so every one is
        // the recording player's. Resolve the item identity from the running
        // inventory snapshot (same pattern as itemDelete) and keep the snapshot
        // coherent by toggling the record's equipped bits.
        const ev = decoded.data;
        if (!ev.success) break;
        const inv = inventory.get(ev.slot);
        if (inv) {
          if (ev.equipped) inv.equipped |= ev.location;
          else inv.equipped &= ~ev.location;
        }
        equipChanges.push({
          time: ev.time,
          slot: ev.slot,
          location: ev.location,
          equipped: ev.equipped,
          itemId: inv?.itemId ?? 0,
          refine: inv?.refine ?? 0,
          cards: inv ? inv.cards.filter((c) => c > 0) : [],
          options: inv?.options ?? [],
        });
        break;
      }
      case "paramChange":
        paramChanges.push(decoded.data);
        break;
      case "status":
        statusEvents.push(decoded.data);
        break;
    }
  }

  // The recording's true length (ms) is stored in ReplayData chunk 970 — this
  // is what the in-game replay UI counts down. It runs PAST the last packet
  // (the recorder keeps rolling a beat after the final action), so the
  // packet-stream span alone cuts off a skill used on the last frame. Prefer
  // the stored value; fall back to (and never go below) the packet span.
  const packetSpanMs =
    earliestTime === Number.POSITIVE_INFINITY ? 0 : Math.max(0, latestTime - earliestTime);
  const replayDataContainer = containers.find(
    (c): c is GenericContainer => c.kind === "generic" && c.type === ContainerType.ReplayData,
  );
  const storedDurationMs = replayDataContainer ? (readU32ChunkById(replayDataContainer, 970) ?? 0) : 0;
  const durationMs = Math.max(packetSpanMs, storedDurationMs);

  // The server often broadcasts the same skill-use / cast packet twice
  // (caster's own animation + nearby-observer broadcast that loops back to
  // the caster), within a few ms of each other. Collapse those duplicates
  // so counts match what actually happened in-game.
  const dedupedSkillUses = dedupeNear(
    skillUses,
    (e) => `${e.source}::${e.target}::${e.skillId}`,
    DEDUP_WINDOW_MS,
  );
  const dedupedSkillCasts = dedupeNear(
    skillCasts,
    (e) => `${e.source}::${e.target}::${e.skillId}`,
    DEDUP_WINDOW_MS,
  );
  const dedupedParams = dedupeNear(
    paramChanges,
    (e) => `${e.type}::${e.value.toString()}`,
    DEDUP_WINDOW_MS,
  );
  const dedupedStatus = dedupeNear(
    statusEvents,
    (e) => `${e.statusId}::${e.aid}::${e.isOn ? 1 : 0}`,
    DEDUP_WINDOW_MS,
  );

  return {
    sessionInfo: { ...session, durationMs },
    entities,
    damage,
    kills,
    vanishes,
    optionChanges,
    skillCasts: dedupedSkillCasts,
    skillUses: dedupedSkillUses,
    mobHp,
    mapChanges,
    moves,
    positions,
    initialInventory,
    itemDeletes,
    itemAdds,
    equipChanges,
    paramChanges: dedupedParams,
    statusEvents: dedupedStatus,
    chats,
    groundUnits,
    groundSkillUnits,
    totals: {
      packetCount,
      handledPackets,
      knownPacketIds: [...knownPacketIdSet].sort((a, b) => a - b),
    },
  };
}

const DEDUP_WINDOW_MS = 200;

function dedupeNear<T extends { time: number }>(
  events: T[],
  keyFn: (e: T) => string,
  windowMs: number,
): T[] {
  const sorted = [...events].sort((a, b) => a.time - b.time);
  const result: T[] = [];
  const lastByKey = new Map<string, number>();
  for (const e of sorted) {
    const k = keyFn(e);
    const prev = lastByKey.get(k);
    if (prev !== undefined && e.time - prev <= windowMs) continue;
    lastByKey.set(k, e.time);
    result.push(e);
  }
  return result;
}

function extractSessionInfo(containers: AnyContainer[], recordedAt: Date) {
  let player = "";
  let map = "";
  let aid = 0;
  let job = 0;
  let baseLevel = 0;
  // Sprite sex of the recording character — see the ReplayData chunk 963 note below.
  let sex = -1;
  // Appearance of the recording character, for the paper-doll viewer. The local
  // player never self-spawns, so (unlike other entities) the look isn't in any
  // spawn packet — it lives in the Session container: hair style (1060), hair
  // color (1064), clothes color (1063). 0 = default/standard palette.
  let hairStyle = 0;
  let hairColor = 0;
  let clothesColor = 0;
  // Local player's recording-start cell (from ReplayData chunks 967 / 968).
  let gx = 0;
  let gy = 0;
  // Local player's OPTION/effectState at recording start (Session chunk 1070) —
  // the same bitfield 0x0229 carries. It holds the mount/summon bits (FALCON,
  // WUG, MADOGEAR, …) the character already had when recording began. The local
  // player never self-spawns and often isn't re-broadcast a 0x0229 until seconds
  // in, so without this seed the falcon/warg (or mado gear) pop in late instead
  // of being present from the first frame. 0 = no special state.
  let option = 0;

  const replayData = containers.find(
    (c): c is GenericContainer =>
      c.kind === "generic" && c.type === ContainerType.ReplayData,
  );
  if (replayData) {
    if (replayData.chunks.length > 4) {
      player = readKoreanZ(replayData.chunks[4].data);
    }
    if (replayData.chunks.length > 5) {
      map = readKoreanZ(replayData.chunks[5].data);
    }
    // Sprite sex of the recording character lives in ReplayData chunk 963
    // (0 = female, 1 = male — same convention as spawn packets and the viewer,
    // so no flip). It is NOT in the Session container: the same account can hold
    // both male and female characters (so account-level data can't tell them
    // apart), and the local player never self-spawns, so this is the only
    // per-character sex source. Verified across the user's male/female replay
    // set. (Earlier code read Session chunk 1095, which is 0 for every character
    // regardless of sex → it always returned "male".)
    const sexFlag = readU32ChunkById(replayData, 963);
    sex = sexFlag === 0 ? 0 : sexFlag === 1 ? 1 : -1;
    // Local player's recording-start cell — chunks 967 (gx) and 968 (gy).
    // Verified across replays: for a recording where the player walked, the
    // first 0x0087 self-move's `from` cell matches these values exactly. The
    // local player never self-spawns via an entity packet, and 0x0091 only
    // fires on map transitions, so this is often the only source for the
    // player's initial cell (recordings that start mid-map).
    gx = readU32ChunkById(replayData, 967) ?? 0;
    gy = readU32ChunkById(replayData, 968) ?? 0;
  }

  const sessionContainer = containers.find(
    (c): c is GenericContainer =>
      c.kind === "generic" && c.type === ContainerType.Session,
  );
  if (sessionContainer) {
    aid = readU32ChunkById(sessionContainer, 1010) ?? 0;
    job = readU32ChunkById(sessionContainer, 1014) ?? 0;
    baseLevel = readU32ChunkById(sessionContainer, 1016) ?? 0;
    hairStyle = readU32ChunkById(sessionContainer, 1060) ?? 0;
    hairColor = readU32ChunkById(sessionContainer, 1064) ?? 0;
    clothesColor = readU32ChunkById(sessionContainer, 1063) ?? 0;
    option = readU32ChunkById(sessionContainer, 1070) ?? 0;
  }

  return { player, map, aid, job, baseLevel, recordedAt, sex, hairStyle, hairColor, clothesColor, gx, gy, option };
}

/**
 * Walk the Items container (type 8) for the initial inventory snapshot.
 *
 * Each chunk concatenates fixed-size 172-byte item records. The record is
 * actually a TLV stream of ~19 small tagged fields, but every record has
 * the same field order so the data lives at predictable offsets (per
 * `Tokeiburu/Rrf-Parser` `ReplayService.cs:154-184`):
 *
 *   +22  pos i16     (slot index, with -2 base)
 *   +42  equipped i32 (equipLocation bitmask, 0 = not equipped)
 *   +52  qty i16
 *   +82..+97  card[0..3] i32 × 4 (item ids in the upper card slots, 0 = empty)
 *   +104 nameid i32
 *   +134 refine u8
 *
 * Random options ("Bônus Aleatórios") DO live in the newer 221-byte record,
 * carried by the TLV tag 0x012d (u16 tag @184, u32 len=25 @186, value @190).
 * The value is the rAthena `ItemOptions` array: 5 × { id u16, value i16,
 * param u8 }. Empty slots have id 0. The older 172-byte record ends the TLV
 * stream before this tag, so it has none — `readRandomOptions` validates the
 * tag/length and degrades to an empty list when absent.
 */
/** Known EQUIPITEM_INFO record sizes, newest first. */
const ITEM_RECORD_SIZES = [221, 172] as const;
const NAMEID_OFFSET = 104;
/** Value-bytes offset of the 0x012d random-options TLV field (221-byte record). */
const OPTIONS_OFFSET = 190;
const OPTIONS_TAG = 0x012d;
const MAX_OPTIONS = 5;

/**
 * Read the 5-slot random-options array from an item record. Returns `[]` for
 * records that don't carry the 0x012d field (older 172-byte layout), guarded
 * by re-checking the tag + length so an unexpected layout fails closed.
 */
function readRandomOptions(
  view: DataView,
  base: number,
  recordSize: number,
): RandomOption[] {
  if (recordSize < OPTIONS_OFFSET + MAX_OPTIONS * 5) return [];
  const tag = view.getUint16(base + OPTIONS_OFFSET - 6, true);
  const len = view.getUint32(base + OPTIONS_OFFSET - 4, true);
  if (tag !== OPTIONS_TAG || len !== MAX_OPTIONS * 5) return [];
  const out: RandomOption[] = [];
  for (let i = 0; i < MAX_OPTIONS; i++) {
    const o = base + OPTIONS_OFFSET + i * 5;
    const id = view.getUint16(o, true);
    if (id === 0) continue; // empty slot
    out.push({ id, value: view.getInt16(o + 2, true), param: view.getUint8(o + 4) });
  }
  return out;
}

/**
 * Pick the record stride for an Items-container chunk. A chunk is a tight
 * array of equal-size records, so the real size divides the chunk length.
 *
 * We can't disambiguate on just the first record(s): the equipped-gear chunks
 * (4601 main / 4603 costume+shadow) interleave EMPTY placeholder records whose
 * `nameid` is 0, and they often sit at the start of the chunk. Validating only
 * the first couple of nameids would reject the right stride and skip the whole
 * chunk — dropping all worn gear and leaving costume slots unresolved.
 *
 * Instead, validate every record: with the correct stride each `nameid` reads
 * as either an empty slot (0) or a plausible item id, and at least one is a
 * real item. A wrong stride lands most nameids on garbage and fails this.
 * Returns 0 when nothing fits (empty or non-item chunks).
 */
function detectItemRecordSize(view: DataView, byteLength: number): number {
  const validId = (id: number) => id > 0 && id < 5_000_000;
  for (const size of ITEM_RECORD_SIZES) {
    if (byteLength < size || byteLength % size !== 0) continue;
    const count = byteLength / size;
    let anyValid = false;
    let ok = true;
    for (let r = 0; r < count; r++) {
      const id = view.getInt32(r * size + NAMEID_OFFSET, true);
      if (id === 0) continue; // empty slot — neutral
      if (!validId(id)) {
        ok = false;
        break;
      }
      anyValid = true;
    }
    if (ok && anyValid) return size;
  }
  return 0;
}

function readItemsContainer(
  containers: AnyContainer[],
): Map<number, InventoryRecord> {
  const out = new Map<number, InventoryRecord>();
  const itemsContainer = containers.find(
    (c): c is GenericContainer =>
      c.kind === "generic" && c.type === ContainerType.Items,
  );
  if (!itemsContainer) return out;

  // The per-item record size depends on the client that recorded the replay:
  // older builds use a 172-byte EQUIPITEM_INFO, newer ones 221 bytes (extra
  // grade / option-slot fields appended at the end). The field offsets below
  // are unchanged between the two — only the stride differs — so we detect the
  // stride per chunk from its length + a sanity check on the item id.
  // The Items container has multiple chunks:
  //   4601 — currently-equipped main gear (head/weapon/armor/etc.)
  //   4603 — currently-equipped costume + shadow gear
  //   4602, 4604 — the "equip-switch" alternate presets the player bound
  //                via the equipment-swap feature. Same shape, but the
  //                items aren't actively worn — skip them entirely.
  //   4605, 4606 — ghost / removed slots (records with qty=0).
  //   4510       — main bag; equipped slots appear here too but with
  //                equipped=0 / zero cards (bag view).
  // Process 4601 + 4603 first so the rich per-item record wins, then fall
  // back to the bag for consumables / loot that aren't equipped anywhere.
  const ACTIVE_EQUIP_CHUNKS = new Set([4601, 4603]);
  const SKIP_EQUIP_CHUNKS = new Set([4602, 4604, 4605, 4606]);
  const sortedChunks = [...itemsContainer.chunks]
    .filter((c) => !SKIP_EQUIP_CHUNKS.has(c.id))
    .sort((a, b) => {
      const aEquip = ACTIVE_EQUIP_CHUNKS.has(a.id) ? 0 : 1;
      const bEquip = ACTIVE_EQUIP_CHUNKS.has(b.id) ? 0 : 1;
      return aEquip - bEquip;
    });
  for (const chunk of sortedChunks) {
    const view = new DataView(
      chunk.data.buffer,
      chunk.data.byteOffset,
      chunk.data.byteLength,
    );
    const RECORD = detectItemRecordSize(view, chunk.data.byteLength);
    if (!RECORD) continue;
    let p = 0;
    while (p + RECORD <= chunk.data.byteLength) {
      const pos = view.getInt16(p + 22, true) - 2;
      const equipped = view.getInt32(p + 42, true);
      const qty = view.getInt16(p + 52, true);
      const card0 = view.getInt32(p + 82, true);
      const card1 = view.getInt32(p + 86, true);
      const card2 = view.getInt32(p + 90, true);
      const card3 = view.getInt32(p + 94, true);
      const nameid = view.getInt32(p + 104, true);
      const refine = view.getUint8(p + 134);
      if (nameid > 0 && qty > 0 && pos >= 0 && !out.has(pos)) {
        out.set(pos, {
          itemId: nameid,
          qty,
          equipped,
          refine,
          cards: [card0, card1, card2, card3],
          options: readRandomOptions(view, p, RECORD),
        });
      }
      p += RECORD;
    }
  }
  return out;
}

function readU32ChunkById(
  container: GenericContainer,
  chunkId: number,
): number | null {
  const ch = container.chunks.find((c) => c.id === chunkId);
  if (!ch || ch.data.byteLength < 4) return null;
  const view = new DataView(ch.data.buffer, ch.data.byteOffset, 4);
  return view.getUint32(0, true);
}
