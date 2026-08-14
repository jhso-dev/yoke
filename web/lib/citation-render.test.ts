// A source guard: a screen that shows knowledge must also show its source.
//
// "Knowledge is always shown with its source and version" (WEB-UI.md) cannot be enforced by types: a
// required `citation` field guarantees the DATA carries a source and says nothing about whether a
// screen RENDERS one. So this is a grep over the source, the same shape no-raw-ids.test.ts uses,
// plus a named exemption list.
//
// The predicate: a file that renders a record label or a status badge is displaying knowledge. The
// obligation: that file must render `<Citation` or `<KnowledgeTable` (which embeds one per row) — or
// carry an exemption here, named, with the reason a source genuinely does not belong on that surface.

import { readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sources } from "./sources";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const files = [join(webRoot, "app"), join(webRoot, "components")]
  .flatMap((d) => sources(d, /\.tsx$/))
  .map((p) => ({
    // Posix separators, same reason as no-raw-ids.test.ts: on win32 the exemption paths below would
    // silently stop matching, and an exemption that misses fails the files it exists to excuse.
    path: relative(webRoot, p).split(sep).join("/"),
    text: readFileSync(p, "utf8"),
  }))
  // The shadcn primitives are layout vocabulary, not screens; badge.tsx would otherwise match its own
  // definition the way StatusBadge is excluded below.
  .filter((f) => !f.path.startsWith("components/ui/"));

const SHOWS_KNOWLEDGE = /recordLabel\(|<StatusBadge/;
const SHOWS_SOURCE = /<Citation|<KnowledgeTable/;

/** Surfaces that display a record label without a citation, each with the reason that is correct. */
const EXEMPT: Record<string, string> = {
  "app/audit/page.tsx":
    "an audit row IS provenance (actor, action, instant); the labels it resolves are references, " +
    "and the full detail string with every id stays on the row",
  "components/CreateButton.tsx":
    "names the created record and its duplicate candidates in a one-line toast — a toast cannot " +
    "hold a citation link; each record is one click from its page, where the citation is",
  "components/LinkRecord.tsx":
    "a control caption naming the record being linked — the same screen (entity) renders that " +
    "record's citation in its own panel above the control",
  "components/DisputedLinks.tsx":
    "cross-reference links naming the records a row contradicts; each names a record whose own " +
    "citation is on its own row in the same table, and the link opens its full record",
};

describe("knowledge is shown with its source", () => {
  const showing = files.filter((f) => SHOWS_KNOWLEDGE.test(f.text));

  it("scans a non-trivial number of screens, including the known ones", () => {
    // Guards the guard, twice over: a broken glob or a drifted predicate would make the assertion
    // below vacuous. These five screens display knowledge by design and must keep matching.
    expect(files.length).toBeGreaterThan(10);
    for (const known of [
      "app/graph/page.tsx",
      "app/entity/page.tsx",
      "app/collaboration/page.tsx",
      "app/conflicts/page.tsx",
      "app/persona/page.tsx",
    ])
      expect(showing.map((f) => f.path)).toContain(known);
  });

  it("every screen that shows knowledge also shows a source, or is exempt with a reason", () => {
    const bare = showing
      .filter((f) => !(f.path in EXEMPT))
      .filter((f) => !SHOWS_SOURCE.test(f.text))
      .map((f) => f.path);
    expect(bare).toEqual([]);
  });

  it("carries no dead exemptions", () => {
    // An exemption for a file that no longer matches the predicate (or no longer exists) is a hole
    // waiting to excuse the next regression — remove it when the file stops needing it.
    for (const path of Object.keys(EXEMPT)) {
      const f = files.find((x) => x.path === path);
      expect(f, `${path} no longer exists — drop its exemption`).toBeDefined();
      expect(
        SHOWS_KNOWLEDGE.test((f as { text: string }).text),
        `${path} no longer shows knowledge — drop its exemption`,
      ).toBe(true);
    }
  });
});
