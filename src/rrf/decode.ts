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
  MapChange,
  MobHpUpdate,
  Replay,
  SkillCast,
  SkillUse,
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
  const knownPacketIdSet = new Set<number>();

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
      case "damage":
        damage.push(decoded.data);
        break;
      case "skillUse":
        skillUses.push(decoded.data);
        break;
      case "skillCast":
        skillCasts.push(decoded.data);
        break;
      case "mapChange":
        mapChanges.push(decoded.data);
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

  return {
    sessionInfo: { ...session, durationMs },
    entities,
    damage,
    kills,
    skillCasts: dedupedSkillCasts,
    skillUses: dedupedSkillUses,
    mobHp,
    mapChanges,
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

function readU32ChunkById(
  container: GenericContainer,
  chunkId: number,
): number | null {
  const ch = container.chunks.find((c) => c.id === chunkId);
  if (!ch || ch.data.byteLength < 4) return null;
  const view = new DataView(ch.data.buffer, ch.data.byteOffset, 4);
  return view.getUint32(0, true);
}
