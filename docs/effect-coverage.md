# RO effect coverage report (survey phase)

_Goal: render every visual the real client emits in the RagnaRecap replay viewer, sourced
from client files (GRF + EXE) with roBrowser as a cross-reference. This is the phase-1 survey:
what exists, where it lives, what's renderable today, and a phased plan. No viewer code was
changed._

Companion data: [`effect-coverage-data.json`](effect-coverage-data.json) (per-tier effect-id
lists). Sources analyzed: the 2025-07-16 Ragexe (RTTI intact), the extracted GRF lua tables
(`ragassets/_scratch/alllubs/…`), roBrowser's `EffectManager` + `EffectTable.js`, and the
current ragassets `/effect/*` mirror.

## Progress (updated as phases land)

- **Phase 0 — pipeline honesty (ragassets): DONE.** `gen-effect-tables.mjs` no longer drops
  FUNC bodies — each FUNC part gets a stable `func` dispatch name and the sources are lifted
  into `effect_funcs.json`; `effect_provenance.json` tags every id's origin.
- **Phase 1 — data-driven renderers (viewer): 3D + 2D + SPR DONE.**
  - `src/sim/render/threeDEffect.ts` renders the "3D" billboard-particle type (~117 ids) and
    the "2D" overlay variant (6 ids), loaded/expanded by `loadThreeDEntry` (duplicate stagger,
    random jitter, circlePattern). Verified on the golden stage (effect 37 Improve
    Concentration; effect 1 EF_HIT lens burst).
  - `src/sim/render/sprAnimEffect.ts` renders the "SPR" played-sprite type (69 ids) as a
    frame-swapping billboard, from the gateway's `/effects/sprites/<key>/` bundles.
    `loadSprEntry` resolves an id to its bundle (`eff_<id>`, else a legacy alias). Verified on
    effect 165 (banjjakii). The gateway now builds a bundle per SPR id (extract-grf.mjs
    `sprites/eff_<id>/`, verified byte-identical to the proven build); **full 69-id coverage
    needs one `--effects` run + deploy.**
  - **Remaining data-driven: QuadHorn (4 ids, pyramid mesh), RSM (19, 3D models).**
- **Phases 2–4 — FUNC procedurals (cast circle, auras), EXE deep-dive, cast/EFST/aura wiring:
  not started.**

---

## TL;DR

- **The client EXE gives us the authoritative effect-class inventory for free.** RTTI is
  plaintext: **91 `CEffectAllocator<V…>`-registered effect classes** and **137 effect-ish
  RTTI classes** total, recovered with a string scan — no disassembler needed. Every
  procedural effect is a named C++ class (`CMeteorEffect`, `CJupitelThunderHit`,
  `CLevel99Effect`, …). Ghidra is only needed later to read each class's *math*, not to find
  them.
- **The "97 3D effects need reverse-engineering" framing was pessimistic.** The 3D/2D/SPR/
  QuadHorn/RSM buckets (**≈180 effect ids**) are **data-driven**: each is one row of params
  fed to a *single* renderer. roBrowser already has all five renderers + shaders and the
  params are already in our table. **Five generic renderers unlock ~180 ids with zero RE.**
- **The real RE/recovery work is two buckets:** `FUNC` (100 ids, bespoke procedural logic)
  and `?`/unknown (212 ids roBrowser never mapped). And even most FUNC ids are *not* blocked
  on the EXE — see the next point.
- **The JSON mirror silently dropped every FUNC `func` body.** roBrowser's `EffectTable.js`
  source (present in `ragassets/_scratch/EffectTable.js`) contains **90 FUNC closures** that
  instantiate procedural renderers in `roBrowserLegacy/src/Renderer/Effects/*.js`
  (`LockOnTarget` = the cast circle, `GroundAura`, `Level99Bubble`, `MagicRing`,
  `SpiritSphere`, …). Our gateway generator serialized the table to JSON, which cannot hold a
  function — so all 100 FUNC rows arrive param-less. **Re-capturing those 90 bodies from
  source recovers most FUNC effects without touching the EXE.** The EXE remains ground truth
  for the ~10 FUNC ids roBrowser never wrote and for validating the ported math.

---

## What lives where (verified)

### Client EXE — `2025-07-16_Ragexe_175220998_clientinfo.exe`
- PE32 x86, MSVC, 16 MB, **not packed** (`.text` entropy 5.92; the `.lotus`/`.xdiff`
  sections are WARP diff-patch artifacts, not protectors). Confirmed via `_scratch/pe.mjs`.
