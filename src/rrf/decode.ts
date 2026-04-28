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
  DamageEvent,
  Entity,
  EntityKind,
  InventoryRecord,
  ItemAddEvent,
  ItemDeleteEvent,
  MapChange,
  MobHpUpdate,
  ParamChangeEvent,
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
    });
  }
  const damage: DamageEvent[] = [];
  const kills: VanishEvent[] = [];
  const skillCasts: SkillCast[] = [];
  const skillUses: SkillUse[] = [];
  const mobHp: MobHpUpdate[] = [];
  const mapChanges: MapChange[] = [];
  const itemDeletes: ItemDeleteEvent[] = [];
  const itemAdds: ItemAddEvent[] = [];
  const paramChanges: ParamChangeEvent[] = [];
  const statusEvents: StatusEvent[] = [];
  const knownPacketIdSet = new Set<number>();
  // Map from ground-skill-unit AID → caster AID. Skills like Onda Psíquica
  // (Psychic Wave), Storm Gust, Comet, etc. spawn a "skill unit" entity that
  // deals the damage in subsequent ticks; the damage packets list the unit's
  // AID as the source. We rewrite source back to the caster when we see one.
  const groundUnitOwner = new Map<number, number>();

  // Initial inventory snapshot from the Items container — used to resolve
  // `itemId` for slots when 0x07fa fires later. Mutated as 0x0a37 / 0x07fa
  // packets stream in.
  const initialInventory = readItemsContainer(containers);
  const inventory = new Map(initialInventory);

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
        break;
      }
      case "vanish":
        if (decoded.data.kind === 1) kills.push(decoded.data);
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
        break;
      }
      case "skillCast": {
        const c = decoded.data;
        const owner = groundUnitOwner.get(c.source);
        if (owner) c.source = owner;
        skillCasts.push(c);
        break;
      }
      case "groundSkillEntry": {
        const ev = decoded.data;
        if (ev.unitAid && ev.casterAid) {
          groundUnitOwner.set(ev.unitAid, ev.casterAid);
        }
        break;
      }
      case "mapChange":
        mapChanges.push(decoded.data);
        break;
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
      case "paramChange":
        paramChanges.push(decoded.data);
        break;
      case "status":
        statusEvents.push(decoded.data);
        break;
    }
  }

  const durationMs =
    earliestTime === Number.POSITIVE_INFINITY
      ? 0
      : Math.max(0, latestTime - earliestTime);

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
    skillCasts: dedupedSkillCasts,
    skillUses: dedupedSkillUses,
    mobHp,
    mapChanges,
    initialInventory,
    itemDeletes,
    itemAdds,
    paramChanges: dedupedParams,
    statusEvents: dedupedStatus,
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
  }

  const sessionContainer = containers.find(
    (c): c is GenericContainer =>
      c.kind === "generic" && c.type === ContainerType.Session,
  );
  if (sessionContainer) {
    aid = readU32ChunkById(sessionContainer, 1010) ?? 0;
    job = readU32ChunkById(sessionContainer, 1014) ?? 0;
    baseLevel = readU32ChunkById(sessionContainer, 1016) ?? 0;
  }

  return { player, map, aid, job, baseLevel, recordedAt };
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
 * Random options / enchants are NOT in this layout on the Latam server —
 * the TLV stream ends at tag 0x011a (the trailing 4-byte field is a counter
 * that varies but doesn't decode as the rAthena `ItemOptions` triple). If a
 * future server's snapshots carry them, append the offsets here.
 */
function readItemsContainer(
  containers: AnyContainer[],
): Map<number, InventoryRecord> {
  const out = new Map<number, InventoryRecord>();
  const itemsContainer = containers.find(
    (c): c is GenericContainer =>
      c.kind === "generic" && c.type === ContainerType.Items,
  );
  if (!itemsContainer) return out;

  const RECORD = 172;
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
