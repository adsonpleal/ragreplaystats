---
name: sync-with-ragassets
description: Rebuild the bundled reference data in public/db/ (item, job, skill, randomopt, status, monster) from the sibling project ragassets. Use after a LATAM client update, when an item/skill/monster shows as a raw id in the app, or when public/db/ is stale.
---

# Refresh public/db/ from ragassets

Everything under `public/db/` is derived data. This repo does **not** read the
game client — [ragassets](https://github.com/adsonpleal/ragassets) owns all GRF
and Lua extraction for the LATAM tools and publishes the result at
`https://assets.latam-tools.com.br/raw/<name>.json`. Two scripts pull those down
and reshape them into the exact files the app loads:

| Command | Writes | From |
|---|---|---|
| `npm run build:db` | `item.json`, `job.json`, `skill.json`, `randomopt.json`, `status.json` | `/raw/{items,jobs,classes,skills,randomopt,status}.json` |
| `npm run build:monsters` | `monster.json` | `/raw/mobs.json` |

- **item.json** — `{ "<id>": { name, view? } }`. `name` includes the `[N]` slot
  suffix; `view` is the client's `ClassNum`, which the character viewer needs to
  draw equipped gear.
- **job.json** — `{ "<id>": "<name>" }`, player classes only. Built from two
  tables: `jobs.json` (the client's own numbering, which covers the classic
  tree down to every baby and mounted sprite) and `classes.json` (one row per
  playable class, the only source for everything past Oboro — the 4th
  classes, Rebellion, Summoner, Star Emperor, Hyper Novice …).
- **skill.json** / **status.json** — `{ "<id>": { name } }`. status is keyed by
  EFST id (the id the status-change packets carry), used by the buff strip.
- **randomopt.json** — `{ "<id>": "<template>" }`, e.g. `"ATQM +%d"`; the UI
  fills `%d` from the replay.
- **monster.json** — `{ "<id>": { name, hp, level } }`.

**Icons need no sync at all.** The app loads them from ragassets at runtime
(`itemIconUrl` / `skillIconUrl` / `jobIconUrl` / `statusIconUrl` in
`src/sim/ragassets.ts`), so a client update reaches them the moment ragassets is
deployed — nothing to run, nothing to commit. Don't reintroduce a vendored copy.

## When to run it

After a LATAM client update, or whenever the app shows `item#1234` /
`skill#123` / `mob#4567` instead of a name. New content lands in `/raw` as soon
as ragassets is regenerated and deployed — this repo just has to pick it up and
commit the result, since the JSON is bundled into the static build.

If a name is *still* missing after a sync, the fix is upstream in ragassets (the
client tables, or `update-mob-stats` for monster stats), not here. Same for a
missing icon — but there the fix goes live on deploy, with no change here.

## Steps

```bash
npm run build:db
npm run build:monsters
npm test
git diff --stat public/db/
```

Then read the diff. **A sync that changes nothing is a valid result** — it means
ragassets hasn't been regenerated since last time. What you must never see is a
file *shrinking*: `git diff --stat` counts lines, and these are single-line
compact JSON files, so use the entry counts the scripts print instead. Current
baseline: item 13742, job 158, skill 1558, randomopt 252, status 704, monster
2732. Growth of a few dozen after a client update is normal; a collapse means
`/raw` was rebuilt from a broken client dump.

To summarize what actually changed for the changelog:

```bash
node -e "
const cp=require('child_process');
const before=JSON.parse(cp.execSync('git show HEAD:public/db/item.json').toString());
const after=require('./public/db/item.json');
const added=Object.keys(after).filter(k=>!before[k]);
const renamed=Object.keys(after).filter(k=>before[k]&&before[k].name!==after[k].name);
console.log(added.length+' new, '+renamed.length+' renamed');
console.log(added.slice(0,20).map(k=>k+' '+after[k].name).join('\n'));
console.log(renamed.slice(0,20).map(k=>k+': '+before[k].name+' → '+after[k].name).join('\n'));
"
```

### Finishing up

Bump `version` in `package.json` and add a dated section at the
top of `CHANGELOG.md` — the deploy workflow only announces on Discord when the
version changes, and it posts that top section verbatim. Write it for players in
pt-BR ("**85 itens novos**…"), not for developers. Check the payload with
`node tools/post-novidades.mjs --dry-run`.

## Verifying a change to the transforms

The transforms live in `tools/sync-db.mjs` and are covered by
`tools/sync-db.test.mjs` against committed fixtures (`tools/__fixtures__/raw/`).
Tests never hit the network on purpose — a test that fetched `/raw` would go red
on a client update, which is exactly when it needs to be trustworthy.

When you change a transform, the real acceptance test is that re-running it
against **unchanged** input produces **zero** `git diff`. Against a local
ragassets checkout:

```bash
node tools/sync-db.mjs --input ../ragassets/resources/raw
node tools/build-monsters.mjs --input ../ragassets/resources/raw/mobs.json
git diff --stat public/db/   # must be empty
```

`--input` takes the directory for `sync-db.mjs` and the file for
`build-monsters.mjs` (it predates the split and syncs a single table).

## Gotchas

- **`/raw` is deliberately unopinionated, so the curation lives here.** The `[N]`
  slot suffix, `FOOD_STATUS_NAMES`, `PLAYER_JT_IDS` and `JOB_NAME_OVERRIDE` are
  RagnaRecap's editorial choices and must not be pushed upstream — other
  consumers of `/raw` want different ones.
- **`/raw/items.json` has ~640 rows with `name: null`.** They still carry a
  `view`, so they look real. They're dropped: the app has nothing to display for
  an item with no name, and keeping them would put `{"name":null}` in the bundle.
- **`name` in `/raw` is bare — no `[3]`.** If item names suddenly lose their slot
  counts, the suffix rebuild in `buildItems` is what broke.
- **`/raw/jobs.json` stops at Oboro.** It pairs a label with an id only where the
  server's `admin/pcidentity.lub` numbers the class, and that table numbers no
  4th class, no Rebellion, no Summoner, no Star Emperor. `classes.json` is what
  fills the gap — a row per playable class — so a new class reaching `/raw` now
  lands in `job.json` on the next sync with no table to edit here. What still
  has to be pinned is the *name*: `JOB_NAME_OVERRIDE` keeps ours where the
  client's predates the LATAM renames (it still says "Arquimágico", "Assassino",
  "Poeta", "Patrulheiro", "Ladino") and supplies one for Shinkiro and Shiranui,
  which the client never labels in any language.
