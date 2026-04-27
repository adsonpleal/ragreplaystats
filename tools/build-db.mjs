#!/usr/bin/env node
// Extract player-class display names from a Ragnarok Online GRF and emit
// public/db/job.json. Other reference data (skills, mobs, items, status
// effects) comes from the Divine Pride API at runtime — see
// src/divine-pride.ts.
//
// Usage:
//   node tools/build-db.mjs --grf <file.grf>           # build from GRF
//   node tools/build-db.mjs --dir <folder>             # from extracted folder
//   node tools/build-db.mjs --list <file.grf>          # print listing
//   node tools/build-db.mjs --grf <file.grf> --extract <dir> [--match <regex>]
//   node tools/build-db.mjs --dump <file.grf>::<path>  # dump one file

import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { inflateSync } from "node:zlib";

const WANTED_FILES = [
  "data/luafiles514/lua files/datainfo/jobname.lub",
  "data/luafiles514/lua files/datainfo/jobname.lua",
  "data/luafiles514/lua files/datainfo/npcidentity.lub",
  "data/luafiles514/lua files/datainfo/npcidentity.lua",
  "data/luafiles514/lua files/datainfo/pcjobnamegender.lub",
  "data/luafiles514/lua files/datainfo/pcjobnamegender.lua",
  "data/luafiles514/lua files/admin/pcidentity.lub",
  "data/luafiles514/lua files/admin/pcidentity.lua",
];

// kRO-default JT name → numeric id, used as a fallback when the server's own
// pcidentity.lub doesn't list a class.
const PLAYER_JT_IDS = {
  JT_NOVICE: 0, JT_SWORDMAN: 1, JT_MAGICIAN: 2, JT_ARCHER: 3,
  JT_ACOLYTE: 4, JT_MERCHANT: 5, JT_THIEF: 6, JT_KNIGHT: 7,
  JT_PRIEST: 8, JT_WIZARD: 9, JT_BLACKSMITH: 10, JT_HUNTER: 11,
  JT_ASSASSIN: 12, JT_KNIGHT2: 13, JT_CRUSADER: 14, JT_MONK: 15,
  JT_SAGE: 16, JT_ROGUE: 17, JT_ALCHEMIST: 18, JT_BARD: 19,
  JT_DANCER: 20, JT_CRUSADER2: 21, JT_WEDDING: 22, JT_SUPERNOVICE: 23,
  JT_GUNSLINGER: 24, JT_NINJA: 25, JT_TAEKWON: 4046, JT_STAR_GLADIATOR: 4047,
  JT_STAR_GLADIATOR2: 4048, JT_SOUL_LINKER: 4049,
  JT_NOVICE_H: 4001, JT_SWORDMAN_H: 4002, JT_MAGICIAN_H: 4003,
  JT_ARCHER_H: 4004, JT_ACOLYTE_H: 4005, JT_MERCHANT_H: 4006,
  JT_THIEF_H: 4007, JT_KNIGHT_H: 4008, JT_PRIEST_H: 4009,
  JT_WIZARD_H: 4010, JT_BLACKSMITH_H: 4011, JT_HUNTER_H: 4012,
  JT_ASSASSIN_H: 4013, JT_KNIGHT2_H: 4014, JT_CRUSADER_H: 4015,
  JT_MONK_H: 4016, JT_SAGE_H: 4017, JT_ROGUE_H: 4018,
  JT_ALCHEMIST_H: 4019, JT_BARD_H: 4020, JT_DANCER_H: 4021,
  JT_CRUSADER2_H: 4022,
  JT_RUNE_KNIGHT: 4054, JT_WARLOCK: 4055, JT_RANGER: 4056,
  JT_ARCH_BISHOP: 4057, JT_MECHANIC: 4058, JT_GUILLOTINE_CROSS: 4059,
  JT_ROYAL_GUARD: 4060, JT_SORCERER: 4061, JT_MINSTREL: 4062,
  JT_WANDERER: 4063, JT_SURA: 4064, JT_GENETIC: 4065, JT_SHADOW_CHASER: 4066,
  JT_RUNE_KNIGHT_H: 4067, JT_WARLOCK_H: 4068, JT_RANGER_H: 4069,
  JT_ARCH_BISHOP_H: 4070, JT_MECHANIC_H: 4071, JT_GUILLOTINE_CROSS_H: 4072,
  JT_ROYAL_GUARD_H: 4073, JT_SORCERER_H: 4074, JT_MINSTREL_H: 4075,
  JT_WANDERER_H: 4076, JT_SURA_H: 4077, JT_GENETIC_H: 4078,
  JT_SHADOW_CHASER_H: 4079,
  JT_RUNE_KNIGHT2: 4080, JT_RUNE_KNIGHT_H2: 4081,
  JT_ROYAL_GUARD2: 4082, JT_ROYAL_GUARD_H2: 4083,
  JT_RANGER2: 4084, JT_RANGER_H2: 4085,
  JT_MECHANIC2: 4086, JT_MECHANIC_H2: 4087,
  JT_DRAGON_KNIGHT: 4252, JT_MEISTER: 4253, JT_SHADOW_CROSS: 4254,
  JT_ARCH_MAGE: 4255, JT_CARDINAL: 4256, JT_WINDHAWK: 4257,
  JT_IMPERIAL_GUARD: 4258, JT_BIOLO: 4259, JT_ABYSS_CHASER: 4260,
  JT_ELEMENTAL_MASTER: 4261, JT_INQUISITOR: 4262, JT_TROUBADOUR: 4263,
  JT_TROUVERE: 4264,
  JT_DRAGON_KNIGHT2: 4302, JT_IMPERIAL_GUARD2: 4308,
  JT_WINDHAWK2: 4307, JT_MEISTER2: 4303,
  JT_SUMMONER: 4218,
  JT_CHICKEN: 4045, JT_CHICKEN2: 4046,
};

