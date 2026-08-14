// A source guard: no screen may put an opaque id where a person reads meaning.
//
// This is a grep, not a render test, and that is deliberate. The defect class here has now escaped
// twice — raw ULIDs in the actor and source columns, then again in the audit detail and the entity
// panel — and both times every payload assertion passed, because the payloads were right. Rendering
// tests would need a DOM this project does not carry. Scanning the source for the three patterns that
// actually produced the defect costs nothing and fails the moment one comes back.
//
// If a screen legitimately needs one of these, the exemption belongs here, named, with a reason.

import { readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sources } from "./sources";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const files = [join(webRoot, "app"), join(webRoot, "components")]
  .flatMap((d) => sources(d))
  .map((p) => ({
    // Posix separators, always: node:path returns `components\Actor.tsx` on win32, so every path
    // literal in this file — the OWNERS exemptions included — would silently stop matching there.
    // A guard whose exemption list misses is a guard that fails on the files it is meant to excuse.
    path: relative(webRoot, p).split(sep).join("/"),
    text: readFileSync(p, "utf8"),
  }));

/** Files allowed to touch a raw value, because turning it into something readable IS their job. */
const OWNERS = {
  actor: ["components/Actor.tsx"],
  citation: ["components/Citation.tsx"],
  instant: ["components/Instant.tsx"],
};

/** The timestamp fields, all of which arrive as `2026-07-30T07:43:58.846Z`. */
const INSTANTS = ["occurred_at", "last_confirmed", "at"];

/**
 * `{x.field}` sitting in a JSX text position — i.e. what a person actually reads.
 *
 * Two contexts are NOT that and must not match: any prop value (`actor={row.actor}`, `iso={e.at}`,
 * `title={row.citation}` — all of them hand the raw value to whatever is responsible for rendering or
 * preserving it) and a template interpolation (`${e.actor}` in a React key). Both are legitimate.
 *
 * The prop test is `=` immediately before the brace, not the field's own name: `iso={e.at}` is a prop
 * position too, and a per-field name list would have flagged the fix as the defect.
 *
 * A dictionary lookup is excluded by the same reasoning. `{t.common.actor}` is the translated COLUMN
 * LABEL for the actor column — the word "actor" — not an actor id, and the guard has no way to tell
 * a field access from a key lookup except by what it is reading from. `t` and `tr` are the only
 * bindings useT() is assigned to; if a third appears, it belongs in this pattern.
 */
const renderedInText = (field: string) =>
  new RegExp(`(?<![=$])\\{(?!t\\.|tr\\.)[\\w.]*\\.${field}\\}`);

/**
 * The same field passed RAW as a direct argument of a dictionary function in a text position —
 * `{t.retire.retiredBy(d.retirement.actor, …)}`.
 *
 * `renderedInText` cannot see this: it excludes any brace starting `{t.`, so the raw id sitting INSIDE
 * the sentence the dictionary builds was invisible, and a bare ULID rendered in "Retired by <id> …".
 * The resolved sentence still reads through the dictionary — the fix is to hand it a name (an <Actor>,
 * or `x.actorName ?? …`), not the id.
 *
 * Two contexts stay excluded, and both are correct. A PROP is not text — `title={t.chrome.authedAs(
 * meta.actor)}` keeps the id on hover, which is the rule, so the leading `(?<![=$])` skips it. And a
 * value WRAPPED in a resolver — `t.retire.retiredBy(localTime(d.retirement.at))` — is not raw: `[^()]*`
 * stops at the resolver's own `(`, so only a field that is a DIRECT argument of the dictionary call
 * matches.
 */
const inDictCall = (field: string) =>
  new RegExp(`(?<![=$])\\{(?:t|tr)\\.[\\w.]+\\([^()]*\\.${field}\\b`);

