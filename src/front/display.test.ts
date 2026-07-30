import { describe, expect, it } from "vitest";
import { seedOntology } from "../core/ontology.js";
import { summarize } from "./display.js";

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
