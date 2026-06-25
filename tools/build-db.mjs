#!/usr/bin/env node
// Extract PT-BR reference data from a Ragnarok Online client and emit JSON to
// public/db/:
//   job.json    player-class names  (pcjobnamegender + pcidentity; classes only)
//   item.json   item names + slots  (System/iteminfo_new.lub, via the Lua VM)
//   skill.json  skill names         (skillid.lub + skillinfolist_ptbr.lub, VM)
// Plus on-demand icon extraction (--icons). Monster names are not in the client
// (they're server-side) and come from Divine Pride — see src/divine-pride.ts.
//
// The reader handles GRF 0x101/0x103/0x200 and the 0x300 "Event Horizon" fork,
// including the custom DES encryption used by many texture entries.
//
// Usage:
//   node tools/build-db.mjs --grf <file.grf>           # build job/item/skill JSON
//   node tools/build-db.mjs --dir <folder>             # from extracted folder
//   node tools/build-db.mjs --list <file.grf>          # print listing
//   node tools/build-db.mjs --grf <file.grf> --icons <dir>   # extract icons by id
//   node tools/build-db.mjs --grf <file.grf> --extract <dir> [--match <regex>]
//   node tools/build-db.mjs --dump <file.grf>::<path>  # dump one file (fwd-slash path)

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
import { resolve, join, dirname } from "node:path";
import { inflateSync, deflateSync } from "node:zlib";
import { runChunk, runChunkInto, decodeClientString, LuaTable } from "./lua51.mjs";

