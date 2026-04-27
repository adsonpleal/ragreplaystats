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
        damage.push(d);
        break;
      }
      case "skillUse":
        skillUses.push(decoded.data);
        break;
      case "skillCast":
        skillCasts.push(decoded.data);
        break;
      case "mapChange":
        mapChanges.push(decoded.data);
        break;
      case "itemDelete": {
        const ev = decoded.data;
        const inv = inventory.get(ev.slot);
        if (inv) {
          ev.itemId = inv.itemId;
          const remaining = inv.qty - ev.amount;
          if (remaining <= 0) inventory.delete(ev.slot);
          else inv.qty = remaining;
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
          inventory.set(ev.slot, { itemId: ev.itemId, qty: ev.amount });
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
        inventory.set(ev.slot, { itemId: ev.itemId, qty: ev.amount });
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
 * Each chunk concatenates fixed-size 172-byte item records with these
 * offsets (per `Tokeiburu/Rrf-Parser` `ReplayService.cs:154-184`):
 *   +22  pos i16   (slot index, with -2 base)
 *   +52  qty i16
 *   +104 nameid i32
 *
 * We skip the rest of the per-record fields (cards, refine, equipped, etc.)
 * — the stats tab only needs slot → itemId mapping.
 */
function readItemsContainer(
  containers: AnyContainer[],
): Map<number, { itemId: number; qty: number }> {
  const out = new Map<number, { itemId: number; qty: number }>();
  const itemsContainer = containers.find(
    (c): c is GenericContainer =>
      c.kind === "generic" && c.type === ContainerType.Items,
  );
  if (!itemsContainer) return out;

  const RECORD = 172;
  // The Items container has chunks for several inventory stores (main bag,
  // cart, equipped, possibly storage). The same `pos` shows up in more than
  // one chunk with different qty values. We want the main bag — which on
  // observed recordings is the FIRST chunk with the highest record count.
  // Strategy: keep the first observed entry for each slot (`if !has`), so
  // the largest store wins as long as it's processed first.
  for (const chunk of itemsContainer.chunks) {
    const view = new DataView(
      chunk.data.buffer,
      chunk.data.byteOffset,
      chunk.data.byteLength,
    );
    let p = 0;
    while (p + RECORD <= chunk.data.byteLength) {
      const pos = view.getInt16(p + 22, true) - 2;
      const qty = view.getInt16(p + 52, true);
      const nameid = view.getInt32(p + 104, true);
      if (nameid > 0 && qty > 0 && pos >= 0 && !out.has(pos)) {
        out.set(pos, { itemId: nameid, qty });
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
