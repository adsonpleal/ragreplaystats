// CSV writing, next to the PDF and XLSX plumbing it shares `downloadBlob` with.
//
// The project had no CSV export before the Drops tab, so the flavour is picked
// for the audience rather than inherited:
//
//  - `;` as the separator, because pt-BR Windows sets the list separator to `;`
//    and Excel splits on that one. A comma-separated file opens as a single
//    column there, which is the whole reason people ask for CSV instead of the
//    XLSX this app already writes.
//  - A UTF-8 BOM, because Excel reads a BOM-less file as the ANSI code page and
//    turns "Poção Vermelha" into "PoÃ§Ã£o".
//  - CRLF, which Excel and every other spreadsheet accept.
//
// Fractional numbers go in through `fmtDecimal`, so they carry the decimal
// comma that the `;` separator assumes.

const SEP = ";";
const EOL = "\r\n";
const BOM = "﻿";

function cell(value: string | number): string {
  const text = typeof value === "number" ? String(value) : value;
  if (!/[;"\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

export function toCsv(header: readonly string[], rows: readonly (string | number)[][]): string {
  const lines = [header.map(cell).join(SEP)];
  for (const row of rows) lines.push(row.map(cell).join(SEP));
  return BOM + lines.join(EOL) + EOL;
}

export function csvBlob(text: string): Blob {
  return new Blob([text], { type: "text/csv;charset=utf-8" });
}