- **RTTI intact.** `_scratch/rtti_effects.mjs` scans the mangled type-descriptor strings:
  - **91** `CEffectAllocator@V<Class>@@` registrations — the effects the client actually
    instantiates. Full list in the scanner output; anchors present: STR (`CEZ2STREffect`,
    `CEZ2STREffectEx`), `CCylinderEffect`, auras (`CLevel99Effect`, `CLevel99Orb1/2Effect`,
    `CLevel150Effect`, `CLevel150SubEffect`), and the procedural bucket (`CMagicFloorEffect`,
    `CFullScreenEffect`, `CEmitterEffect`/`CAnimatedEmitterEffect`, `CFootprintEffect`/
    `CFootprintStrEffect`, `CHealEffect`, `CMeteorEffect`, `CJupitelThunderHit`/
    `CJupitelThunderStormEffect`, `CGaleStorm`, `CAstralStrikeEffect`, `CClimaxEffect`,
    `CCloudKillEffect`/`CNewCloudKillEffect`, `CAcidifiedThrow`, `CCartCannon`,
    `CAxeBoomerang`, …).
  - **137** effect-ish plain RTTI classes total (superset incl. non-allocated helpers and
    `CSkillAction_*`/`CSkillObjectAction_*` per-skill action classes).
  - **2215** total RTTI type descriptors in the binary.
- So the EXE is the authoritative source for: the skill/effectId → effect-class **dispatch**,
  each class's **procedural math**, and the **param tables** roBrowser only partially
  transcribed. The class *names* are already recovered; the dispatch table and per-class math
  are the Ghidra deep-dive (phase 3, task #3).

### GRF lua (`_scratch/alllubs/data/luafiles514/lua files/`)
- `skilleffectinfo/effectid.lub` → `EFID` = **149** `EF_*` name→id constants (a *subset*; the
  full ~752-entry `EFID` enum lives in the EXE).
- `skilleffectinfo/skilleffectinfolist.lub` → decompiles to only a default entry; the client
  scripts effect lists for **~66** skills here, the rest are dispatched in EXE code. **Not a
  useful skill→effect source on its own.**
- `stateicon/*` (`efstids.lub`, `stateiconinfo*.lub`) → EFST status metadata (already used by
  the buff strip; the pt-BR names pipeline). This is the hook for **EFST→actor buff visuals**.
- `effecttool/*.lub` → **per-map ambient** effect placements (keyed by map name, e.g.
  `1@inq`), **not** per-skill. Relevant only for map-scene ambiance, not skill effects.

### roBrowser (`MrAntares/roBrowserLegacy`) — the porting accelerator
- `src/Renderer/EffectManager.js` dispatches on `effect.type` to exactly one renderer each:
  `SPR → spamSprite`, `STR → spamSTR`, `CYLINDER → Cylinder`, `2D → TwoDEffect`,
  `3D → ThreeDEffect`, `RSM/RSM2 → RsmEffect`, `QuadHorn → QuadHorn`,
  `FUNC → effect.func(Params)`.
- `src/Renderer/Effects/*.js` (+ `.vs`/`.fs` shaders) — the procedural renderers the FUNC
  bodies call: `LockOnTarget`, `GroundAura`, `SwirlingAura`, `Level99Bubble`, `MagicRing`,
  `MagicTarget`, `MagnumBreak`, `SpiritSphere`, `WarlockSphere`, `PropertyGround`,
  `SpiderWeb`, `RsmEffect`, `ThreeDEffect`, `TwoDEffect`, `QuadHorn`, weather effects, etc.
- `src/DB/Effects/EffectTable.js` — the hand-written param DB **including the 90 FUNC
  closures** the JSON mirror dropped. Copy in `ragassets/_scratch/EffectTable.js`.

---

## Current coverage (ragassets `/effect/*` mirror = roBrowser)

`skill_map.json`: **488 skills** — 420 with `effectId`, 71 with `hitEffectId`, 51 with
`groundEffectId`.
`effect_table.json`: **752 effect ids**, 1127 parts.

### Effect ids by renderer tier (752 total)

| Tier | ids | Meaning | Renderer status |
|------|----:|---------|-----------------|
| **now** | 261 | all parts are STR / CYLINDER | ✅ rendered today |
| **data** | 179 | needs 3D / 2D / SPR / QuadHorn / RSM (all data-driven) | ⚙️ 5 generic renderers, no RE |
| **func** | 100 | bespoke procedural (`FUNC`) | 🔬 90 recoverable from roBrowser source, ~10 EXE-only |
| **unknown** | 212 | ≥1 part typed `?` (roBrowser never mapped) | ❓ needs EXE/GRF recovery |

Distinct-id part-type histogram: STR 251, CYLINDER 56, 3D 117, SPR 69, RSM 19, 2D 6,
QuadHorn 4, FUNC 100, `?` 219.

### Skills by their main `effectId`'s tier (of the 420 with one)

| Tier of main effect | skills |
|---------------------|-------:|
| now (renders today) | 149 |
| data (generic renderers) | 43 |
| func (procedural) | 20 |
| unknown (`?`) | 100 |
| **dangling** (effectId declared, **no** table entry) | 108 |

The **108 dangling** skills are the Oratio→755 case generalized: a skill maps to an effect id
that has no `EffectTable` row anywhere. These are *false* coverage in the current mirror —
they resolve to an id and then render nothing. Recovering them needs the EXE's real
skill→effectId dispatch + the effect's params.

> Caveat: 488 skills is *roBrowser's* universe. The client knows many more (most 4th-job),
> which is why the two test recordings show 9–14 unmapped casts. The EXE `EFID` enum + dispatch
> is the only complete source; expanding past 488 skills is inherently an EXE job.

---

## Reframed effort model

The mission's "~97 3D ids + reverse ~97 classes" over-counts the RE. Reality:

1. **Data-driven (≈180 ids, 0% RE):** port 5 renderers once (`ThreeDEffect`, `TwoDEffect`,
   `QuadHorn`, `RsmEffect`, sprite-anim), reuse existing params. This is the single biggest
   coverage win and needs no EXE work.
2. **FUNC (100 ids, ~90% from source):** re-capture the 90 dropped closures + port the ~15
   `Renderer/Effects/*.js` classes they reference. EXE only for the ~10 unwritten ones and to
   validate math.
3. **Unknown/dangling (212 + 108, the actual RE frontier):** these are where the EXE + GRF
   *earn their keep* — recover real params/dispatch roBrowser never had. Highest effort,
   highest novelty, do last and incrementally per skill.

RE (Ghidra) is therefore concentrated on buckets #2-tail and #3, not on the bulk of "3D".

---

## Phased plan

**Phase 0 — pipeline honesty (ragassets, small, do first).** Fix the generator so FUNC
`func` bodies aren't dropped: emit a stable `func` **tag/name** per FUNC id (e.g.
`"lockOnTarget"`) instead of silently blanking it, so the viewer can dispatch. Add
provenance tags (`client-lua` / `exe` / `roBrowser` / `curated`) to every entry. This unblocks
FUNC and makes later EXE-sourced overrides auditable. → task #4.