const WANTED_FILES = [
  "data/luafiles514/lua files/datainfo/pcjobnamegender.lub",
  "data/luafiles514/lua files/datainfo/pcjobnamegender.lua",
  "data/luafiles514/lua files/admin/pcidentity.lub",
  "data/luafiles514/lua files/admin/pcidentity.lua",
  // Skill names (PT-BR): skillid maps SKID const -> numeric id; the _ptbr
  // localization list maps SKID const -> display name.
  "data/luafiles514/lua files/skillinfoz/skillid.lub",
  "data/luafiles514/lua files/skillinfoz/skillid.lua",
  "data/luafiles514/lua files/skillinfoz/skillinfolist_ptbr.lub",
  "data/luafiles514/lua files/skillinfoz/skillinfolist_ptbr.lua",
  // Random-option (Bônus Aleatório) name templates, PT-BR. enumvar defines the
  // RDMOPTID enum the table is keyed by; the _ptbr table maps id -> a display
  // template like "ATQM +%d" / "Conjuração variável -%d%%".
  "data/luafiles514/lua files/datainfo/enumvar.lub",
  "data/luafiles514/lua files/datainfo/enumvar.lua",
  "data/luafiles514/lua files/datainfo/addrandomoptionnametable_ptbr.lub",
  "data/luafiles514/lua files/datainfo/addrandomoptionnametable_ptbr.lua",
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

// 4th-job display names, pinned from bROWiki's "Classe 4" column. The client's
// pcjobnamegender.lub predates the renames (it still says "Arquimágico",
// "Assassino", "Poeta", "Patrulheiro", "Ladino") so we override those few with
// the authoritative pt-BR names — kept in sync with the sibling project
// latam-visuais (tools/build-db.mjs NAME_OVERRIDE). Names that already match the
// lub aren't listed; only the renamed ones are.
const JOB_NAME_OVERRIDE = {
  JT_ARCH_MAGE: "Magus",
  JT_SHADOW_CROSS: "Executor",
  JT_ABYSS_CHASER: "Mandraque",
  JT_WINDHAWK: "Falcão do Vento",
  JT_TROUBADOUR: "Maestro",
};

// All work runs inside main() invoked at the very bottom of the file, so every
// module-level const (including the DES tables) is initialized before any
// extraction touches it.
async function main() {
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
    // normalize() the query too — stored names use mixed/backslash separators.
    const want = normalize(wantPath);
    const entry = findBestEntry(grf, want);
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

if (args.icons) {
  if (!args.grf) {
    console.error("usage: --icons <out-dir> --grf <file.grf>");
    process.exit(1);
  }
  await extractIcons(args.grf, args.icons, args);
  process.exit(0);
}

const fileMap = await collectSourceFiles(args);
console.log(`Collected ${fileMap.size} source file(s):`);
for (const [k, v] of fileMap) console.log(`  ${k}  (${v.byteLength} bytes)`);

const job = parseJobNames(fileMap);
writeJson(`${outDir}/job.json`, job);

const item = parseItemNames(args);
if (Object.keys(item).length) writeJson(`${outDir}/item.json`, item);

const skill = parseSkillNames(fileMap);
if (Object.keys(skill).length) writeJson(`${outDir}/skill.json`, skill);

const randomOpt = parseRandomOptNames(fileMap);
if (Object.keys(randomOpt).length) writeJson(`${outDir}/randomopt.json`, randomOpt);

console.log(`\nDone:`);
console.log(`  job.json       — ${Object.keys(job).length} entries`);
console.log(`  item.json      — ${Object.keys(item).length} entries`);
console.log(`  skill.json     — ${Object.keys(skill).length} entries`);
console.log(`  randomopt.json — ${Object.keys(randomOpt).length} entries`);
} // end main()

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
    else if (a === "--icons") out.icons = argv[++i];
    else if (a === "--iteminfo") out.iteminfo = argv[++i];
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
        const entry = findBestEntry(grf, want);
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

// The merged "Event Horizon" GRF carries several copies of the same logical
// path (patch layering, `data\\…` double-slash artifacts, `.txt.txt`, etc.).
// `normalize` collapses repeated slashes so they compare equal; among the
// matches we keep the largest by uncompressed size, which is the complete,
// non-truncated copy in practice.
function findBestEntry(grf, want) {
  let best = null;
  for (const f of grf.files) {
    if (!(f.flags & 0x01)) continue;
    if (!normalize(f.filename).endsWith(want)) continue;
    if (!best || f.uncompSize > best.uncompSize) best = f;
  }
  return best;
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
    // The 0x300 "Event Horizon" fork stores a 64-bit data offset (its 21-byte
    // trailer = the standard 17 + a high u32), so files appended past the 4 GB
    // mark — recent patches — resolve correctly. v0x200 is 32-bit.
    const offsetLow = table.readUInt32LE(p + 13);
    const offsetHigh = entryTrailerBytes >= 21 ? table.readUInt32LE(p + 17) : 0;
    const offset = offsetHigh * 0x100000000 + offsetLow;
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

// ---------------------------------------------------------------------------
// GRF DES decryption — Ragnarok's custom single-round DES with block cycling
// and a byte shuffle. Ported from grf-loader (vthibault/grf-loader, MIT).
// Encrypted entries are flagged ENC_MIXED (0x02 — header DES + periodic
// DES/shuffle) or ENC_HEADER (0x04 — first 20 blocks DES only). Both operate
// on the *compressed* bytes in place, before inflate.
// ---------------------------------------------------------------------------

const DES_MASK = new Uint8Array([0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01]);
const _t = new Uint8Array(8);
const _t2 = new Uint8Array(8);
const _zero = new Uint8Array(8);

// prettier-ignore
const DES_IP = new Uint8Array([
  58,50,42,34,26,18,10,2, 60,52,44,36,28,20,12,4,
  62,54,46,38,30,22,14,6, 64,56,48,40,32,24,16,8,
  57,49,41,33,25,17,9,1,  59,51,43,35,27,19,11,3,
  61,53,45,37,29,21,13,5, 63,55,47,39,31,23,15,7,
]);
// prettier-ignore
const DES_FP = new Uint8Array([
  40,8,48,16,56,24,64,32, 39,7,47,15,55,23,63,31,
  38,6,46,14,54,22,62,30, 37,5,45,13,53,21,61,29,
  36,4,44,12,52,20,60,28, 35,3,43,11,51,19,59,27,
  34,2,42,10,50,18,58,26, 33,1,41,9,49,17,57,25,
]);
// prettier-ignore
const DES_TP = new Uint8Array([
  16,7,20,21, 29,12,28,17, 1,15,23,26, 5,18,31,10,
  2,8,24,14,  32,27,3,9,   19,13,30,6,  22,11,4,25,
]);
// prettier-ignore
const DES_SBOX = [
  new Uint8Array([
    0xef,0x03,0x41,0xfd,0xd8,0x74,0x1e,0x47, 0x26,0xef,0xfb,0x22,0xb3,0xd8,0x84,0x1e,
    0x39,0xac,0xa7,0x60,0x62,0xc1,0xcd,0xba, 0x5c,0x96,0x90,0x59,0x05,0x3b,0x7a,0x85,
    0x40,0xfd,0x1e,0xc8,0xe7,0x8a,0x8b,0x21, 0xda,0x43,0x64,0x9f,0x2d,0x14,0xb1,0x72,
    0xf5,0x5b,0xc8,0xb6,0x9c,0x37,0x76,0xec, 0x39,0xa0,0xa3,0x05,0x52,0x6e,0x0f,0xd9,
  ]),
  new Uint8Array([
    0xa7,0xdd,0x0d,0x78,0x9e,0x0b,0xe3,0x95, 0x60,0x36,0x36,0x4f,0xf9,0x60,0x5a,0xa3,
    0x11,0x24,0xd2,0x87,0xc8,0x52,0x75,0xec, 0xbb,0xc1,0x4c,0xba,0x24,0xfe,0x8f,0x19,
    0xda,0x13,0x66,0xaf,0x49,0xd0,0x90,0x06, 0x8c,0x6a,0xfb,0x91,0x37,0x8d,0x0d,0x78,
    0xbf,0x49,0x11,0xf4,0x23,0xe5,0xce,0x3b, 0x55,0xbc,0xa2,0x57,0xe8,0x22,0x74,0xce,
  ]),
  new Uint8Array([
    0x2c,0xea,0xc1,0xbf,0x4a,0x24,0x1f,0xc2, 0x79,0x47,0xa2,0x7c,0xb6,0xd9,0x68,0x15,
    0x80,0x56,0x5d,0x01,0x33,0xfd,0xf4,0xae, 0xde,0x30,0x07,0x9b,0xe5,0x83,0x9b,0x68,
    0x49,0xb4,0x2e,0x83,0x1f,0xc2,0xb5,0x7c, 0xa2,0x19,0xd8,0xe5,0x7c,0x2f,0x83,0xda,
    0xf7,0x6b,0x90,0xfe,0xc4,0x01,0x5a,0x97, 0x61,0xa6,0x3d,0x40,0x0b,0x58,0xe6,0x3d,
  ]),
  new Uint8Array([
    0x4d,0xd1,0xb2,0x0f,0x28,0xbd,0xe4,0x78, 0xf6,0x4a,0x0f,0x93,0x8b,0x17,0xd1,0xa4,
    0x3a,0xec,0xc9,0x35,0x93,0x56,0x7e,0xcb, 0x55,0x20,0xa0,0xfe,0x6c,0x89,0x17,0x62,
    0x17,0x62,0x4b,0xb1,0xb4,0xde,0xd1,0x87, 0xc9,0x14,0x3c,0x4a,0x7e,0xa8,0xe2,0x7d,
    0xa0,0x9f,0xf6,0x5c,0x6a,0x09,0x8d,0xf0, 0x0f,0xe3,0x53,0x25,0x95,0x36,0x28,0xcb,
  ]),
];

const DES_SHUFFLE = (() => {
  const list = new Uint8Array([
    0x00, 0x2b, 0x6c, 0x80, 0x01, 0x68, 0x48,
    0x77, 0x60, 0xff, 0xb9, 0xc0, 0xfe, 0xeb,
  ]);
  const out = new Uint8Array(256);
  for (let i = 0; i < 256; i++) out[i] = i;
  for (let i = 0; i < list.length; i += 2) {
    out[list[i]] = list[i + 1];
    out[list[i + 1]] = list[i];
  }
  return out;
})();

function desInitialPerm(src, index) {
  for (let i = 0; i < 64; ++i) {
    const j = DES_IP[i] - 1;
    if (src[index + ((j >> 3) & 7)] & DES_MASK[j & 7]) _t[(i >> 3) & 7] |= DES_MASK[i & 7];
  }
  src.set(_t, index);
  _t.set(_zero);
}

function desFinalPerm(src, index) {
  for (let i = 0; i < 64; ++i) {
    const j = DES_FP[i] - 1;
    if (src[index + ((j >> 3) & 7)] & DES_MASK[j & 7]) _t[(i >> 3) & 7] |= DES_MASK[i & 7];
  }
  src.set(_t, index);
  _t.set(_zero);
}

function desTransposition(src, index) {
  for (let i = 0; i < 32; ++i) {
    const j = DES_TP[i] - 1;
    if (src[index + (j >> 3)] & DES_MASK[j & 7]) _t[(i >> 3) + 4] |= DES_MASK[i & 7];
  }
  src.set(_t, index);
  _t.set(_zero);
}

function desExpansion(src, index) {
  _t[0] = ((src[index + 7] << 5) | (src[index + 4] >> 3)) & 0x3f;
  _t[1] = ((src[index + 4] << 1) | (src[index + 5] >> 7)) & 0x3f;
  _t[2] = ((src[index + 4] << 5) | (src[index + 5] >> 3)) & 0x3f;
  _t[3] = ((src[index + 5] << 1) | (src[index + 6] >> 7)) & 0x3f;
  _t[4] = ((src[index + 5] << 5) | (src[index + 6] >> 3)) & 0x3f;
  _t[5] = ((src[index + 6] << 1) | (src[index + 7] >> 7)) & 0x3f;
  _t[6] = ((src[index + 6] << 5) | (src[index + 7] >> 3)) & 0x3f;
  _t[7] = ((src[index + 7] << 1) | (src[index + 4] >> 7)) & 0x3f;
  src.set(_t, index);
  _t.set(_zero);
}

function desSbox(src, index) {
  for (let i = 0; i < 4; ++i) {
    _t[i] =
      (DES_SBOX[i][src[i * 2 + 0 + index]] & 0xf0) |
      (DES_SBOX[i][src[i * 2 + 1 + index]] & 0x0f);
  }
  src.set(_t, index);
  _t.set(_zero);
}

function desRound(src, index) {
  for (let i = 0; i < 8; i++) _t2[i] = src[index + i];
  desExpansion(_t2, 0);
  desSbox(_t2, 0);
  desTransposition(_t2, 0);
  src[index + 0] ^= _t2[4];
  src[index + 1] ^= _t2[5];
  src[index + 2] ^= _t2[6];
  src[index + 3] ^= _t2[7];
}

function desDecryptBlock(src, index) {
  desInitialPerm(src, index);
  desRound(src, index);
  desFinalPerm(src, index);
}

function desShuffleDec(src, index) {
  _t[0] = src[index + 3];
  _t[1] = src[index + 4];
  _t[2] = src[index + 6];
  _t[3] = src[index + 0];
  _t[4] = src[index + 1];
  _t[5] = src[index + 2];
  _t[6] = src[index + 5];
  _t[7] = DES_SHUFFLE[src[index + 7]];
  src.set(_t, index);
  _t.set(_zero);
}

// ENC_MIXED: first 20 blocks DES-decrypted; thereafter every `cycle`-th block
// is DES-decrypted and every 7th remaining block is de-shuffled. `entryLength`
// is the *compressed* size and drives the cycle gap.
function desDecodeFull(src, length, entryLength) {
  const digits = entryLength.toString().length;
  const cycle =
    digits < 3 ? 1 : digits < 5 ? digits + 1 : digits < 7 ? digits + 9 : digits + 15;
  const nblocks = length >> 3;
  for (let i = 0; i < 20 && i < nblocks; ++i) desDecryptBlock(src, i * 8);
  for (let i = 20, j = -1; i < nblocks; ++i) {
    if (i % cycle === 0) {
      desDecryptBlock(src, i * 8);
      continue;
    }
    if (++j && j % 7 === 0) desShuffleDec(src, i * 8);
  }
}

// ENC_HEADER: only the first 20 blocks are DES-decrypted; the rest is plaintext.
function desDecodeHeader(src, length) {
  const count = length >> 3;
  for (let i = 0; i < 20 && i < count; ++i) desDecryptBlock(src, i * 8);
}

function extractFile(grf, entry) {
  const FILE_BIT = 0x01;
  const ENC_MIXED = 0x02;
  const ENC_HEADER = 0x04;
  if (!(entry.flags & FILE_BIT)) return new Uint8Array(0);
  const raw = readBytes(grf.fd, entry.compSizeAligned, 0x2e + entry.offset);
  if (entry.flags & ENC_MIXED) desDecodeFull(raw, entry.compSizeAligned, entry.compSize);
  else if (entry.flags & ENC_HEADER) desDecodeHeader(raw, entry.compSizeAligned);
  // Stored (not deflated) when compressed size == real size.
  if (entry.uncompSize === entry.compSize) return raw;
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
      if (entry.flags & 0x06) encrypted++; // decrypted in extractFile; just track count

      const safe = sanitizePath(entry.filename);
      if (!safe) {
        skipped++;
        continue;
      }
      const dest = join(root, safe);
      const dir = dirname(dest);
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
  if (encrypted) console.error(`Decrypted ${encrypted} encrypted file(s).`);
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
    if (JOB_NAME_OVERRIDE[jt]) return JOB_NAME_OVERRIDE[jt];
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

  // Player classes only — no NPC/mob sprite fallback. Mob names aren't in the
  // client (they're server-side); they come from Divine Pride at runtime.
  return out;
}

// ---------------------------------------------------------------------------
// Item names — `idnum2itemdisplaynametable.txt` is plain text, one `id#Nome#`
// per line, CP1252-encoded (Portuguese accents are single bytes). Lines
// starting with `//` are comments.
// ---------------------------------------------------------------------------

function parseItemNames(args) {
  // Single source: the live, daily-patched System/iteminfo_new.lub — it has
  // every item (incl. modern equipment) with the correct identified name.
  const lubPath = resolveItemInfoPath(args);
  if (!lubPath) {
    throw new Error(
      "iteminfo_new.lub not found next to the GRF (System/) — pass --iteminfo <path>",
    );
  }
  console.log(`  (items from ${lubPath})`);
  return parseItemInfoLub(readFileSync(lubPath));
}

// System/iteminfo_new.lub is a sibling of data.grf. Allow an explicit override
// via --iteminfo; otherwise look next to the GRF (or the --dir root).
function resolveItemInfoPath(args) {
  if (args.iteminfo) return existsSync(args.iteminfo) ? args.iteminfo : null;
  const roots = [];
  if (args.grf) roots.push(join(dirname(resolve(args.grf)), "System"));
  if (args.dir) roots.push(join(resolve(args.dir), "System"), resolve(args.dir));
  for (const root of roots) {
    for (const name of ["iteminfo_new.lub", "itemInfo.lub", "iteminfo.lub"]) {
      const p = join(root, name);
      // Skip the tiny stub itemInfo.lub (a few hundred bytes that just chains
      // to the real table).
      if (existsSync(p) && statSync(p).size > 4096) return p;
    }
  }
  return null;
}

function parseItemInfoLub(bytes) {
  const tbl = runChunk(bytes).get("tbl");
  const out = {};
  if (!(tbl instanceof LuaTable)) return out;
  for (const [id, entry] of tbl.map) {
    if (typeof id !== "number" || !(entry instanceof LuaTable)) continue;
    let name = decodeClientString(entry.get("identifiedDisplayName"));
    if (!name) continue;
    // Append the slot count for slotted gear, matching the in-client display
    // ("Faca" -> "Faca [3]"). itemInfo stores it numerically; 0 = no slots.
    const slots = entry.get("slotCount");
    if (typeof slots === "number" && slots > 0) name += ` [${Math.round(slots)}]`;
    const rec = { name };
    // ClassNum is the sprite "view" id the client uses to draw the gear: the
    // accessory id for headgears/costumes, the robe id for garments, the
    // shield/weapon look. It's exactly what zrenderer/ragassets needs to render
    // equipped gear on a character (see src/ui/character-viewer.ts). Keep it
    // only when present so item.json stays lean.
    const view = entry.get("ClassNum");
    if (typeof view === "number" && view > 0) rec.view = Math.round(view);
    out[String(id)] = rec;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Skill names — execute the client's Lua data tables through the VM:
//   skillid.lub            defines the SKID table (const -> numeric skill id)
//   skillinfolist_ptbr.lub builds SkillInfoList keyed by [SKID.x] = { SkillName }
// skillid runs first so SKID resolves; we then read the SkillName off the
// resulting table, covering every skill (incl. 4th-class).
// ---------------------------------------------------------------------------

function parseSkillNames(map) {
  const skillId =
    map.get("data/luafiles514/lua files/skillinfoz/skillid.lub") ??
    map.get("data/luafiles514/lua files/skillinfoz/skillid.lua");
  const skillInfo =
    map.get("data/luafiles514/lua files/skillinfoz/skillinfolist_ptbr.lub") ??
    map.get("data/luafiles514/lua files/skillinfoz/skillinfolist_ptbr.lua");
  if (!skillId || !skillInfo) {
    throw new Error("skillid.lub / skillinfolist_ptbr.lub not found in GRF");
  }
  const g = new LuaTable();
  runChunkInto(skillId, g); // populate SKID
  runChunkInto(skillInfo, g); // build SkillInfoList keyed by numeric id
  // The result is the largest table global that isn't SKID.
  let list = null;
  for (const [k, v] of g.map) {
    if (k === "SKID") continue;
    if (v instanceof LuaTable && (!list || v.map.size > list.map.size)) list = v;
  }
  const out = {};
  if (list) {
    for (const [id, entry] of list.map) {
      if (typeof id !== "number" || !(entry instanceof LuaTable)) continue;
      const name = decodeClientString(entry.get("SkillName"));
      if (name) out[String(id)] = { name };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Random-option names — execute the client's Lua tables through the VM:
//   enumvar.lub                       defines EnumVAR (const -> numeric opt id)
//   addrandomoptionnametable_ptbr.lub builds NameTable_VAR keyed by numeric id,
//                                     each value a display template ("ATQM +%d").
// The replay's item records carry (id, value) pairs; the UI fills the template
// at runtime. We only persist id -> template here.
// ---------------------------------------------------------------------------

function parseRandomOptNames(map) {
  const enumvar =
    map.get("data/luafiles514/lua files/datainfo/enumvar.lub") ??
    map.get("data/luafiles514/lua files/datainfo/enumvar.lua");
  const nameTable =
    map.get("data/luafiles514/lua files/datainfo/addrandomoptionnametable_ptbr.lub") ??
    map.get("data/luafiles514/lua files/datainfo/addrandomoptionnametable_ptbr.lua");
  if (!nameTable) return {};
  const g = new LuaTable();
  // enumvar runs first so any const references in the name table resolve; it's
  // optional because the PT-BR table is keyed by literal ids in practice.
  if (enumvar) {
    try { runChunkInto(enumvar, g); } catch (err) { console.warn(`! enumvar: ${err.message}`); }
  }
  try { runChunkInto(nameTable, g); } catch (err) { console.warn(`! randomoption table: ${err.message}`); return {}; }

  const tbl = g.get("NameTable_VAR");
  const out = {};
  if (tbl instanceof LuaTable) {
    for (const [id, val] of tbl.map) {
      if (typeof id !== "number") continue;
      const name = decodeClientString(val);
      if (name) out[String(Math.round(id))] = name;
    }
  }
  return out;
}

// SKID const -> numeric id, read from skillid.lub's constant pool. Used by the
// icon extractor to map a skill's icon file (named after the const) to its id.
function parseSkillIds(map) {
  const ids = new Map();
  const bytes =
    map.get("data/luafiles514/lua files/skillinfoz/skillid.lub") ??
    map.get("data/luafiles514/lua files/skillinfoz/skillid.lua");
  if (!bytes) return ids;
  const consts = parseLua51Constants(bytes);
  if (!consts) return ids;
  for (let i = 0; i + 1 < consts.length; i++) {
    const a = consts[i];
    const b = consts[i + 1];
    if (a.type === "string" && a.value !== "SKID" && b.type === "number") {
      if (!ids.has(a.value)) ids.set(a.value, b.value);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Icon extraction — decodes each BMP to a transparent PNG keyed by numeric id:
//   <out>/item/<id>.png        inventory icon   (item\<resname>.bmp)
//   <out>/collection/<id>.png  description image (collection\<resname>.bmp)
//   <out>/skill/<id>.png        skill icon       (item\<skid-const>.bmp)
//   <out>/job/<id>.png          class icon       (renewalparty\icon_jobs_<id>.bmp)
// resnames come from idnum2itemresnametable.txt (EUC-KR, Korean sprite names);
// skill icon filenames are the lowercased SKID constant. Magenta (#FF00FF) is
// mapped to transparent.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// BMP -> PNG conversion. RO icons are uncompressed BMPs (8-bit palettized,
// some 24/32-bit) that use magenta #FF00FF as the transparency colorkey. We
// decode to RGBA (keying magenta -> alpha 0) and re-encode as a PNG using only
// node:zlib — no external image library.
// ---------------------------------------------------------------------------

function bmpToRgba(buf) {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < 54 || b[0] !== 0x42 || b[1] !== 0x4d) return null; // "BM"
  const dataOffset = b.readUInt32LE(10);
  const dibSize = b.readUInt32LE(14);
  const w = b.readInt32LE(18);
  const rawH = b.readInt32LE(22);
  const bpp = b.readUInt16LE(28);
  const compression = b.readUInt32LE(30);
  if (compression !== 0 || w <= 0 || rawH === 0) return null; // BI_RGB only
  const topDown = rawH < 0;
  const h = Math.abs(rawH);

  let palette = null;
  if (bpp <= 8) {
    let palCount = b.readUInt32LE(46); // biClrUsed
    if (!palCount) palCount = 1 << bpp;
    const palStart = 14 + dibSize;
    palette = new Array(palCount);
    for (let i = 0; i < palCount; i++) {
      const o = palStart + i * 4; // stored BGRA
      palette[i] = [b[o + 2], b[o + 1], b[o]];
    }
  } else if (bpp !== 24 && bpp !== 32) {
    return null; // unsupported depth
  }

  const rowSize = Math.floor((bpp * w + 31) / 32) * 4; // padded to 4 bytes
  const rgba = Buffer.alloc(w * h * 4);
  for (let row = 0; row < h; row++) {
    const srcRow = topDown ? row : h - 1 - row; // BMP rows are bottom-up
    const srcBase = dataOffset + srcRow * rowSize;
    for (let x = 0; x < w; x++) {
      let r, g, bl;
      if (bpp === 8) {
        const p = palette[b[srcBase + x]] || [0, 0, 0];
        [r, g, bl] = p;
      } else if (bpp === 4) {
        const byte = b[srcBase + (x >> 1)];
        const p = palette[x & 1 ? byte & 0x0f : byte >> 4] || [0, 0, 0];
        [r, g, bl] = p;
      } else if (bpp === 1) {
        const byte = b[srcBase + (x >> 3)];
        const p = palette[(byte >> (7 - (x & 7))) & 1] || [0, 0, 0];
        [r, g, bl] = p;
      } else if (bpp === 24) {
        const o = srcBase + x * 3;
        bl = b[o]; g = b[o + 1]; r = b[o + 2];
      } else {
        const o = srcBase + x * 4; // 32bpp BGRA — ignore stored alpha
        bl = b[o]; g = b[o + 1]; r = b[o + 2];
      }
      const di = (row * w + x) * 4;
      rgba[di] = r;
      rgba[di + 1] = g;
      rgba[di + 2] = bl;
      rgba[di + 3] = r === 255 && g === 0 && bl === 255 ? 0 : 255; // magenta key
    }
  }
  return { width: w, height: h, rgba };
}

const PNG_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = PNG_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // 10..12 = compression / filter / interlace = 0
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function bmpToPng(bmpBytes) {
  const decoded = bmpToRgba(bmpBytes);
  if (!decoded) return null;
  return encodePng(decoded.width, decoded.height, decoded.rgba);
}

const UI = "data/texture/유저인터페이스"; // "user interface" texture root

// id -> icon resource name (lowercased). The live System/iteminfo_new.lub is
// authoritative and complete (modern equipment like 450147 = "Illusion_Armor_A"
// is only there); the legacy GRF idnum2itemresnametable.txt fills any gaps.
function buildResNameMap(args) {
  const out = new Map();
  const lubPath = resolveItemInfoPath(args);
  if (!lubPath) {
    throw new Error(
      "iteminfo_new.lub not found next to the GRF (System/) — pass --iteminfo <path>",
    );
  }
  const tbl = runChunk(readFileSync(lubPath)).get("tbl");
  if (tbl instanceof LuaTable) {
    for (const [id, entry] of tbl.map) {
      if (typeof id !== "number" || !(entry instanceof LuaTable)) continue;
      const res =
        decodeClientString(entry.get("identifiedResourceName")) ||
        decodeClientString(entry.get("unidentifiedResourceName"));
      if (res) out.set(String(id), res.toLowerCase());
    }
  }
  return out;
}

function indexIcons(grf) {
  // normalized filename -> best entry, limited to the icon folders we need.
  const idx = new Map();
  const itemDir = `${UI}/item/`;
  const collDir = `${UI}/collection/`;
  const jobPrefix = `${UI}/renewalparty/icon_jobs_`;
  for (const f of grf.files) {
    if (!(f.flags & 0x01)) continue;
    const n = normalize(f.filename);
    if (!n.endsWith(".bmp")) continue;
    if (
      !n.startsWith(itemDir) &&
      !n.startsWith(collDir) &&
      !n.startsWith(jobPrefix)
    )
      continue;
    const prev = idx.get(n);
    if (!prev || f.uncompSize > prev.uncompSize) idx.set(n, f);
  }
  return idx;
}

function extractIcons(grfPath, outBase, args) {
  const grf = openGrf(grfPath);
  try {
    const root = resolve(outBase);
    const dirs = {
      item: join(root, "item"),
      collection: join(root, "collection"),
      skill: join(root, "skill"),
      job: join(root, "job"),
    };
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

    console.error("Indexing icon entries…");
    const idx = indexIcons(grf);
    console.error(`  ${idx.size} icon files indexed`);

    const counts = { item: 0, collection: 0, skill: 0, job: 0 };
    const fails = { extract: 0, convert: 0 };
    const writeIcon = (kind, id, entry) => {
      let bmp;
      try {
        bmp = extractFile(grf, entry);
      } catch {
        fails.extract++;
        return false;
      }
      const png = bmpToPng(bmp);
      if (!png) {
        fails.convert++;
        return false;
      }
      writeFileSync(join(dirs[kind], `${id}.png`), png);
      counts[kind]++;
      return true;
    };

    // Item inventory + collection icons, keyed by resource name.
    const resNames = buildResNameMap(args);
    for (const [id, res] of resNames) {
      const itemEntry = idx.get(`${UI}/item/${res}.bmp`);
      if (itemEntry) writeIcon("item", id, itemEntry);
      const collEntry = idx.get(`${UI}/collection/${res}.bmp`);
      if (collEntry) writeIcon("collection", id, collEntry);
    }

    // Skill icons share the item folder, named after the lowercased SKID const.
    const fileMap = collectGrfFiles(grf, [
      "data/luafiles514/lua files/skillinfoz/skillid.lub",
      "data/luafiles514/lua files/skillinfoz/skillid.lua",
    ]);
    const skillIds = parseSkillIds(fileMap);
    for (const [konst, id] of skillIds) {
      const entry = idx.get(`${UI}/item/${konst.toLowerCase()}.bmp`);
      if (entry) writeIcon("skill", id, entry);
    }

    // Class icons keyed directly by numeric job id (skip the _die variants).
    const jobRe = new RegExp(
      `${UI.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/renewalparty/icon_jobs_(\\d+)\\.bmp$`,
    );
    const jobFailed = [];
    for (const [name, entry] of idx) {
      const m = name.match(jobRe);
      if (m && !writeIcon("job", m[1], entry)) jobFailed.push(Number(m[1]));
    }

    console.error(
      `\nIcons (PNG) → ${root}\n  item: ${counts.item}  collection: ${counts.collection}  skill: ${counts.skill}  job: ${counts.job}` +
        (fails.extract ? `\n  ${fails.extract} entry(s) failed to extract` : "") +
        (fails.convert ? `\n  ${fails.convert} BMP(s) skipped (unsupported encoding)` : ""),
    );
    if (jobFailed.length)
      console.error(`  job ids not written: ${jobFailed.sort((a, b) => a - b).join(", ")}`);
  } finally {
    closeGrf(grf);
  }
}

// Pull a small set of named files from an already-open GRF into a name->bytes
// map (same keying as collectSourceFiles, but without reopening the archive).
function collectGrfFiles(grf, wants) {
  const map = new Map();
  for (const want of wants) {
    const entry = findBestEntry(grf, want);
    if (entry) {
      try {
        map.set(want, extractFile(grf, entry));
      } catch {
        /* skip */
      }
    }
  }
  return map;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
