import { describe, expect, it } from "vitest";

import { effectStrUrl, effectTextureUrl } from "./ragassets";

/**
 * Korean effect assets reach us through roBrowser's table spelled one byte per
 * character ("버서크" stored as "¹ö¼­Å©"). The gateway serves them under their
 * real UTF-8 names and 404s that spelling, so these URLs have to undo it. The
 * literals below are written as escapes on purpose: the whole bug is about
 * which bytes a name is made of, and an editor that "helpfully" re-encoded a
 * pasted ¹ö¼­Å© would make the test pass for the wrong reason.
 */
const BERSERK_MOJIBAKE = "¹ö¼­Å©";
const BERSERK = "버서크"; // 버서크

const fileParam = (url: string) => decodeURIComponent(new URL(url).searchParams.get("file") ?? "");

describe("effect asset URLs", () => {
  it("re-reads a byte-wise Korean .str name as the name the gateway serves", () => {
    expect(fileParam(effectStrUrl(BERSERK_MOJIBAKE))).toBe(BERSERK);
  });

  it("does the same for a texture name", () => {
    // Defensive rather than load-bearing: no texture the app asks for today is
    // spelled byte-wise. The rule is the same one, so it is pinned the same way.
    expect(fileParam(effectTextureUrl(`effect/${BERSERK_MOJIBAKE}.tga`))).toBe(
      `effect/${BERSERK}.tga`,
    );
  });

  it("leaves a plain ASCII name exactly as given", () => {
    expect(fileParam(effectStrUrl("new_arrowstorm/new_arrowstorm_00"))).toBe(
      "new_arrowstorm/new_arrowstorm_00",
    );
  });

  it("leaves a name that is ALREADY Korean alone", () => {
    // world-str.json carries real UTF-8 names; decoding those again would
    // destroy them. Code points past 0xFF are the tell.
    expect(fileParam(effectStrUrl(BERSERK))).toBe(BERSERK);
  });

  it("keeps a high-byte name that is not valid CP949 rather than mangling it", () => {
    // 0xFF is not a legal CP949 lead byte; the name goes through untouched and
    // the gateway gets to answer for it.
    expect(fileParam(effectStrUrl("ÿÿ"))).toBe("ÿÿ");
  });

  it("leaves a lone high byte before an ASCII character alone", () => {
    // The guard that makes this safe in general: CP949 wants a trail byte in
    // the high range, so a letter, digit, slash or backslash after one high
    // byte is a decode failure and the name passes through. That is why `%d`
    // variants and path separators cannot be eaten.
    expect(fileParam(effectStrUrl("\u00c5a/b"))).toBe("\u00c5a/b");
  });

  it("DOES rewrite a Latin-1 name whose bytes happen to be valid CP949", () => {
    // The one way this can do damage, pinned so it is a known shape rather than
    // a surprise: two 0xC0 bytes are a legal CP949 pair, so a name that really
    // was Latin-1 comes back Korean. No name in either effect table falls into
    // this class — "café" is safe, because 0x65 0xe9 is not a legal pair — and
    // the gateway 404s whatever it is handed, so the cost is a missing effect
    // rather than a wrong one.
    expect(fileParam(effectStrUrl("\u00c0\u00c0"))).toBe("\uc751");
  });
});
