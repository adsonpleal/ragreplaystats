# RagReplayStats

**Live: <https://adsonpleal.github.io/ragreplaystats/>**

Static website that parses Ragnarok Online `.rrf` replay files and shows damage / skill / kill statistics. All decoding and aggregation happen **in the browser** — the file is also stored in Firebase Firestore so a shareable link with a 10-char id is produced. Files >1 MiB stay local and aren't uploaded.

UI is in **Brazilian Portuguese**. The decoder is server-agnostic but the bundled reference data (skill / mob / job names) was extracted from a brAthena-style Latam client (Event Horizon GRF) and rAthena's renewal `mob_db.yml`.

## Stack

- Vanilla TypeScript + Vite, single bundled SPA.
- `uplot` for time-series charts.
- A 230-line custom GRF reader + Lua 5.1 bytecode constant-pool walker (`tools/build-db.mjs`) that produces `public/db/job.json` from a client GRF.
- [Divine Pride API](https://www.divine-pride.net/api) for skill / monster / item / status names (server `latamRO`, `Accept-Language: pt-BR`). Lookups are cached to `localStorage`, so repeat visits are instant.
- Firebase Firestore (free Spark tier) holds the uploaded `.rrf` bytes (≤1 MiB / doc). Lazy-loaded — the SDK isn't fetched unless the user shares or opens a shared link.

## Run

```bash
npm install
npm run dev      # http://127.0.0.1:5173
npm run build    # static output in dist/

# Rebuild the name DBs (only needed once, or when upgrading the client):
node tools/build-db.mjs --grf /path/to/data.grf
# or, faster, against a pre-extracted folder:
node tools/build-db.mjs --dir ~/Downloads/Ragnarok-extracted
```

The `tools/build-db.mjs` script also supports `--list <file.grf>` (print contents), `--dump <file.grf>::<inner-path>` (extract one file to stdout), and `--extract <dir> [--match <regex>]` (full GRF extraction).

## Architecture

```
src/
  rrf/                — pure decoder: RRF → typed Replay model
    crypt.ts          — XOR-based payload decrypt (keys derived from recording date)
    header.ts         — 112-byte header parser
    containers.ts     — 24 ChunkContainers, each zlib-decompressed and walked
    packets/          — one file per category, each decodes a few packet IDs
    decode.ts         — orchestrator; emits Replay { entities, damage, kills, skillUses, ... }
  aggregate/          — pure functions: Replay + filter → table / chart view-models
  db/loader.ts        — fetches public/db/*.json once, exposes resolveSkill / resolveMob / resolveJob
  ui/                 — file drop, tables, line + bar charts (no framework)
  i18n.ts             — pt-BR strings
```

## RRF packets

The PacketStream container in a `.rrf` file is a chronological log of server→client packets. Each packet has a 2-byte ID and an opaque payload — we decode only the ones relevant to damage / skill / kill stats.

### Decoded packets

| ID | Mnemonic | What we use it for |
|----|----------|--------------------|
| `0x008a` | `ZC_NOTIFY_ACT` | Legacy auto-attack damage (older clients). Source/target AID, damage, hit type. |
| `0x02e1` | `ZC_NOTIFY_ACT3` | Auto-attack damage. Source/target AID, damage, hit count, hit type (normal/critical/double/lucky/miss). |
| `0x01de` | `ZC_NOTIFY_SKILL` | Skill that dealt damage. Skill ID + level, source/target AID, damage, multi-hit count, hit type. |
| `0x011a` | `ZC_USE_SKILL` (legacy) | Skill that didn't deal damage (heals, buffs). Skill ID + level, source, target. |
| `0x09cb` | `ZC_USE_SKILL2` | Same as `0x011a` for newer clients (skill level is `i32`). |
| `0x013e` | `ZC_USESKILL_ACK` | Skill cast started — gives cast time per skill. |
| `0x09fe` | `ZC_NOTIFY_STANDENTRY11` | Entity already idle on screen at session start. Layout: object type, AID, GID, job/view, level, max HP, current HP, isBoss, name. |
| `0x09ff` | `ZC_NOTIFY_STANDENTRY_NPC11` | Entity newly visible standing still. +1 byte (`state`) vs `0x09fe`. |
| `0x09fd` | `ZC_NOTIFY_NEWENTRY11` | Entity newly visible while moving. Same body fields as walking, with `moveStartTime` + 6-byte `MoveData` instead of 3-byte `PosDir`. |
| `0x0915` | `ZC_NOTIFY_MOVEENTRY11` | Walking entity update. Same layout as `0x09fd`. |
| `0x0080` | `ZC_NOTIFY_VANISH` | Entity disappeared. Type byte distinguishes died (1) from out-of-sight / teleported / logged out — only `1` becomes a kill event. |
| `0x0977` | `ZC_HP_INFO` | Mob HP update. Drives the "current HP" column once we get a value the server actually disclosed. |
| `0x0091` | `ZC_NPCACK_MAPMOVE` | Map change (cross-map session). Currently captured but the test recording has none. |

### Packets seen in the stream but not decoded

Anything in this list is a packet ID that **does** appear in the test recording (`rag_test.rrf`) but doesn't move any v1 stat. Fair game for future expansion.

| ID | Mnemonic / purpose | What it would unlock |
|----|--------------------|----------------------|
| `0x007f` | `ZC_NOTIFY_TIME` | Server clock sync ticks — useful for absolute-time correlation across replays. |
| `0x0087` | `ZC_NOTIFY_PLAYERMOVE` | Confirmation of own movement. Movement timeline / pathing replay. |
| `0x0088` | `ZC_STOPMOVE` | Entity stopped at a tile. Same as above. |
| `0x009c` | `ZC_CHANGE_DIRECTION` | Head/body direction change. Cosmetic only. |
| `0x009d` | `ZC_ITEM_ENTRY` | Item appears on the ground. Drop tracking. |
| `0x00a1` | `ZC_ITEM_DISAPPEAR` | Ground item gone (picked up or despawned). Pair with `0x009d` for loot stats. |
| `0x00b0` | `ZC_PAR_CHANGE` | Parameter change for the player (HP, SP, base/job exp, weight, zeny, stat points). Curves of HP/SP/exp over time. |
| `0x010f` | `ZC_SKILLINFO_LIST` | Initial skill list with max level / SP cost / range. Skill book panel. |
| `0x0110` | `ZC_ACK_TOUSESKILL` | "You can't use that skill" — failure reason code. Counts of failed casts per skill. |
| `0x0120` | `ZC_DISAPPEAR_ENTRY` | Ground skill expired (trap consumed, area effect ended). Trap uptime stats. |
| `0x0131` | `ZC_STORE_ENTRY` | Vendor stall sign. Marketplace overlay. |
| `0x0141` | `ZC_COUPLESTATUS` | Base + bonus stat — what your character sheet shows. |
| `0x0196` | `ZC_MSG_STATE_CHANGE` | Status effect started/ended on an entity (poison, blessing, etc.). Buff/debuff timelines. |
| `0x019b` | `ZC_NOTIFY_EFFECT2` | Visual effect overlay (auras, AoE markers). |
| `0x01d0` | `ZC_SPIRITS` | Spirit / coin ball count for monks/champions/Suras. Build-up visualization. |
| `0x01d6` | `ZC_NOTIFY_PKINFO` | PK-mode toggle on a map. |
| `0x01f3` | `ZC_NOTIFY_EFFECT` | Special-effect ID at AID (e.g., level-up sparkle). |
| `0x0235` | `ZC_PROPERTY_HOMUN` | Homunculus stats / hunger / loyalty. Homun panel. |
| `0x029d` | `ZC_SKILLINFO_LIST2` | Newer skill list packet (renewal). Same as `0x010f`. |
| `0x043d` | `ZC_SKILL_POSTDELAY` | Skill cooldown after cast. Average cooldown / "skill available again" timing. |
| `0x043f` | `ZC_MSG_STATE_CHANGE3` | Status icon with sub-value (e.g., countdown). Per-status duration tracking. |
| `0x0446` | `ZC_QUEST_NOTIFY_EFFECT` | Quest objective reached (sparkles). |
| `0x07fa` | `ZC_DELETE_ITEM_FROM_BODY` | Inventory item consumed/removed. Consumable usage stats. |
| `0x07fb` | `ZC_USE_SKILL2` | Skill use targeting (extra info vs `0x011a` family). |
| `0x07fd` | `ZC_BROADCASTING_SPECIAL_ITEM_OBTAIN` | Server-wide drop announcement. |
| `0x0814` | `ZC_SE_PC_BUY_CASHITEM` | Cash-shop purchase. |
| `0x08d2` | `ZC_FASTMOVE` | Renewal-fast movement variant. |
| `0x0983` | `ZC_MSG_STATE_CHANGE_TICK` | Status effect with explicit duration tick. Better buff timelines than `0x0196`. |
| `0x099b` | `ZC_MAP_PROPERTY_INFO` | Map flags (PK/PVP, GVG, no-skill, etc.). |
| `0x09ca` | `ZC_SKILL_ENTRY5` | Newer ground skill (replaces `0x0117`). AoE coverage / Pneuma / Safety Wall placement. |
| `0x0a30` | `ZC_ACK_REQNAMEALL2` | Full name + party + guild + title for an AID. Adds guild/party tags to player rows. |
| `0x0a36` | `ZC_HP_INFO_TINY` | Compact HP update for a known target (party/boss). Better mob HP curves. |
| `0x0a37` | `ZC_ADD_ITEM_TO_INVENTORY3` | Inventory item received (loot / quest reward). Loot table per fight. |
| `0x0a8a` | `ZC_HOMUN_PROPERTY` | Homunculus periodic info. |
| `0x0add` | `ZC_ITEM_FALL_ENTRY4` | Item dropped at a position with sub-type. Drop attribution. |
| `0x0afe` | `ZC_HOMUN_EXP` (or progress event) | Homun XP / event counter. |
| `0x0b05` | `ZC_PARAM_CHANGE_USER` | Newer parameter-change packet (renewal expansion of `0x00b0`). |

Mnemonics follow the rAthena / Hercules convention. Some IDs are used differently across client builds; the descriptions above match the pre-2024 Latam renewal client this site was built against.

## Reference data

| Source | Contents |
|--------|----------|
| Divine Pride API (`/Item/`, `/Monster/`, `/Skill/`, `/Buff/`) with `server=latamRO` and `Accept-Language: pt-BR` | Item, monster, skill, and status-effect names. Fetched the first time an id appears in any replay you load, then cached in `localStorage`. |
| `public/db/job.json` (built by `tools/build-db.mjs` from the client GRF) | Player-class display names. Divine Pride doesn't expose a server-localized job endpoint, so the GRF's `pcjobnamegender.lub` is still the only source for strings like "Sentinela Trans". |

The build tool reads `pcjobnamegender.lub` (display) + `admin/pcidentity.lub` (server-side `JT_X → ID`). The `pcidentity.lub` is critical — Latam server uses non-standard IDs (e.g. `JT_RANGER_H = 4062`, where kRO standard says `JT_MINSTREL = 4062`).

Lua bytecode parsing walks the constant pool recursively over nested function prototypes — no Lua VM needed. The server uses a custom-magic GRF (`Event Horizon` instead of `Master of Magic`) with version `0x300` (a 4-byte gap before the file table and 21-byte entry trailers vs standard 0x200's 17 bytes). Mixed-DES-encrypted files (~31k sprites/textures) are skipped — they're irrelevant for stats.

## Caveats

- **Mob spawn names are server-side codes**, not species names. The Latam server sends placeholders like `3I8B` / `2Y8B` for instance mobs. The UI prefers Divine Pride's species name from the `view` ID and only falls back to the spawn-packet name. If Divine Pride doesn't have an entry for that view ID (custom server-only mobs), you'll see the raw code.
- **Other players' HP is hidden**: `maxHp = -1` from the server. Mob HP falls back to Divine Pride's species-level HP. Player HP just shows "—".
- **Cold-start API latency**: the first replay you load fires one Divine Pride request per unique skill / mob / item / status id. Names trickle in over a few seconds and the UI re-renders once the prefetch completes. After that, every id you've ever seen is in `localStorage` — subsequent replays are instant. Clear `localStorage` to force-refresh the cache.
- **Kill attribution heuristic**: the player whose damage event is the latest one before the mob's vanish gets credit. Mobs killed by status DoT or self-destruct that have no preceding player damage are skipped.
- **Skill-use dedup**: the server broadcasts `0x09cb` / `0x013e` twice (caster + nearby-observer broadcast). Decode collapses pairs with identical `(source, target, skillId)` within 200 ms.
- **Encryption sentinel**: skill IDs from the GRF use the Latam server's `pcidentity.lub` mapping. If you regenerate `job.json` against a different server's GRF, the player-class ID interpretation changes too.
