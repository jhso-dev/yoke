// A source guard: no Korean string may still be English.
//
// `verify` and `deprecate` shipped as English buttons on the Korean UI because the dictionary said
// `verify: "verify"` — the file typechecked, the key was read, the screen rendered, and nothing
// anywhere noticed the value had never been translated. Every locale being `typeof en` catches a
// MISSING key; it cannot catch a key that was filled in with the English.
//
// The rule the dictionary follows, and this test enforces: a stored value is not translated (status
// names, audit action names, type and relation names, CLI commands and scope names), because those
// strings live in the database and the CLI and a second name for them is a second thing. Anything
// said TO a person is translated. The exemptions below are the whole of the first category.

import { describe, expect, it } from "vitest";
import { en } from "./en";
import { ko } from "./ko";

/** Values that are deliberately not Korean, each because it is a stored value or an identifier. */
const KEEPS_ENGLISH: Record<string, string> = {
  "common.version": "the column header for a version number, not a word",
  "ontology.attrsExample": "attribute names, typed into the form as-is",
  "login.addPrefix": "empty in ko — the sentence is ordered differently",
};

function leaves(obj: object, prefix = ""): [string, unknown][] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === "object" ? leaves(v, path) : [[path, v]];
  });
}

describe("ko dictionary", () => {
  it("has no value that is still English", () => {
    const english = leaves(ko)
      .filter(([path, v]) => typeof v === "string" && !(path in KEEPS_ENGLISH))
      // Hangul present is the signal. A Korean sentence may well contain `draft` or a `yoke …`
      // command inside it — that is the rule working, not a violation. What must not happen is a
      // value with no Korean in it at all.
      .filter(([, v]) => !/[가-힣]/.test(v as string))
      .map(([path]) => path);
    expect(english).toEqual([]);
  });

  it("actually detects an untranslated value", () => {
    // Non-vacuity: `verify: "verify"` is the exact shape that shipped, so assert it would fail.
    expect(/[가-힣]/.test("verify")).toBe(false);
    expect(/[가-힣]/.test("검증")).toBe(true);
  });

  it("exempts nothing that no longer exists", () => {
    const paths = new Set(leaves(en).map(([p]) => p));
    expect(Object.keys(KEEPS_ENGLISH).filter((p) => !paths.has(p))).toEqual([]);
  });
});
