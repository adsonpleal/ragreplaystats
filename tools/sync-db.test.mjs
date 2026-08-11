// Tests for the public/db/ transforms in tools/sync-db.mjs.
//
// The inputs are committed slices of ragassets' /raw tables (tools/__fixtures__/
// raw/), chosen to hit the cases that are easy to break: the `[N]` slot suffix
// we rebuild, the unnamed rows we drop, `view` only when set, the food-buff
// overlay, and the class-name fallbacks. Nothing here touches the network — a
// test that fetched from ragassets would go red on a client update, which is
// exactly when we most need it green.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  FOOD_STATUS_NAMES,
  JOB_NAME_OVERRIDE,
  buildItems,
  buildJobs,
  buildRandomOpt,
  buildSkills,
  buildStatus,
} from "./sync-db.mjs";

const fixture = (name) =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`__fixtures__/raw/${name}.json`, import.meta.url)), "utf8"),
  );

describe("buildItems", () => {
  const items = buildItems(fixture("items"));

  it("keeps a plain item as a bare name", () => {
    expect(items["501"]).toEqual({ name: "Poção Vermelha" });
  });

  it("rebuilds the slot suffix the client shows", () => {
    // /raw keeps `name` bare so each consumer formats it its own way; the app
    // shows "Espada [3]", which is also what distinguishes 1101 from 1103.
    expect(items["1101"]).toEqual({ name: "Espada [3]", view: 2 });
    expect(items["1119"]).toEqual({ name: "Tsurugi [1]", view: 39 });
    expect(items["1103"].name).toBe("Espada");
  });

  it("omits `view` when the item has no sprite id", () => {
    expect(items["501"]).not.toHaveProperty("view");
    expect(items["1103"].view).toBe(2);
  });

  it("skips unnamed rows even when they carry a view", () => {
    // ~640 /raw rows have no label; item 1174 is one that still has a view id.
    expect(items).not.toHaveProperty("556");
    expect(items).not.toHaveProperty("1174");
  });
});

describe("buildJobs", () => {
  const jobs = buildJobs(fixture("jobs"));

  it("uses the client label when there is one", () => {
    expect(jobs["0"]).toBe("Aprendiz");
    expect(jobs["4054"]).toBe("Cavaleiro Rúnico");
  });

  it("falls back to the base class for unlabelled _H/_B classes", () => {
    // The client labels no trans 3rd class, so they inherit their base name.
    expect(jobs["4060"]).toBe("Cavaleiro Rúnico"); // JT_RUNE_KNIGHT_H
    // Baby classes all carry their own "Mini …" label today, so the _B half of
    // the rule has no live example — keep it covered anyway.
    const baby = buildJobs([
      { id: 1, jt: "JT_SWORDMAN", name: "Espadachim" },
      { id: 2, jt: "JT_SWORDMAN_B", name: null },
    ]);
    expect(baby["2"]).toBe("Espadachim");
  });

  it("prefers a class's own label over the base one", () => {
    expect(jobs["4023"]).toBe("Mini Aprendiz"); // not "Aprendiz"
  });

  it("lets the server's ids win over the kRO defaults", () => {
    // PLAYER_JT_IDS says JT_RUNE_KNIGHT_H is 4067; LATAM's pcidentity.lub says
    // 4060, and jobs.json carries that — so 4067 must stay unnamed.
    expect(jobs).not.toHaveProperty("4067");
  });

  it("pins the 4th-class names /raw cannot carry", () => {
    // pcidentity.lub numbers none of the 4th classes, so jobs.json has no row
    // for them at all — they exist only via PLAYER_JT_IDS + JOB_NAME_OVERRIDE.
    expect(Object.keys(JOB_NAME_OVERRIDE)).toHaveLength(13);
    expect(jobs["4252"]).toBe("Cavaleiro Draconiano");
    expect(jobs["4264"]).toBe("Diva");
  });

  it("drops icon-only rows and ids nothing names", () => {
    expect(jobs).not.toHaveProperty("13"); // JT_KNIGHT2, an alt sprite
    expect(jobs).not.toHaveProperty("4302"); // JT_DRAGON_KNIGHT2, mounted
  });
});

describe("buildSkills", () => {
  it("keys names by id", () => {
    expect(buildSkills(fixture("skills"))).toEqual({
      1: { name: "Habilidades Básicas" },
      5: { name: "Golpe Fulminante" },
      2001: { name: "Encantar Lâmina" },
    });
  });
});

describe("buildRandomOpt", () => {
  it("keeps the bare template string as the value", () => {
    // No wrapper object here — the UI fills "%d" from the replay's value.
    expect(buildRandomOpt(fixture("randomopt"))).toEqual({
      1: "HP máx. +%d",
      2: "SP máx. +%d",
      19: "ATQM +%d",
    });
  });
});

describe("buildStatus", () => {
  const status = buildStatus(fixture("status"));

  it("keys names by EFST id", () => {
    expect(status["0"]).toEqual({ name: "Provocar" });
  });

  it("names the food buffs the client titles '%s'", () => {
    // The client substitutes the food item name at runtime, so the raw title is
    // a literal "%s" — 241 and its cash twin 271 are the same effect.
    expect(status["241"]).toEqual({ name: "Comida de FOR" });
    expect(status["271"]).toEqual({ name: "Comida de FOR" });
    expect(status["247"]).toEqual({ name: "Comida de Esquiva" });
  });

  it("adds the food buffs even when /raw has no row for them", () => {
    expect(fixture("status").some((s) => s.id === 249)).toBe(false);
    expect(status["249"]).toEqual({ name: "Comida de Crítico" });
    expect(Object.keys(status)).toHaveLength(
      new Set([...fixture("status").map((s) => String(s.id)), ...Object.keys(FOOD_STATUS_NAMES)]).size,
    );
  });
});