- **Key classes by `renderId`, not `id`.** `classes.json` carries both, and they
  differ for the seven expanded 4th classes (Sky Emperor … Spirit Handler):
  `renderId` (4302-4308) is the id the class packets and the party icons use —
  the one the app looks up — while `id` (4309-4315) is the always-mounted
  sprite. Both get named, pointing at the same class.
- **`PLAYER_JT_IDS` still owns the derived sprites.** `classes.json` lists the 85
  canonical classes only, so the baby/trans/mounted ids that share a class come
  from there: the mounted 4th classes are 4278-4281 (`JT_WINDHAWK2`,
  `JT_MEISTER2`, `JT_DRAGON_KNIGHT2`, `JT_IMPERIAL_GUARD2`) — **not** 4302-4308,
  which they were wrongly pinned to until the expanded branch showed up and
  claimed that block.
- **`PLAYER_JT_IDS` is a fallback, never an override.** LATAM's `pcidentity.lub`
  disagrees with the kRO defaults on real ids (`JT_RUNE_KNIGHT_H` is 4060 there,
  4067 in kRO), and `/raw` carries the server's answer. An id from
  `PLAYER_JT_IDS` is only used for a `JT_` name `/raw` doesn't mention at all.
- **The status food buffs are titled `%s` in the client** (it substitutes the
  food item name at runtime), which is why `FOOD_STATUS_NAMES` is applied on top
  of the parsed table rather than merged into it.
- **Names are bundled, icons are not — and that asymmetry is deliberate.** The
  name tables are small, needed synchronously to render a row, and must work
  from cache. The icon trees are 31,852 files and 123 MB, which has no business
  in a git repo or a static build — and 116 MB of that was `collection` album
  art no call site ever used. If you find yourself adding a `public/icons/`
  again, the answer is a URL in `src/sim/ragassets.ts`.
- **Icon ids are the ids the packets carry, and the trees don't interchange.**
  `item` is keyed by **item id**, not the sprite `view` — `view` is for the
  character viewer's `/image` params. `job` is keyed by the job/view id an
  entity reports. Getting those backwards 404s silently, since every icon
  renders through an `onError` that just hides the `<img>`.
- **A missing icon is invisible, not broken.** Every call site hides the image on
  error, so an id the client ships no art for renders as text with no gap. That
  was already true when the icons were bundled; the only change is that the 404
  now comes from the CDN.
