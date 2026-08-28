// The only Worker in this project, and it runs on exactly one prefix: /api/*
// (see `run_worker_first` in wrangler.jsonc). Every other request — the shell,
// the bundles, the hashed db JSONs — is a free static asset that never invokes
// this script. That split is deliberate: on the Workers free plan the request
// budget is finite, and putting the whole site behind the Worker means a 429
// takes down the homepage.
//
// Replaces what Firestore + firestore.rules used to do. The validation that
// lived in the rules file (key allowlist, size caps, field truncation) lives in
// `parseSummary` / `handleUpload` below — with no rules engine in front of D1,
// this Worker IS the trust boundary and must not assume anything about the body.

import {
  MAX_FILE_NAME,
  MAX_MVP_RECORDS,
  MAX_UPLOAD_BYTES,
  normalizeClass,
  tooLargeMessage,
  type MvpRecord,
} from "../shared/replay";

export interface Env {
  DB: D1Database;
  REPLAYS: R2Bucket;
}

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { ...JSON_HEADERS, ...(init.headers ?? {}) },
  });
}

function bad(message: string, status = 400): Response {
  return json({ error: message }, { status });
}

/** 10-char slug from a confusion-free alphabet — same scheme as the old ids. */
function generateReplayId(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const arr = crypto.getRandomValues(new Uint8Array(10));
  let id = "";
  for (const b of arr) id += alphabet[b % alphabet.length];
  return id;
}

const num = (v: unknown): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown, max: number): string =>
  typeof v === "string" ? v.slice(0, max) : "";

/**
 * Sanitize an untrusted summary into exactly the columns we store. Anything not
 * named here is dropped rather than rejected — the old rules used a key
 * allowlist for the same reason, so a newer client sending an extra field does
 * not start failing uploads against an older Worker.
 */
function parseSummary(raw: unknown) {
  const s = (raw ?? {}) as Record<string, unknown>;
  const recordedAt = Date.parse(String(s.recordedAt ?? ""));
  const mvpRaw = Array.isArray(s.mvpRecords) ? s.mvpRecords : [];
  const mvpRecords: MvpRecord[] = mvpRaw.slice(0, MAX_MVP_RECORDS).map((r) => {
    const m = (r ?? {}) as Record<string, unknown>;
    return {
      view: num(m.view),
      name: str(m.name, 40),
      playerAid: num(m.playerAid),
      playerName: str(m.playerName, 50),
      class: normalizeClass(str(m.class, 30)),
      totalDamage: num(m.totalDamage),
      highestHit: num(m.highestHit),
      combatSpanMs: num(m.combatSpanMs),
      dps: num(m.dps),
    };
  });
  return {
    player: str(s.player, 50),
    map: str(s.map, 50),
    recordedAt: Number.isFinite(recordedAt) ? recordedAt : null,
    durationMs: num(s.durationMs),
    totalDamage: num(s.totalDamage),
    avgDps: num(s.avgDps),
    damageEvents: num(s.damageEvents),
    kills: num(s.kills),
    entitiesSeen: num(s.entitiesSeen),
    handledPackets: num(s.handledPackets),
    packetCount: num(s.packetCount),
    mvpRecords,
  };
}

/**
 * POST /api/replays — multipart/form-data with a `file` part (the .rrf) and a
 * `summary` part (JSON). Returns { id }.
 */
async function handleUpload(request: Request, env: Env): Promise<Response> {
  const ct = request.headers.get("content-type") ?? "";
  if (!ct.includes("multipart/form-data")) {
    return bad("Envie multipart/form-data com as partes `file` e `summary`.");
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return bad("Corpo multipart inválido.");
  }

  const file = form.get("file");
  if (!(file instanceof File)) return bad("Parte `file` ausente.");
  if (file.size === 0) return bad("Arquivo vazio.");
  if (file.size > MAX_UPLOAD_BYTES) return bad(tooLargeMessage(), 413);

  const fileName =
    str(form.get("fileName") ?? "replay.rrf", MAX_FILE_NAME) || "replay.rrf";

  let summary: ReturnType<typeof parseSummary>;
  try {
    const raw = form.get("summary");
    summary = parseSummary(typeof raw === "string" ? JSON.parse(raw) : {});
  } catch {
    return bad("Parte `summary` não é JSON válido.");
  }

  // Collision odds on a 10-char/56-symbol slug are negligible, but an overwrite
  // would silently destroy someone else's replay, so check rather than assume.
  let id = generateReplayId();
  for (let i = 0; i < 5; i++) {
    const clash = await env.DB.prepare("SELECT 1 FROM replays WHERE id = ?")
      .bind(id)
      .first();
    if (!clash) break;
    id = generateReplayId();
  }

  // Streamed, not buffered: `request.formData()` already materialized the part,
  // so an `arrayBuffer()` here would be a second copy of up to 5 MB in isolate
  // memory purely to hand it straight to R2. `file.size` gives the length the
  // row needs without reading the body at all.
  //
  // R2 first: an orphaned object is harmless (nothing links to it) whereas a D1
  // row with no object would be a share link that 404s.
  await env.REPLAYS.put(`${id}.rrf`, file.stream(), {
    httpMetadata: { contentType: "application/octet-stream" },
    // The original name travels with the object so the bytes endpoint can
    // return it without a D1 read — fetchReplay() needs both together.
    customMetadata: { fileName },
  });

  const uploadedAt = Date.now();
  const statements = [
    env.DB.prepare(
      `INSERT INTO replays (
         id, file_name, uploaded_at, recorded_at, player, map, duration_ms,
         total_damage, avg_dps, damage_events, kills, entities_seen,
         handled_packets, packet_count, byte_size
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      id,
      fileName,
      uploadedAt,
      summary.recordedAt,
      summary.player,
      summary.map,
      summary.durationMs,
      summary.totalDamage,
      summary.avgDps,
      summary.damageEvents,
      summary.kills,
      summary.entitiesSeen,
      summary.handledPackets,
      summary.packetCount,
      file.size,
    ),
    ...summary.mvpRecords.map((r) =>
      env.DB.prepare(
        `INSERT OR REPLACE INTO mvp_records (
           replay_id, view, name, player_aid, player_name, class,
           total_damage, highest_hit, combat_span_ms, dps
         ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        id,
        r.view,
        r.name,
        r.playerAid,
        r.playerName,
        r.class,
        r.totalDamage,
        r.highestHit,
        r.combatSpanMs,
        r.dps,
      ),
    ),
  ];

  try {
    await env.DB.batch(statements);
  } catch (err) {
    // Roll the object back so we don't accumulate garbage in R2.
    await env.REPLAYS.delete(`${id}.rrf`).catch(() => {});
    throw err;
  }

  return json({ id });
}