describe("no raw ids in human-facing renders", () => {
  it("scans a non-trivial number of screens", () => {
    // Guards the guard: a broken path glob would make every assertion below vacuously pass.
    expect(files.length).toBeGreaterThan(10);
    expect(files.map((f) => f.path)).toContain("components/KnowledgeTable.tsx");
    // And asserts the normalization on every platform, not just the one that needs it: a win32 path
    // would keep its backslashes, the OWNERS exemptions would stop matching, and the failure would be
    // in a job most local runs never execute. This line fails everywhere if the normalization goes.
    for (const f of files) expect(f.path).not.toContain("\\");
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
    // A prop position whose name is not the field's — the exact shape every one of these fixes takes.
    expect("<Instant iso={e.at} />").not.toMatch(renderedInText("at"));
    expect("title={row.citation}").not.toMatch(renderedInText("citation"));
    // A translated label, not a value read off a record. Both of these shipped and both were
    // flagged, which is what sent the guard looking at what it was reading FROM.
    expect("<th>{t.common.actor}</th>").not.toMatch(renderedInText("actor"));
    expect("<th>{t.entity.citation}</th>").not.toMatch(
      renderedInText("citation"),
    );
    // A raw id passed straight into a dictionary function — the shape that shipped a ULID inside
    // "Retired by <id> …", which `renderedInText` skipped because the brace starts `{t.`.
    expect("{t.retire.retiredBy(d.retirement.actor, when)}").toMatch(
      inDictCall("actor"),
    );
    // A name handed to the same function is fine; only the raw id field is caught.
    expect("{t.retire.retiredBy(when)}").not.toMatch(inDictCall("actor"));
    // A resolver-wrapped value is not raw — the id/instant never reaches the screen.
    expect("{t.retire.retiredBy(localTime(d.retirement.at))}").not.toMatch(
      inDictCall("at"),
    );
    // A prop keeps the id on hover, which is the rule, not the defect.
    expect("title={t.chrome.authedAs(meta.actor)}").not.toMatch(
      inDictCall("actor"),
    );
    // ...and the exemption is narrow: a record still cannot be rendered raw.
    expect("<td>{t.actor}</td>").not.toMatch(renderedInText("actor"));
    expect("<td>{event.actor}</td>").toMatch(renderedInText("actor"));
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
      // …or handed raw into a dictionary sentence — resolve it first (an <Actor>, or actorName ?? id).
      expect(
        f.text,
        `${f.path}: resolve the actor before passing it to a dictionary function`,
      ).not.toMatch(inDictCall("actor"));
    }
  });

  it("renders a citation only through <Citation>", () => {
    for (const f of files) {
      if (OWNERS.citation.includes(f.path)) continue;
      expect(
        f.text,
        `${f.path}: render the source with <Citation row={…} />`,
      ).not.toMatch(renderedInText("citation"));
      expect(
        f.text,
        `${f.path}: resolve the citation before passing it to a dictionary function`,
      ).not.toMatch(inDictCall("citation"));
    }
  });

  it("renders an instant only through <Instant>", () => {
    // Same defect class as a raw id, one field over: an ISO UTC string with milliseconds is the right
    // thing to store and unreadable to the person asking when something happened. `.at(-1)` on an array
    // is not a match — the pattern requires the closing brace straight after the field.
    for (const field of INSTANTS) {
      expect(`<td className="mono">{e.${field}}</td>`).toMatch(
        renderedInText(field),
      );
      for (const f of files) {
        if (OWNERS.instant.includes(f.path)) continue;
        expect(
          f.text,
          `${f.path}: render ${field} with <Instant iso={…} /> — the viewer's zone, ISO kept on hover`,
        ).not.toMatch(renderedInText(field));
        // A raw instant handed straight to a dictionary sentence — format it (localTime) first.
        expect(
          f.text,
          `${f.path}: format ${field} (localTime) before passing it to a dictionary function`,
        ).not.toMatch(inDictCall(field));
      }
    }
    expect("const after = cursors.at(-1);").not.toMatch(renderedInText("at"));
  });
});