const args = parseArgs(process.argv.slice(2));
const outDir = resolve(process.cwd(), "public/db");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

if (args.list) {
  const grf = openGrf(args.list);
  for (const f of grf.files) {
    console.log(
      `${f.filename}\t${f.uncompSize}\tflags=0x${f.flags.toString(16)}`,
    );
  }
  closeGrf(grf);
  process.exit(0);
}

if (args.extract) {
  if (!args.grf) {
    console.error("usage: --extract <out-dir> --grf <file.grf> [--match <regex>]");
    process.exit(1);
  }
  await extractAll(args.grf, args.extract, args.match);
  process.exit(0);
}

if (args.dump) {
  const [grfPath, wantPath] = args.dump.split("::");
  const grf = openGrf(grfPath);
  try {
    const entry = grf.files.find(
      (f) => normalize(f.filename).endsWith(wantPath.toLowerCase()),
    );
    if (!entry) {
      console.error(`Not found: ${wantPath}`);
      process.exit(1);
    }
    const bytes = extractFile(grf, entry);
    process.stdout.write(Buffer.from(bytes));
  } finally {
    closeGrf(grf);
  }
  process.exit(0);
}

const fileMap = await collectSourceFiles(args);
console.log(`Collected ${fileMap.size} source file(s):`);
for (const [k, v] of fileMap) console.log(`  ${k}  (${v.byteLength} bytes)`);

const job = parseJobNames(fileMap);
writeJson(`${outDir}/job.json`, job);
console.log(`\nDone:`);
console.log(`  job.json — ${Object.keys(job).length} entries`);

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--grf") out.grf = argv[++i];
    else if (a === "--dir") out.dir = argv[++i];
    else if (a === "--list") out.list = argv[++i];
    else if (a === "--dump") out.dump = argv[++i];
    else if (a === "--extract") out.extract = argv[++i];
    else if (a === "--match") out.match = argv[++i];
    else if (a === "-h" || a === "--help") {
      console.error(
        "usage: node tools/build-db.mjs (--grf <file> | --dir <folder> | --list <grf>)",
      );
      process.exit(1);
    }
  }
  if (!out.grf && !out.dir && !out.list) {
    out.dir = "tools/grf-data";
  }
  return out;
}

async function collectSourceFiles(args) {
  const map = new Map();
  if (args.grf) {
    const grf = openGrf(args.grf);
    try {
      for (const want of WANTED_FILES) {
        const entry = grf.files.find(
          (f) => normalize(f.filename).endsWith(want),
        );
        if (entry) {
          try {
            const bytes = extractFile(grf, entry);
            map.set(want, bytes);
          } catch (err) {
            console.warn(`! Failed to extract ${want}: ${err.message}`);
          }
        }
      }
    } finally {
      closeGrf(grf);
    }
  }
  if (args.dir) {
    const root = resolve(args.dir);
    if (existsSync(root)) walkDir(root, (full, rel) => {
      const want = WANTED_FILES.find((w) => normalize(rel).endsWith(w));
      if (want) map.set(want, new Uint8Array(readFileSync(full)));
    });
  }
  return map;
}

function walkDir(root, cb, base = root) {
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    const s = statSync(full);
    if (s.isDirectory()) walkDir(full, cb, base);
    else cb(full, full.slice(base.length + 1));
  }
}

