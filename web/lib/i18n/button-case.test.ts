// A source guard: an English button label starts with a capital.
//
// The house rule is sentence case on controls, and it had drifted — `new record`, `verify`,
// `select all` sat next to headings that were `Review queue` and `Browse`. Rather than keep a list
// of "these keys are buttons" in two places and watch it rot, this reads the screens: any dictionary
// key rendered as the CHILD of a <Button> or a `.btn` link is a label, and its English must be
// capitalised. A key used in `title=`/`aria-label=` is a sentence, not a label, and is left alone —
// which is why the match excludes attribute positions.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { en } from "./en";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.tsx$/.test(name) && !name.includes(".test.")) out.push(p);
  }
  return out;
}

/** `{t.common.verify}` as a child, never `title={t.common.verifyHint}` as a prop. */
const CHILD = /(?<![=$])\{(?:t|tr)\.([\w.]+)\}/g;
const CONTROL =
  /<Button[\s\S]*?<\/Button>|<Link[^>]*className="btn"[\s\S]*?<\/Link>/g;

function value(path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (o, k) => (o as Record<string, unknown> | undefined)?.[k],
      en,
    );
}

describe("English button labels", () => {
  const labels = new Set<string>();
  for (const f of [join(webRoot, "app"), join(webRoot, "components")]
    .flatMap(sources)
    .filter((f) => !f.includes(`components${"/"}ui${"/"}`))) {
    const src = readFileSync(f, "utf8");
    for (const control of src.match(CONTROL) ?? [])
      for (const m of control.matchAll(CHILD)) labels.add(m[1]);
  }

  it("finds the labels at all", () => {
    // Non-vacuity: an extractor that matched nothing would pass every assertion below.
    expect(labels.size).toBeGreaterThan(10);
    expect(labels.has("common.verify")).toBe(true);
  });

  it("start with a capital", () => {
    const lower = [...labels]
      .map((p) => [p, value(p)] as const)
      .filter(([, v]) => typeof v === "string")
      // The first LETTER, not the first character: punctuation before a label is allowed.
      .filter(([, v]) => /^[^A-Za-z]*[a-z]/.test(v as string))
      .map(([p, v]) => `${p}: ${v}`);
    expect(lower).toEqual([]);
  });
});