**Phase 1 — generic renderers (viewer, biggest win).** Implement `ThreeDEffect` and
`TwoDEffect` (billboard particle systems) first — they cover the most ids and share one
particle core — then `QuadHorn`, sprite-anim (`SPR`, reuses our GRF sprite loader), and
`RsmEffect` last (3D models, niche). Golden board per type. → task #5.

**Phase 2 — FUNC procedurals (viewer + ragassets).** Port the high-value classes behind the
90 closures, prioritized by the two test recordings: **`LockOnTarget` (cast circle)**,
`GroundAura` + `Level99Bubble`/`Level150` (level/job auras), `MagicRing`/`MagicTarget`
(cast auras), `SpiritSphere`/`WarlockSphere`, `PropertyGround`. Validate each against the
client via the golden harness. → tasks #5/#6.

**Phase 3 — EXE deep-dive (Ghidra).** Recover (a) the **skillId→effectId dispatch** (fixes
the 108 dangling + extends past 488 skills, esp. 4th-job), (b) the **EFST→effect wiring** for
buff visuals, and (c) the procedural math for the EXE-only FUNC classes and any `?` ids we
choose to chase. Use WARP0716 signatures + Hercules/roBrowser as maps. → task #3.
_(Ghidra 12.1.2 + JDK 21 are being staged under `C:\Users\adson\dev\retools` for this.)_

**Phase 4 — new wiring (viewer).** Cast-start effects (cast circle + per-skill cast auras
during the cast bar), EFST-driven persistent buff visuals on actors, and 99/150/175 level
auras on spawn. Validate on `?r=wGzeHZtz5w` and `?r=FkxCnJJ4K4` until every cast shows its
authentic visual or is verified to emit nothing. → task #6.

**Ordering rationale:** Phase 1 maximizes visible coverage per unit effort with no RE risk;
Phase 0 must precede Phase 2; Phase 3 (the hard RE) is deferred until the cheap wins are
banked and gates only the dangling/unknown long tail. Honor the standing directives: **no
generic fallback** (unknown → draw nothing), and **groundEffectId renders only on a real
0x09ca unit**.