function normalize(s) {
  return s.replace(/[\\/]+/g, "/").toLowerCase();
}

function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// GRF reader (versions 0x103, 0x200, and custom 0x300 forks)
// ---------------------------------------------------------------------------

function openGrf(path) {
  const fd = openSync(path, "r");
  const fileSize = fstatSync(fd).size;

  const header = Buffer.alloc(0x2e);
  readAt(fd, header, 0);
  const magic = header.toString("ascii", 0, 16).replace(/\0.*$/, "");
  console.error(`Magic: "${magic}"`);
  const filetableOffset = header.readUInt32LE(0x1e);
  const m1 = header.readUInt32LE(0x22);
  const m2 = header.readUInt32LE(0x26);
  const version = header.readUInt32LE(0x2a);
  const fileCount = m2 - m1 - 7;
  console.error(
    `GRF version 0x${version.toString(16)}, ${fileCount} files (~${(fileSize / 1024 / 1024 / 1024).toFixed(2)} GB), table at 0x${filetableOffset.toString(16)}`,
  );

  let files;
  if (version === 0x200) {
    files = readFileTableV200(fd, 0x2e + filetableOffset);
  } else if (version === 0x300) {
    // Custom forks (Event Horizon etc.) — 4-byte gap before the compressed
    // table and a 21-byte entry trailer (extra u32 vs v0x200).
    files = readFileTableV200(fd, 0x32 + filetableOffset, 21);
  } else if (version === 0x103 || version === 0x101) {
    files = readFileTableV103(fd, 0x2e + filetableOffset, fileCount, fileSize);
  } else {
    closeSync(fd);
    throw new Error(`Unsupported GRF version 0x${version.toString(16)}`);
  }
  return { fd, fileSize, version, files };
}

function readAt(fd, buf, position) {
  let read = 0;
  while (read < buf.length) {
    const n = readSync(fd, buf, read, buf.length - read, position + read);
    if (n <= 0) break;
    read += n;
  }
  return read;
}

function readBytes(fd, length, position) {
  const buf = Buffer.alloc(length);
  readAt(fd, buf, position);
  return buf;
}

function readFileTableV200(fd, tableStart, entryTrailerBytes = 17) {
  const sizes = readBytes(fd, 8, tableStart);
  const compressedSize = sizes.readUInt32LE(0);
  const uncompressedSize = sizes.readUInt32LE(4);
  const compressed = readBytes(fd, compressedSize, tableStart + 8);
  const table = inflateSync(compressed);
  if (table.length !== uncompressedSize) {
    console.warn(
      `! filetable inflate size ${table.length} != expected ${uncompressedSize}`,
    );
  }
  const files = [];
  let p = 0;
  while (p < table.length) {
    const nullIdx = table.indexOf(0, p);
    if (nullIdx < 0) break;
    const filename = decodeName(table.subarray(p, nullIdx));
    p = nullIdx + 1;
    if (p + entryTrailerBytes > table.length) break;
    const compSize = table.readUInt32LE(p);
    const compSizeAligned = table.readUInt32LE(p + 4);
    const uncompSize = table.readUInt32LE(p + 8);
    const flags = table.readUInt8(p + 12);
    const offset = table.readUInt32LE(p + 13);
    p += entryTrailerBytes;
    files.push({ filename, compSize, compSizeAligned, uncompSize, flags, offset });
  }
  return files;
}

function readFileTableV103(fd, tableStart, fileCount, fileSize) {
  const buf = readBytes(fd, fileSize - tableStart, tableStart);
  const files = [];
  let p = 0;
  for (let i = 0; i < fileCount && p < buf.length; i++) {
    const len = buf.readUInt32LE(p);
    p += 4;
    const filename = decodeName(buf.subarray(p + 2, p + 2 + len - 6));
    p += len;
    if (p + 17 > buf.length) break;
    const compSize = buf.readUInt32LE(p);
    const compSizeAligned = buf.readUInt32LE(p + 4);
    const uncompSize = buf.readUInt32LE(p + 8);
    const flags = buf.readUInt8(p + 12);
    const offset = buf.readUInt32LE(p + 13);
    p += 17;
    files.push({ filename, compSize, compSizeAligned, uncompSize, flags, offset });
  }
  return files;
}

function extractFile(grf, entry) {
  const FILE_BIT = 0x01;
  const ENC_MIXED = 0x02;
  const ENC_HEADER = 0x04;
  if (!(entry.flags & FILE_BIT)) return new Uint8Array(0);
  if (entry.flags & (ENC_MIXED | ENC_HEADER)) {
    throw new Error(
      `encrypted file (flags=0x${entry.flags.toString(16)}) not supported`,
    );
  }
  const raw = readBytes(grf.fd, entry.compSizeAligned, 0x2e + entry.offset);
  return inflateSync(raw);
}

