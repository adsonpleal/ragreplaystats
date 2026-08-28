-- D1 schema for the replay metadata that used to live in Firestore.
--
-- Apply:  wrangler d1 execute ragnarecap --remote --file=schema.sql
--   (drop --remote to seed the local dev database)
--
-- SHAPE CHANGE FROM FIRESTORE. The old model was one document per replay with the
-- summary fields plus an `mvpRecords` array denormalized inside it. Here
-- mvp_records is a real table.
--
-- AGGREGATION IS STILL CLIENT-SIDE, deliberately, and this comment previously
-- claimed otherwise. GET /api/replays returns the whole collection and
-- src/features/leaderboard/leaderboardData.ts does the filtering and top-N in
-- the browser, exactly as it did on Firestore. That is not just laziness:
-- collectMvpOptions and anyClasslessRecord genuinely need the full record set,
-- so a GROUP BY is not a straight swap for what the leaderboard renders.
--
-- The cost is real and worth knowing before this grows: one cache miss reads
-- every row of both tables (~6,375 at 991 replays). The Worker leans on a long
-- edge TTL to keep that off D1's free row-read budget. If the collection keeps
-- growing, the fix is a paginated list plus a dedicated /api/leaderboard doing
-- the GROUP BY server-side — at which point the indexes for it can be added
-- alongside the query that needs them, rather than ahead of it.
--
-- The replay bytes are NOT here. They live in R2 under the object key `<id>.rrf`,
-- which is what lifted the 1 MB ceiling — that limit was Firestore's hard
-- per-document size cap, never a policy we chose.

CREATE TABLE IF NOT EXISTS replays (
  id               TEXT PRIMARY KEY,
  file_name        TEXT NOT NULL,
  -- epoch millis (UTC). SQLite has no date type; millis keep the client's
  -- existing Date handling and sort correctly as integers.
  uploaded_at      INTEGER NOT NULL,
  recorded_at      INTEGER,
  player           TEXT,
  map              TEXT,
  duration_ms      INTEGER,
  total_damage     INTEGER,
  avg_dps          INTEGER,
  damage_events    INTEGER,
  kills            INTEGER,
  entities_seen    INTEGER,
  handled_packets  INTEGER,
  packet_count     INTEGER,
  -- Size of the R2 object, so the list can show it without a HEAD to R2.
  byte_size        INTEGER NOT NULL
);

-- The recent list is uploaded_at DESC; the id tiebreaker keeps paging stable
-- across rows sharing a millisecond, same reason the Firestore query carried a
-- __name__ tiebreaker.
CREATE INDEX IF NOT EXISTS idx_replays_uploaded_at
  ON replays (uploaded_at DESC, id DESC);

-- One row per (replay, player, MVP species). Was the `mvpRecords` array.
CREATE TABLE IF NOT EXISTS mvp_records (
  replay_id       TEXT NOT NULL REFERENCES replays(id) ON DELETE CASCADE,
  view            INTEGER NOT NULL,
  name            TEXT NOT NULL,
  player_aid      INTEGER NOT NULL,
  player_name     TEXT NOT NULL,
  class           TEXT NOT NULL DEFAULT '',
  total_damage    INTEGER NOT NULL,
  highest_hit     INTEGER NOT NULL,
  combat_span_ms  INTEGER NOT NULL,
  dps             INTEGER NOT NULL,
  PRIMARY KEY (replay_id, player_aid, view)
);
