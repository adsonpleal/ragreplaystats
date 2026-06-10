#!/usr/bin/env node
// Quick CLI smoke test: parse rag_test.rrf and print a session summary.
// Usage: node tools/smoke.mjs [path/to/replay.rrf]

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "vite";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const file = resolve(args[0] ?? "rag_test.rrf");
const buf = await readFile(file);

// Bundle the decoder for Node consumption.
const result = await build({
  configFile: false,
  logLevel: "error",
  build: {
    write: false,
    target: "node18",
    lib: {
      entry: resolve("src/rrf/decode.ts"),
      formats: ["es"],
      fileName: () => "decode.mjs",
    },
    rollupOptions: { external: [] },
  },
});

const out = Array.isArray(result) ? result[0] : result;
const code = out.output[0].code;
const dataUrl = "data:text/javascript;base64," + Buffer.from(code).toString("base64");
const mod = await import(dataUrl);

const replay = mod.decodeReplay(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

if (process.argv.includes("--raw")) {
  const id = Number(process.argv[process.argv.indexOf("--raw") + 1]);
  console.log(`Looking for packet 0x${id.toString(16)}...`);
  const containers = mod.inspectContainers(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const ps = containers.find((c) => c.type === 1);
  let count = 0;
  if (ps) {
    for (const ch of ps.chunkPreview) {
      const bytes = ch.first16.split(" ").map((h) => parseInt(h, 16));
      if (bytes.length < 2) continue;
      const pid = bytes[0] | (bytes[1] << 8);
      if (pid !== id) continue;
      count++;
      if (count > 50) break;
      console.log(`  len=${bytes.length} bytes=${ch.first16}`);
    }
  }
  console.log(`Total packets with id 0x${id.toString(16)}: ${count}`);
  process.exit(0);
}
if (process.argv.includes("--stats")) {
  console.log("Initial inventory size:", replay.initialInventory.size);
  const ii = [...replay.initialInventory.entries()].sort((a, b) => a[0] - b[0]);
  for (const [slot, v] of ii) console.log("  slot", slot, "=>", v);
  console.log("\nitemDeletes:", replay.itemDeletes.length);
  for (const d of replay.itemDeletes.slice(0, 15)) console.log(" ", d);
  console.log("\nitemAdds:", replay.itemAdds.length);
  for (const a of replay.itemAdds.slice(0, 5)) console.log(" ", a);
  console.log("\nparamChanges:", replay.paramChanges.length);
  const types = new Map();
  for (const p of replay.paramChanges) types.set(p.type, (types.get(p.type) ?? 0) + 1);
  console.log("  by type:", [...types.entries()].sort((a, b) => a[0] - b[0]).map(([t, c]) => `${t}:${c}`).join(" "));
  console.log("\nstatusEvents:", replay.statusEvents.length);
  const buffs = new Map();
  for (const s of replay.statusEvents) {
    if (s.aid === replay.sessionInfo.aid) buffs.set(s.statusId, (buffs.get(s.statusId) ?? 0) + 1);
  }
  console.log("  on local player by statusId:", [...buffs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, c]) => `${id}:${c}`).join(" "));
  process.exit(0);
}
if (process.argv.includes("--equip-changes")) {
  console.log("equipChanges:", replay.equipChanges.length);
  for (const e of replay.equipChanges) {
    console.log(
      `  t=${e.time}ms ${e.equipped ? "WEAR   " : "TAKEOFF"} slot=${e.slot} loc=0x${e.location.toString(16)} item=${e.itemId} +${e.refine} cards=[${e.cards}]`,
    );
  }
  process.exit(0);
}
if (process.argv.includes("--skill-events")) {
  const skillId = Number(process.argv[process.argv.indexOf("--skill-events") + 1]);
  console.log(`Looking for skill id=${skillId}`);
  console.log("\n— skillUses —");
  for (const u of replay.skillUses) {
    if (u.skillId === skillId) console.log(`  t=${u.time}ms src=${u.source} dst=${u.target} lvl=${u.skillLevel}`);
  }
  console.log("\n— damage events —");
  for (const d of replay.damage) {
    if (d.skillId === skillId) console.log(`  t=${d.time}ms src=${d.source} dst=${d.target} dmg=${d.damage} hits=${d.hits}`);
  }
  console.log("\n— skillCasts —");
  for (const c of replay.skillCasts) {
    if (c.skillId === skillId) console.log(`  t=${c.time}ms src=${c.source} dst=${c.target} cast=${c.castMs}ms`);
  }
  process.exit(0);
}
if (process.argv.includes("--entities-detail")) {
  for (const e of [...replay.entities.values()].sort((a,b) => a.aid - b.aid)) {
    console.log(`AID=${e.aid} kind=${e.kind} name="${e.name}" view=${e.view} lvl=${e.level} maxHP=${e.maxHp} HP=${e.lastHp} boss=${e.isBoss}`);
  }
  process.exit(0);
}
if (process.argv.includes("--items-raw")) {
  // Dump every chunk in the Items container so we can spot non-172 records.
  const containers = mod.inspectContainers(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const items = containers.find(c => c.type === 8);
  if (!items) {
    console.log("No Items container.");
    process.exit(0);
  }
  console.log(`Items container: ${items.chunkPreview.length} chunks, declaredLength=${items.declaredLength}`);
  for (const ch of items.chunkPreview) {
    const len = ch.length;
    console.log(`  chunk id=${ch.id} length=${len} ${len % 172 === 0 ? "(divides 172)" : `(remainder ${len % 172} of 172)`}`);
  }
  process.exit(0);
}
if (process.argv.includes("--after-kill")) {
  const aid = replay.sessionInfo.aid;
  const playerKills = [];
  for (const k of replay.kills) {
    let lastSrc = 0, lastTime = -1;
    for (const d of replay.damage) {
      if (d.target !== k.aid || d.time > k.time) continue;
      if (d.time > lastTime) { lastTime = d.time; lastSrc = d.source; }
    }
    if (lastSrc === aid) playerKills.push(k);
  }
  const stream = mod.inspectPacketStream(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  console.log(`Player kills: ${playerKills.length}, total stream packets: ${stream.length}`);
  for (const k of playerKills.slice(0, 5)) {
    console.log(`\n=== kill at ${k.time}ms (mob aid=${k.aid}) ===`);
    const window = stream.filter(p => p.time >= k.time && p.time <= k.time + 800);
    for (const p of window) {
      const idHex = "0x" + p.id.toString(16).padStart(4, "0");
      console.log(`  +${(p.time - k.time).toString().padStart(4)}ms  ${idHex}  len=${p.len}  ${p.hex.slice(0, 80)}${p.hex.length > 80 ? "..." : ""}`);
    }
  }
  process.exit(0);
}
if (process.argv.includes("--player-dmg")) {
  const aid = replay.sessionInfo.aid;
  const breakdown = new Map();
  const actionByType = new Map();
  for (const ev of replay.damage) {
    if (ev.source !== aid) continue;
    breakdown.set(ev.hitType, (breakdown.get(ev.hitType) ?? 0) + 1);
    const k = `${ev.hitType}@action=${ev.rawAction}`;
    actionByType.set(k, (actionByType.get(k) ?? 0) + 1);
  }
  console.log("Player damage hit-type breakdown:");
  for (const [t, c] of breakdown) console.log(`  ${t}: ${c}`);
  console.log("\nBy (hitType, rawAction):");
  for (const [k, c] of actionByType) console.log(`  ${k}: ${c}`);
  console.log("\nSample misses:");
  let n = 0;
  for (const ev of replay.damage) {
    if (ev.source !== aid || ev.hitType !== "miss") continue;
    console.log(`  t=${ev.time} target=${ev.target} skill=${ev.skillId} dmg=${ev.damage} action=${ev.rawAction} hits=${ev.hits}`);
    if (++n >= 5) break;
  }
  console.log("\nSample crits:");
  n = 0;
  for (const ev of replay.damage) {
    if (ev.source !== aid || ev.hitType !== "critical") continue;
    console.log("  ", ev);
    if (++n >= 5) break;
  }
  console.log("\nSample normal:");
  n = 0;
  for (const ev of replay.damage) {
    if (ev.source !== aid || ev.hitType !== "normal") continue;
    console.log("  ", ev);
    if (++n >= 5) break;
  }
  process.exit(0);
}
if (process.argv.includes("--items-deep")) {
  // Walk every record in every chunk of the Items container, using
  // recSize=172, and print pos/qty/nameid for each — including ones the
  // current parser skips (qty<=0 or pos<0).
  const containers = mod.inspectContainers(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const items = containers.find(c => c.type === 8);
  if (!items) {
    console.log("No Items container.");
    process.exit(0);
  }
  for (const ch of items.chunkPreview) {
    if (ch.length < 172) continue;
    const bytes = ch.first16.split(" ").map(h => parseInt(h, 16));
    console.log(`\n--- chunk id=${ch.id} length=${ch.length} ---`);
    for (let p = 0; p + 172 <= bytes.length; p += 172) {
      const rawPos = (bytes[p + 22] | (bytes[p + 23] << 8));
      const pos = rawPos - 2;
      const qty = (bytes[p + 52] | (bytes[p + 53] << 8));
      const nameid = bytes[p + 104] | (bytes[p + 105] << 8) | (bytes[p + 106] << 16) | (bytes[p + 107] << 24);
      console.log(`  rec ${(p/172)|0}: rawPos=${rawPos} pos=${pos} qty=${qty} nameid=${nameid}`);
    }
  }
  process.exit(0);
}
if (process.argv.includes("--items-search")) {
  // Search all chunks of the Items container for slots > 50 (anything that
  // could be slot 65). Tries 172, 168, and a couple of nearby record sizes.
  const containers = mod.inspectContainers(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const items = containers.find(c => c.type === 8);
  if (!items) {
    console.log("No Items container.");
    process.exit(0);
  }
  for (const ch of items.chunkPreview) {
    const bytes = ch.first16.split(" ").map(h => parseInt(h, 16));
    console.log(`\n--- chunk id=${ch.id} length=${ch.length} ---`);
    // Look at first 200 bytes of the chunk: candidate "pos" fields are at offsets
    // 22, 22, 22 + 172, 22 + 168, 22 + 176, ...
    for (const recSize of [172, 168, 176, 180]) {
      let count = 0;
      const slots = [];
      for (let p = 0; p + 100 <= bytes.length; p += recSize) {
        const pos = (bytes[p + 22] | (bytes[p + 23] << 8)) - 2;
        if (pos >= 0 && pos < 200) slots.push(pos);
        count++;
        if (count > 80) break;
      }
      if (slots.length) {
        console.log(`  recSize=${recSize}: slots=${slots.slice(0, 30).join(",")}${slots.length > 30 ? "..." : ""}`);
      }
    }
  }
  process.exit(0);
}
if (process.argv.includes("--containers")) {
  console.log(JSON.stringify(mod.inspectContainers(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), null, 2));
  process.exit(0);
}
if (process.argv.includes("--all-damage")) {
  for (const ev of replay.damage) {
    const s = replay.entities.get(ev.source);
    const t = replay.entities.get(ev.target);
    const sLbl = s ? `${s.kind} ${s.name} view=${s.view}` : "?";
    const tLbl = t ? `${t.kind} ${t.name} view=${t.view}` : "?";
    console.log(
      `  t=${ev.time.toString().padStart(6)}ms src=${ev.source} (${sLbl}) → dst=${ev.target} (${tLbl}) skill=${ev.skillId} dmg=${ev.damage} type=${ev.hitType} via=${ev.source_packet}`,
    );
  }
  process.exit(0);
}
if (process.argv.includes("--entities")) {
  console.log(JSON.stringify(mod.inspectEntityPackets(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), null, 2));
  process.exit(0);
}
if (process.argv.includes("--session")) {
  const containers = mod.inspectContainers(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const session = containers.find(c => c.type === 3);
  console.log(JSON.stringify(session, null, 2));
  process.exit(0);
}
if (process.argv.includes("--findvalue")) {
  // Scan every container chunk for occurrences of the given u32 LE value.
  const target = Number(process.argv[process.argv.indexOf("--findvalue") + 1]);
  const containers = mod.inspectContainers(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  // Need raw chunk bytes — use replay
  const replay = mod.decodeReplay(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  // Re-decode raw via inspectContainers... but inspectContainers only returns previews.
  // Use built-in raw access: decode via header+keys directly.
  const hdr = mod.readHeader ? mod.readHeader(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)) : null;
  // Fallback: simpler approach — call readContainers directly if exposed.
  // Easiest: just print the result of looking through inspectContainers
  console.log(`Looking for u32 LE value ${target} (0x${target.toString(16)})`);
  console.log("Container types found:", containers.map(c => c.type).join(", "));
  console.log("Note: we only have previews. Re-add raw access if you need to grep across all bytes.");
  void replay;
  process.exit(0);
}

console.log("Session info:", replay.sessionInfo);
console.log("Entities seen:", replay.entities.size);
console.log("Damage events:", replay.damage.length);
console.log("Kills:", replay.kills.length);
console.log("Skill casts:", replay.skillCasts.length);
console.log("Skill uses:", replay.skillUses.length);
console.log("Map changes:", replay.mapChanges.length);
console.log("Mob HP updates:", replay.mobHp.length);
console.log("Packets parsed:", `${replay.totals.handledPackets} / ${replay.totals.packetCount}`);
console.log("Distinct packet IDs:", replay.totals.knownPacketIds.map((i) => i.toString(16).padStart(4, "0")).join(", "));

// Top-line counts per entity kind
const kindCounts = new Map();
for (const e of replay.entities.values()) {
  kindCounts.set(e.kind, (kindCounts.get(e.kind) ?? 0) + 1);
}
console.log("Entity kinds:", Object.fromEntries(kindCounts));

// First few damage events
console.log("\nFirst 5 damage events:");
for (const ev of replay.damage.slice(0, 5)) {
  console.log(
    `  t=${ev.time}ms src=${ev.source} dst=${ev.target} skill=${ev.skillId} dmg=${ev.damage} type=${ev.hitType} via=${ev.source_packet}`,
  );
}

console.log("\nTop 10 most-hit targets:");
const hitMap = new Map();
for (const ev of replay.damage) hitMap.set(ev.target, (hitMap.get(ev.target) ?? 0) + 1);
const ranked = [...hitMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
for (const [aid, hits] of ranked) {
  const e = replay.entities.get(aid);
  console.log(`  ${aid} (${e?.kind ?? "?"} ${e?.name ?? ""} view=${e?.view ?? 0}) hits=${hits}`);
}
