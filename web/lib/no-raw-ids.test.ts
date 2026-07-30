// A source guard: no screen may put an opaque id where a person reads meaning.
//
// This is a grep, not a render test, and that is deliberate. The defect class here has now escaped
// twice — raw ULIDs in the actor and source columns, then again in the audit detail and the entity
// panel — and both times every payload assertion passed, because the payloads were right. Rendering
// tests would need a DOM this project does not carry. Scanning the source for the three patterns that
// actually produced the defect costs nothing and fails the moment one comes back.
//
// If a screen legitimately needs one of these, the exemption belongs here, named, with a reason.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(name) && !name.includes(".test.")) out.push(p);
  }
  return out;
}

const files = [join(webRoot, "app"), join(webRoot, "components")]
  .flatMap(sources)
  .map((p) => ({ path: relative(webRoot, p), text: readFileSync(p, "utf8") }));

/** Files allowed to touch a raw value, because turning it into something readable IS their job. */
const OWNERS = {
  actor: ["components/Actor.tsx"],
  citation: ["components/Citation.tsx"],
};

/**
 * `{x.field}` sitting in a JSX text position — i.e. what a person actually reads.
 *
 * Two contexts are NOT that and must not match: a prop value (`actor={row.actor}`, which is how you
 * hand the raw value to the component whose job is rendering it) and a template interpolation
 * (`${e.actor}` in a React key or a title). Both are legitimate uses of the raw id.
 */
const renderedInText = (field: string) =>
  new RegExp(`(?<!${field}=)(?<!\\$)\\{[\\w.]*\\.${field}\\}`);

describe("no raw ids in human-facing renders", () => {
  it("scans a non-trivial number of screens", () => {
    // Guards the guard: a broken path glob would make every assertion below vacuously pass.
    expect(files.length).toBeGreaterThan(10);
    expect(files.map((f) => f.path)).toContain("components/KnowledgeTable.tsx");
  });

  it("never falls back to a bare id when a summary is missing", () => {
    // `{r.summary || r.id}` is what put a 26-char ULID in the one cell people read. recordLabel()
    // renders `type shortid` instead, which at least says what the thing is.
    for (const f of files) {
      expect(
        f.text,
        `${f.path}: use recordLabel(row) instead of a summary-or-id fallback`,
      ).not.toMatch(/summary\s*\|\|\s*\w+\.id/);
    }
  });

  it("actually catches the defect it is guarding against", () => {
    // Non-vacuity. A regex tightened until it stops firing is a test that passes forever, which is how
    // the last two display defects survived. These are the exact shapes that shipped.
    expect('<td className="mono">{e.actor}</td>').toMatch(
      renderedInText("actor"),
    );
    expect('<span className="cite">{chosen.citation}</span>').toMatch(
      renderedInText("citation"),
    );
    expect("{r.summary || r.id}").toMatch(/summary\s*\|\|\s*\w+\.id/);
    // And does not fire on the legitimate contexts, or the guard would block the fix itself.
    expect("<Actor actor={r.actor} actorName={r.actorName} />").not.toMatch(
      renderedInText("actor"),
    );
    // The literal `${` is the fixture: this asserts the guard ignores a template interpolation, so
    // the placeholder must survive as source text rather than being evaluated.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test, not a template.
    expect("key={`${e.at}-${e.actor}`}").not.toMatch(renderedInText("actor"));
  });

  it("renders an actor only through <Actor>", () => {
    for (const f of files) {
      if (OWNERS.actor.includes(f.path)) continue;
      // A JSX text position holding .actor — `{e.actor}` or `{d.entity.actor}`.
      expect(
        f.text,
        `${f.path}: render the actor with <Actor actor={…} actorName={…} />`,
      ).not.toMatch(renderedInText("actor"));
    }
  });

  it("renders a citation only through <Citation>", () => {
    for (const f of files) {
      if (OWNERS.citation.includes(f.path)) continue;
      expect(
        f.text,
        `${f.path}: render the source with <Citation row={…} />`,
      ).not.toMatch(renderedInText("citation"));
    }
  });
});