function closeGrf(grf) {
  if (grf?.fd != null) closeSync(grf.fd);
}

async function extractAll(grfPath, outDir, matchPattern) {
  const grf = openGrf(grfPath);
  const re = matchPattern ? new RegExp(matchPattern, "i") : null;
  const root = resolve(outDir);
  if (!existsSync(root)) mkdirSync(root, { recursive: true });

  const startedAt = Date.now();
  let written = 0;
  let skipped = 0;
  let encrypted = 0;
  let bytes = 0;

  try {
    let lastReportAt = startedAt;
    for (let i = 0; i < grf.files.length; i++) {
      const entry = grf.files[i];
      if (!(entry.flags & 0x01)) continue;
      if (re && !re.test(entry.filename)) continue;
      if (entry.flags & 0x06) {
        encrypted++;
        continue;
      }

      const safe = sanitizePath(entry.filename);
      if (!safe) {
        skipped++;
        continue;
      }
      const dest = join(root, safe);
      const dir = dest.substring(0, dest.lastIndexOf("/"));
      try {
        if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
        const data = extractFile(grf, entry);
        writeFileSync(dest, data);
        written++;
        bytes += data.length;
      } catch {
        skipped++;
      }

      const now = Date.now();
      if (now - lastReportAt > 2000) {
        const pct = ((i / grf.files.length) * 100).toFixed(1);
        console.error(
          `  [${pct}%] ${written} written, ${skipped} skipped, ${encrypted} encrypted, ${(bytes / 1e6).toFixed(0)} MB`,
        );
        lastReportAt = now;
      }
    }
  } finally {
    closeGrf(grf);
  }

  const dur = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.error(
    `\nExtracted ${written} file(s), ${(bytes / 1e9).toFixed(2)} GB to ${root} in ${dur}s.`,
  );
  if (encrypted) console.error(`Skipped ${encrypted} encrypted file(s).`);
  if (skipped) console.error(`Skipped ${skipped} unreadable/invalid file(s).`);
}

function sanitizePath(name) {
  let s = name.replace(/\\/g, "/").replace(/^\/+/, "");
  if (/^[A-Za-z]:/.test(s)) s = s.slice(2).replace(/^\/+/, "");
  if (!s) return null;
  for (const part of s.split("/")) {
    if (part === ".." || part === ".") return null;
  }
  return s;
}