/**
 * GET /api/replays — every summary, newest first, with its MVP records nested
 * so the response is drop-in compatible with what listRecentReplays() returned.
 *
 * Two queries and a join in JS rather than one joined query: the row-per-record
 * fan-out would repeat every summary column once per MVP record, and D1 bills
 * rows read.
 */
async function handleList(env: Env): Promise<Response> {
  const [replays, records] = await Promise.all([
    env.DB.prepare(
      `SELECT id, file_name, uploaded_at, recorded_at, player, map, duration_ms,
              total_damage, avg_dps, damage_events, kills, entities_seen,
              handled_packets, packet_count, byte_size
         FROM replays
        ORDER BY uploaded_at DESC, id DESC`,
    ).all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT replay_id, view, name, player_aid, player_name, class,
              total_damage, highest_hit, combat_span_ms, dps
         FROM mvp_records`,
    ).all<Record<string, unknown>>(),
  ]);

  const byReplay = new Map<string, MvpRecord[]>();
  for (const r of records.results ?? []) {
    const list = byReplay.get(r.replay_id as string) ?? [];
    list.push({
      view: r.view as number,
      name: r.name as string,
      playerAid: r.player_aid as number,
      playerName: r.player_name as string,
      class: r.class as string,
      totalDamage: r.total_damage as number,
      highestHit: r.highest_hit as number,
      combatSpanMs: r.combat_span_ms as number,
      dps: r.dps as number,
    });
    byReplay.set(r.replay_id as string, list);
  }

  const items = (replays.results ?? []).map((d) => ({
    id: d.id as string,
    fileName: d.file_name as string,
    uploadedAt: d.uploaded_at as number,
    player: d.player as string | null,
    map: d.map as string | null,
    recordedAt: d.recorded_at as number | null,
    durationMs: d.duration_ms as number | null,
    totalDamage: d.total_damage as number | null,
    avgDps: d.avg_dps as number | null,
    damageEvents: d.damage_events as number | null,
    kills: d.kills as number | null,
    entitiesSeen: d.entities_seen as number | null,
    handledPackets: d.handled_packets as number | null,
    packetCount: d.packet_count as number | null,
    byteSize: d.byte_size as number | null,
    mvpRecords: byReplay.get(d.id as string) ?? [],
  }));

  return json(
    { items },
    {
      headers: {
        // Edge TTL, and the number matters. A miss reads the whole collection:
        // at 991 replays that is ~6,375 D1 rows and ~1.3 MB of JSON. D1's free
        // plan allows 5M row-reads/day, and the TTL is per-PoP — at 60s a
        // globally-spread audience could miss often enough to blow that budget
        // on the recent-replays list alone. 300s cuts it 5x for staleness nobody
        // can perceive on a "recent replays" table. s-maxage is edge-only, so a
        // user's own fresh upload still appears via the client-side invalidate.
        //
        // The real fix is to stop returning the whole collection — see the note
        // in schema.sql about the leaderboard still aggregating client-side.
        "Cache-Control": "public, max-age=0, s-maxage=300, must-revalidate",
      },
    },
  );
}

/** GET /api/replays/:id — the raw .rrf bytes, straight from R2. */
async function handleBytes(id: string, env: Env): Promise<Response> {
  const obj = await env.REPLAYS.get(`${id}.rrf`);
  if (!obj) return bad("Replay não encontrado.", 404);

  return new Response(obj.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(obj.size),
      "ETag": obj.httpEtag,
      // Non-standard, same-origin only: lets fetchReplay() restore the original
      // name in one request instead of a second lookup for one string.
      "X-Replay-Filename": encodeURIComponent(
        obj.customMetadata?.fileName ?? `${id}.rrf`,
      ),
      // Replays are immutable — the old firestore.rules denied update and delete
      // outright, and nothing here changes that. So the edge can hold them
      // forever, which means a replay shared in Discord is fetched from R2 once
      // and served from cache to everyone after, keeping Worker invocations far
      // below the free daily budget no matter how widely a link spreads.
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/api/replays") {
        if (request.method === "GET") return await handleList(env);
        if (request.method === "POST") return await handleUpload(request, env);
        return bad("Método não permitido.", 405);
      }

      const m = path.match(/^\/api\/replays\/([A-Za-z0-9]{1,32})$/);
      if (m && request.method === "GET") return await handleBytes(m[1], env);

      return bad("Rota não encontrada.", 404);
    } catch (err) {
      console.error("api error", path, err);
      return bad("Erro interno.", 500);
    }
  },
};
