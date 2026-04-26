#!/usr/bin/env node
// Dump the constant pool of a Lua 5.1 bytecode file.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { fileURLToPath } from "node:url";
const here = fileURLToPath(new URL("./build-db.mjs", import.meta.url));
const mod = await import(here);
// build-db.mjs exits on import unless we provide --dir/--grf/--list.
// Inline-implement instead — copy the parser.

const file = resolve(process.argv[2]);
const bytes = readFileSync(file);

const v = bytes;
if (v[0] !== 0x1b || v[1] !== 0x4c) {
  console.error("Not Lua bytecode");
  process.exit(1);
}
const sizeofInt = v[7];
const sizeofSizeT = v[8];
const sizeofInstr = v[9];

let pos = 12;
const constants = [];

function readUInt(n) {
  let val = 0;
  for (let i = 0; i < n; i++) val += v[pos + i] * 2 ** (8 * i);
  pos += n;
  return val;
}
function readDouble() { const x = v.readDoubleLE(pos); pos += 8; return x; }
function readString() {
  const len = readUInt(sizeofSizeT);
  if (len === 0) return "";
  const s = v.toString("latin1", pos, pos + len - 1);
  pos += len;
  return s;
}
function parseFunction() {
  readString();
  pos += sizeofInt;
  pos += sizeofInt;
  pos += 4;
  const codeCount = readUInt(sizeofInt);
  pos += codeCount * sizeofInstr;
  const kCount = readUInt(sizeofInt);
  for (let i = 0; i < kCount; i++) {
    const t = v[pos++];
    if (t === 0) constants.push({ type: "nil" });
    else if (t === 1) { constants.push({ type: "bool", value: v[pos++] !== 0 }); }
    else if (t === 3) constants.push({ type: "number", value: readDouble() });
    else if (t === 4) constants.push({ type: "string", value: readString() });
    else throw new Error("type " + t);
  }
  const protoCount = readUInt(sizeofInt);
  for (let i = 0; i < protoCount; i++) parseFunction();
  const lineInfoCount = readUInt(sizeofInt);
  pos += lineInfoCount * sizeofInt;
  const localCount = readUInt(sizeofInt);
  for (let i = 0; i < localCount; i++) {
    readString();
    pos += sizeofInt + sizeofInt;
  }
  const upCount = readUInt(sizeofInt);
  for (let i = 0; i < upCount; i++) readString();
}
parseFunction();

const limit = Number(process.argv[3] ?? 200);
for (let i = 0; i < Math.min(limit, constants.length); i++) {
  console.log(`${i}\t${constants[i].type}\t${JSON.stringify(constants[i].value)}`);
}
console.log(`\nTotal: ${constants.length} constants`);
void mod;
