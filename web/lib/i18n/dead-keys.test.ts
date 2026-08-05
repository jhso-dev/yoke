// A source guard: a dictionary key nothing reads is a string that stayed English on screen.
//
// This class has now shipped twice. `browse.newRecord` and `collaboration.newOne` were both
// translated in ko and both unreferenced, because CreateButton built its label from an English
// template literal instead — so the Korean UI said "new record" while the dictionary held "새
// 레코드". A key with no reader is the fingerprint of exactly that mistake, and unlike a scan for
// bare English strings it has no judgement in it: either something reads the key or nothing does.
//
// The reverse direction (a screen reading a key that does not exist) is already a type error, since
// every locale is typed as `typeof en`. This covers the other side.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sources } from "../sources";
import { en } from "./en";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Looked up by computed key (`t.nav[l.key]`, `t.audit.meaning[e.action]`), so no source file
 * spells the leaf out. Checked as a group instead: something must still read the group. */
const DYNAMIC = new Set(["audit.meaning", "nav"]);

function leaves(obj: object, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    if (DYNAMIC.has(path)) return [path];
    return v && typeof v === "object" ? leaves(v, path) : [path];
  });
}

describe("i18n dictionary", () => {
  const source = [join(webRoot, "app"), join(webRoot, "components")]
    .flatMap((d) => sources(d))
    .map((p) => readFileSync(p, "utf8"))
    .join("\n");

  it("has no key that nothing on a screen reads", () => {
    // Matched on the last two segments (`.collaboration.truncated`), not the full path and not the
    // leaf alone. Not the full path because screens alias the root (`const tr = t`); not the leaf
    // alone because two groups can share a name — `inject.truncated` was masking an unused
    // `collaboration.truncated` whose sentence was sitting hardcoded in English on the screen.
    const dead = leaves(en).filter(
      (path) => !source.includes(`.${path.split(".").slice(-2).join(".")}`),
    );
    expect(dead).toEqual([]);
  });

  it("actually detects a dead key", () => {
    // Non-vacuity: without this the test passes just as well against an empty dictionary.
    expect(leaves({ made: { up: "x" } })).toEqual(["made.up"]);
    expect(source.includes(".upNothingReadsThis")).toBe(false);
  });
});
