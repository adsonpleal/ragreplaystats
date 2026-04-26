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
if (process.argv.includes("--containers")) {
  console.log(JSON.stringify(mod.inspectContainers(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), null, 2));
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