function decodeName(bytes) {
  try {
    return new TextDecoder("euc-kr", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

// ---------------------------------------------------------------------------
// Lua 5.1 bytecode walker — extracts the constant pool (strings + numbers)
// in declaration order, recursing into nested function prototypes.
// ---------------------------------------------------------------------------

function parseLua51Constants(bytes) {
  if (bytes.length < 12) return [];
  const v = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v[0] !== 0x1b || v[1] !== 0x4c || v[2] !== 0x75 || v[3] !== 0x61) return null;
  if (v[4] !== 0x51) return null; // only Lua 5.1
  const fmt = v[5];
  if (fmt !== 0) return null;
  const endian = v[6];
  if (endian !== 1) return null;

  const ctx = {
    buf: v,
    pos: 12,
    sizeofInt: v[7],
    sizeofSizeT: v[8],
    sizeofInstr: v[9],
    sizeofNumber: v[10],
    constants: [],
  };

  parseFunction(ctx);
  return ctx.constants;
}

function readUInt(ctx, n) {
  let val = 0;
  for (let i = 0; i < n; i++) val += ctx.buf[ctx.pos + i] * 2 ** (8 * i);
  ctx.pos += n;
  return val;
}

function readDouble(ctx) {
  const x = ctx.buf.readDoubleLE(ctx.pos);
  ctx.pos += 8;
  return x;
}

function readString(ctx) {
  const len = readUInt(ctx, ctx.sizeofSizeT);
  if (len === 0) return "";
  const start = ctx.pos;
  ctx.pos += len;
  return ctx.buf.toString("latin1", start, start + len - 1);
}

function parseFunction(ctx) {
  readString(ctx);
  ctx.pos += ctx.sizeofInt;
  ctx.pos += ctx.sizeofInt;
  ctx.pos += 4;

  const codeCount = readUInt(ctx, ctx.sizeofInt);
  ctx.pos += codeCount * ctx.sizeofInstr;

  const kCount = readUInt(ctx, ctx.sizeofInt);
  for (let i = 0; i < kCount; i++) {
    const type = ctx.buf[ctx.pos++];
    if (type === 0) ctx.constants.push({ type: "nil" });
    else if (type === 1) ctx.constants.push({ type: "bool", value: ctx.buf[ctx.pos++] !== 0 });
    else if (type === 3) ctx.constants.push({ type: "number", value: readDouble(ctx) });
    else if (type === 4) ctx.constants.push({ type: "string", value: readString(ctx) });
    else throw new Error(`Unknown Lua constant type ${type}`);
  }

  const protoCount = readUInt(ctx, ctx.sizeofInt);
  for (let i = 0; i < protoCount; i++) parseFunction(ctx);

  const lineInfoCount = readUInt(ctx, ctx.sizeofInt);
  ctx.pos += lineInfoCount * ctx.sizeofInt;

  const localCount = readUInt(ctx, ctx.sizeofInt);
  for (let i = 0; i < localCount; i++) {
    readString(ctx);
    ctx.pos += ctx.sizeofInt + ctx.sizeofInt;
  }

  const upCount = readUInt(ctx, ctx.sizeofInt);
  for (let i = 0; i < upCount; i++) readString(ctx);
}

// ---------------------------------------------------------------------------
// Job parser
// ---------------------------------------------------------------------------

function parseJobAndMobIds(map) {
  const npcBytes =
    map.get("data/luafiles514/lua files/datainfo/npcidentity.lub") ??
    map.get("data/luafiles514/lua files/datainfo/npcidentity.lua");
  const jt = new Map();
  if (!npcBytes) return jt;
  const consts = parseLua51Constants(npcBytes);
  if (!consts) return jt;
  for (let i = 0; i + 1 < consts.length; i++) {
    const a = consts[i];
    const b = consts[i + 1];
    if (a.type === "string" && /^JT_/.test(a.value) && b.type === "number") {
      if (!jt.has(a.value)) jt.set(a.value, b.value);
    }
  }
  return jt;
}

function parseJobNames(map) {
  const out = {};

  // Authoritative server-side JT_X -> id (Latam server overrides kRO defaults).
  const pcIdBytes =
    map.get("data/luafiles514/lua files/admin/pcidentity.lub") ??
    map.get("data/luafiles514/lua files/admin/pcidentity.lua");
  const playerJtIds = new Map();
  if (pcIdBytes) {
    const consts = parseLua51Constants(pcIdBytes);
    if (consts) {
      for (let i = 0; i + 1 < consts.length; i++) {
        const a = consts[i];
        const b = consts[i + 1];
        if (a.type === "string" && /^JT_/.test(a.value) && b.type === "number") {
          if (!playerJtIds.has(a.value)) playerJtIds.set(a.value, b.value);
        }
      }
    }
  }
  for (const [k, v] of Object.entries(PLAYER_JT_IDS)) {
    if (!playerJtIds.has(k)) playerJtIds.set(k, v);
  }

  // JT_X → display label (pt-BR on Latam).
  const jtToLabel = new Map();
  const pcBytes =
    map.get("data/luafiles514/lua files/datainfo/pcjobnamegender.lub") ??
    map.get("data/luafiles514/lua files/datainfo/pcjobnamegender.lua");
  if (pcBytes) {
    const consts = parseLua51Constants(pcBytes);
    if (consts) {
      for (let i = 0; i < consts.length; i++) {
        const c = consts[i];
        if (c.type !== "string" || !c.value.startsWith("JT_")) continue;
        for (let j = i + 1; j < consts.length; j++) {
          const cc = consts[j];
          if (cc.type !== "string") continue;
          if (cc.value.startsWith("JT_")) break;
          if (cc.value === "PCJobNameTableMan" || cc.value === "PCJobNameTableWoman" || cc.value === "pcJobTbl2") continue;
          jtToLabel.set(c.value, cc.value);
          break;
        }
      }
    }
  }

  function labelFor(jt) {
    if (jtToLabel.has(jt)) return jtToLabel.get(jt);
    if (jt.endsWith("_H") || jt.endsWith("_B")) {
      const base = jt.slice(0, -2);
      if (jtToLabel.has(base)) return jtToLabel.get(base);
    }
    return null;
  }

  for (const [jt, id] of playerJtIds) {
    if (out[id]) continue;
    const label = labelFor(jt);
    if (label) out[id] = label;
  }

  // NPC sprite fallbacks for ids not covered by pcjobnamegender.
  const jt = parseJobAndMobIds(map);
  for (const [name, id] of jt) {
    if (out[id]) continue;
    out[id] = humanizeJtName(name);
  }
  return out;
}

function humanizeJtName(jt) {
  return jt
    .replace(/^JT_/, "")
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .join(" ");
}
