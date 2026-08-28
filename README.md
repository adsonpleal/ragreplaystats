# RagnaRecap

**Live: <https://recap.latam-tools.com.br/>**

Static website that parses Ragnarok Online `.rrf` replay files and shows damage / skill / kill statistics. All decoding and aggregation happen **in the browser** — the file is also stored server-side so a shareable link with a 10-char id is produced. Files >5 MB stay local and aren't uploaded.

UI is in **Brazilian Portuguese**. The decoder is server-agnostic, but the reference data (skill / mob / job names and icons) describes the Latam client and comes from [ragassets](https://github.com/adsonpleal/ragassets).

## Stack

- Vanilla TypeScript + Vite, single bundled SPA.
- `uplot` for time-series charts.
- All reference data comes from the sibling project [ragassets](https://github.com/adsonpleal/ragassets), the single place that reads the game client. Names are bundled: `tools/sync-db.mjs` reshapes its published tables into `public/db/{item,job,skill,randomopt,status}.json` and `tools/build-monsters.mjs` its `mobs.json` into `public/db/monster.json`. Icons are not bundled — item/skill/job/status PNGs load from ragassets at runtime. Nothing queries divine-pride.net.
- Cloudflare: **Workers static assets** serve the site, **D1** holds replay metadata, **R2** holds the `.rrf` bytes (≤5 MB). One Worker (`worker/index.ts`) serves `/api/*` and nothing else.

## Assets

The equipment **character viewer** (Estatísticas → Equipamento) renders the player's sprite — gear included — from [ragassets](https://github.com/adsonpleal/ragassets), a fast caching HTTP gateway that serves Ragnarok Online sprites as images/APNG on top of [zrenderer](https://github.com/zhad3/zrenderer) by [zhad3](https://github.com/zhad3), which does the actual rendering. Images come from the public instance at `https://assets.latam-tools.com.br` (`RAGASSETS_BASE` in `src/sim/ragassets.ts`, which is also where every other ragassets URL — icons, maps, effects, sounds — is built). Equipped gear maps to zrenderer view ids via each item's `ClassNum`, carried into `public/db/item.json` as `view` by `tools/sync-db.mjs`.

## Replay viewer (experimental)

The **"Assistir replay"** button opens a highly experimental 3D playback of the recording — the map, the player with gear, mobs, NPCs, floating damage, buffs and companions, driven off the replay's event streams (`src/features/replay-map/`). Its rendering pipeline — the WebGL sprite billboards, the GAT/GND/RSW/RSM map loaders, the camera and the damage-number motion — is ported from and inspired by [roBrowser](https://github.com/vthibault/roBrowser) by [vthibault](https://github.com/vthibault), a browser Ragnarok client. Many features are still missing; for the best experience, download the `.rrf` and watch it inside the game client.

## Run

```bash
npm install
npm run dev      # http://127.0.0.1:5173
npm run build    # static output in dist/
npm test         # vitest — covers the public/db transforms

# Refresh the bundled name DBs from ragassets (no game client needed):
npm run build:db         # item/job/skill/randomopt/status.json
npm run build:monsters   # monster.json
```

Run both after a LATAM client update — see `.claude/skills/sync-with-ragassets/SKILL.md` for the full workflow, including how to check the result before committing. Icons need nothing: they're fetched from ragassets at runtime, so a client update reaches them on deploy.

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

Reference **names** ship bundled under `public/db/`; **icons** are fetched from ragassets at runtime. Both come from [ragassets](https://github.com/adsonpleal/ragassets), which owns the GRF/Lua extraction for all of the LATAM tools and publishes an unopinionated projection of the client at `https://assets.latam-tools.com.br/raw/<name>.json`.

Names are bundled because a table row needs them synchronously to render, and they're small. Icons aren't: the vendored trees were 31,852 PNGs and 123 MB — and 116 MB of that was the `collection` album art, which nothing in `src/` ever referenced.

These files ship **content-hashed**. `tools/hash-db.mjs` runs after `vite build`, renames each to `<name>-<hash>.json` and writes `dist/db-manifest.json`; `src/db/manifest.ts` resolves logical names through that manifest at runtime, falling back to the unhashed name in `vite dev`. So the DBs are cached `immutable` for a year while a rebuild after a client patch still reaches everyone immediately — a changed file is a changed URL. Only the manifest itself is `no-cache`.

| Source | Contents |
|--------|----------|
| `public/db/{item,skill,randomopt,status}.json` (built by `tools/sync-db.mjs` from `/raw/{items,skills,randomopt,status}.json`) | Item names + `ClassNum` view ids, skill names, random-option templates and buff/debuff names — all pt-BR, straight from the client's Lua data tables. |
| `public/db/monster.json` (built by `tools/build-monsters.mjs` from `/raw/mobs.json`) | Monster names + HP + level, keyed by mob id. This replaces the old Divine Pride scrape. |
| `public/db/job.json` (built by `tools/sync-db.mjs` from `/raw/jobs.json` + `/raw/classes.json`) | Player-class display names, the source of strings like "Sentinela Trans". |
| `https://assets.latam-tools.com.br/icons/{item,skill,job,status}/<id>.png` (built in `src/sim/ragassets.ts`) | Icon PNGs, loaded at runtime and keyed by the same numeric id the replay packets carry. Missing ids 404 and the `<img>` hides itself. |

The naming decisions stay on this side of the split, in `tools/sync-db.mjs`: the `[N]` slot suffix on gear, the pt-BR names for the food buffs the client titles `%s`, and — for classes — `PLAYER_JT_IDS` plus `JOB_NAME_OVERRIDE`. `/raw/jobs.json` pairs a label with an id only where the server's `admin/pcidentity.lub` numbers the class, and that table stops at Oboro — no 4th class, no Rebellion, no Summoner, no Star Emperor — which is why `job.json` is built from `/raw/classes.json` (a row per playable class) as well. `pcidentity.lub` still matters because the LATAM server uses non-standard ids: `JT_RANGER_H = 4062`, where kRO says `JT_MINSTREL = 4062`. `JOB_NAME_OVERRIDE` stays on top of both: the client's own strings predate the LATAM renames (it still says "Arquimágico", "Assassino", "Poeta").

## Deploy

Hosted on **Cloudflare**; a push to `main` runs `.github/workflows/deploy.yml`, which builds and publishes via `wrangler`. To publish by hand:

```bash
npm run deploy
```

| Piece | What it holds |
|-------|---------------|
| Workers static assets (`dist/`) | The whole site. Free and unlimited — this is why hosting left Firebase. |
| `worker/index.ts` | The `/api/*` routes, and nothing else. |
| D1 `ragnarecap` | Replay metadata + MVP records (`schema.sql`). |
| R2 `ragnarecap-replays` | The `.rrf` bytes, keyed `<id>.rrf`. Egress is free. |

There is **one** Worker and it runs on **one** prefix, named by `run_worker_first: ["/api/*"]` in `wrangler.jsonc`. The array form matters: the boolean `true` puts every request on the Worker, and on the free plan a 429 once the daily request budget is spent means the homepage stops loading. Everything not listed stays a free static asset.

**Cache policy lives in `public/_headers`**, which Vite copies to the build root. Read the comment at the top before touching it: Cloudflare applies **every** matching rule and comma-joins repeated headers, so patterns must stay mutually exclusive and there must never be a `/*` catch-all. `tools/cache-headers.test.ts` holds the line, including an overlap check against a real build. No deploy needs a cache purge — everything heavy is content-hashed, so a new build means new URLs.

**Asset URLs are absolute** (`base: "/"` in `vite.config.ts`, and `/db` in `src/db/manifest.ts`). Relative URLs are not safe here: Workers assets 307s `/leaderboard` to `/leaderboard/`, from which `./assets/index-<hash>.js` resolves to `/leaderboard/assets/…`, misses, and gets answered by the SPA fallback with HTML — the browser then tries to execute HTML as a module and the app never boots. Firebase Hosting masked this with `trailingSlash: false`.

### Firebase, retired

Firestore and the Firebase Hosting site are kept, intact, as the rollback target. `firestore.rules` is closed to writes so a browser running a cached copy of the old bundle can't write replays into a collection nothing reads any more — but **editing that file changes nothing until** `firebase deploy --only firestore:rules --project ragreplaystats` runs, which is why `firebase.json` still exists with just its `firestore` block (the CLI refuses to run without one).

The 991 replays were moved with a one-shot script that is deliberately **not** in this repo — it read the world-readable `replays` collection over Firestore's public REST API and wrote D1 rows plus R2 objects. It ran once, so keeping it would have meant carrying ~250 lines of Firestore decoding, plus a plain-JS copy of the class-rename table (a `.mjs` script cannot import `.ts`), for something that will never run again. Legacy class labels are still normalized — on upload, by `normalizeClass` in `shared/replay.ts`.

## Caveats

- **Mob spawn names are server-side codes**, not species names. The Latam server sends placeholders like `3I8B` / `2Y8B` for instance mobs. The UI prefers Divine Pride's species name from the `view` ID and only falls back to the spawn-packet name. If Divine Pride doesn't have an entry for that view ID (custom server-only mobs), you'll see the raw code.
- **Other players' HP is hidden**: `maxHp = -1` from the server. Mob HP falls back to Divine Pride's species-level HP. Player HP just shows "—".
- **Cold-start API latency**: the first replay you load fires one Divine Pride request per unique skill / mob / item / status id. Names trickle in over a few seconds and the UI re-renders once the prefetch completes. After that, every id you've ever seen is in `localStorage` — subsequent replays are instant. Clear `localStorage` to force-refresh the cache.
- **Kill attribution heuristic**: the player whose damage event is the latest one before the mob's vanish gets credit. Mobs killed by status DoT or self-destruct that have no preceding player damage are skipped.
- **Skill-use dedup**: the server broadcasts `0x09cb` / `0x013e` twice (caster + nearby-observer broadcast). Decode collapses pairs with identical `(source, target, skillId)` within 200 ms.
- **Encryption sentinel**: skill IDs from the GRF use the Latam server's `pcidentity.lub` mapping. If you regenerate `job.json` against a different server's GRF, the player-class ID interpretation changes too.

## License

[MIT](LICENSE) © Adson Leal.

Third-party terms that still apply to parts of the tree:

- `src/features/replay-map/` is a port of rendering code from [roBrowser](https://github.com/vthibault/roBrowser), which is **GPL-3.0**. Reuse of that directory is governed by roBrowser's terms, not by the MIT grant above.
- `public/fonts/Galmuri11*` is [Galmuri](https://github.com/quiple/galmuri) under the SIL Open Font License 1.1 — see `public/fonts/Galmuri11.OFL-NOTICE.txt`.
- Bundled data under `public/db/` is extracted from Ragnarok Online client files and is © Gravity Co., Ltd. It ships for interoperability only and is not covered by the MIT grant.
