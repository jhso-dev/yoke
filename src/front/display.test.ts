import { describe, expect, it } from "vitest";
import { seedOntology } from "../core/ontology.js";
import { injectDetail, summarize, ULID } from "./display.js";

const ont = seedOntology();

describe("summarize", () => {
  it("prefers a required attribute over whatever was written first", () => {
    // The defect this fixes: three decisions on different conclusions all read "caching", because
    // `topic` happened to be the first string attribute and is not part of the decision schema.
    const e = {
      type: "decision",
      attributes: {
        topic: "caching",
        conclusion: "Use Redis for caching",
        rationale: "measured on the caching path",
      },
    };
    expect(summarize(e, ont)).toBe("Use Redis for caching");
  });

  it("never summarises a connector row as its idempotency key", () => {
    // The bug the CLI fixed and the web tier still had: `rdb:table:1` instead of the knowledge.
    const e = {
      type: "fact",
      attributes: {
        external_id: "rdb:table:1",
        author: "someone",
        statement: "The index rebuilds nightly.",
      },
    };
    expect(summarize(e, ont)).toBe("The index rebuilds nightly.");
  });

  it("falls back to the first content string when the type declares nothing required", () => {
    // `person` has no declared attrs at all, so convention is all there is.
    expect(
      summarize({ type: "person", attributes: { name: "Bora" } }, ont),
    ).toBe("Bora");
  });

  it("shows bookkeeping rather than nothing when that is all there is", () => {
    // An empty cell is worse than an imperfect one: the row would look like a broken record.
    expect(
      summarize({ type: "fact", attributes: { external_id: "rdb:t:9" } }, ont),
    ).toBe("rdb:t:9");
  });

  it("truncates to 60 characters", () => {
    const long = "x".repeat(200);
    expect(
      summarize({ type: "fact", attributes: { statement: long } }, ont),
    ).toHaveLength(60);
  });

  it("returns empty string when there is no string attribute at all", () => {
    expect(summarize({ type: "fact", attributes: { n: 4 } }, ont)).toBe("");
  });

  it("tolerates a type absent from the ontology", () => {
    // A tenant ontology may not declare a type this row uses; that must not throw.
    expect(summarize({ type: "unknown", attributes: { a: "hi" } }, ont)).toBe(
      "hi",
    );
  });
});

describe("injectDetail", () => {
  const A = "01KZ0000000000000000000001";
  const ids = ["01KZ000000000000000000000A", "01KZ000000000000000000000B"];

  it("writes the four legal shapes, and nothing else", () => {
    expect(injectDetail(ids, { query: "caching" })).toBe(
      `caching -> ${ids.join(" ")}`,
    );
    expect(injectDetail(ids, { query: "caching", scope: A })).toBe(
      `${A} caching -> ${ids.join(" ")}`,
    );
    // A briefing is an anchor with no query, so the subject is the anchor alone.
    expect(injectDetail(ids, { scope: A })).toBe(`${A} -> ${ids.join(" ")}`);
    expect(
      injectDetail(ids, {
        query: "caching",
        scope: A,
        asOf: "2026-07-15T00:00:00Z",
      }),
    ).toBe(`${A} @2026-07-15T00:00:00Z caching -> ${ids.join(" ")}`);
  });

  it("never emits a double space, so the subject tokenizes cleanly", () => {
    // The audit route splits the subject on spaces to find the ids in it. A missing middle slot
    // joined with a space would leave a blank token between two real ones — an interior double space
    // is the thing to rule out. A wholly empty subject (no query, no anchor) stays legal: it is the
    // shape every unanchored briefing already wrote, and the reader filters it out.
    for (const opts of [
      { scope: A },
      { query: "q" },
      { scope: A, asOf: "2026-07-15T00:00:00Z" },
      { query: "q", asOf: "2026-07-15T00:00:00Z" },
      {},
    ]) {
      const subject = injectDetail(ids, opts).split(" -> ")[0];
      expect(subject).not.toContain("  ");
      expect(subject).toBe(subject.trim());
    }
  });

  it("the anchor token matches ULID, so the audit route resolves it for reading", () => {
    // The one coupling between this formatter and the audit route: the route looks up whatever token
    // matches ULID. If they disagreed, an anchor would render as a raw id beside resolved names.
    const subject = injectDetail(ids, { query: "caching", scope: A }).split(
      " -> ",
    )[0];
    expect(subject.split(" ").filter((t) => ULID.test(t))).toEqual([A]);
    // And an as-of instant must NOT look like one — `@` is what keeps a timestamp out of the lookup.
    const withAsOf = injectDetail(ids, {
      scope: A,
      asOf: "2026-07-15T00:00:00Z",
    }).split(" -> ")[0];
    expect(withAsOf.split(" ").filter((t) => ULID.test(t))).toEqual([A]);
  });
});
