import { describe, expect, it } from "vitest";
import { seedOntology, validateInput } from "./ontology.js";

const ont = seedOntology();

describe("validateInput", () => {
  it("rejects unregistered type", () => {
    const r = validateInput(ont, { type: "nope", attributes: {} });
    expect(r.ok).toBe(false);
  });

  it("rejects missing required attribute", () => {
    const r = validateInput(ont, {
      type: "decision",
      attributes: { conclusion: "ship it" }, // rationale missing
    });
    expect(r.ok).toBe(false);
  });

  it("rejects type mismatch", () => {
    const r = validateInput(ont, {
      type: "decision",
      attributes: { conclusion: "ship it", rationale: 42 },
    });
    expect(r.ok).toBe(false);
  });

  it("passes valid decision", () => {
    const r = validateInput(ont, {
      type: "decision",
      attributes: {
        conclusion: "ship it",
        rationale: "reviewed",
        rejected_alternatives: ["wait", "cancel"],
      },
    });
    expect(r.ok).toBe(true);
  });

  it("names every missing required attribute at once", () => {
    const r = validateInput(ont, { type: "decision", attributes: {} });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("conclusion");
    expect(r.reason).toContain("rationale");
  });

  it("treats an empty required value as absent", () => {
    const blank = validateInput(ont, {
      type: "fact",
      attributes: { statement: "" },
    });
    expect(blank.ok).toBe(false);

    // A non-required attribute may still be empty, and false/0 are values.
    const ok = validateInput(ont, {
      type: "fact",
      attributes: { statement: "s", title: "" },
    });
    expect(ok.ok).toBe(true);
  });

  it("reports a kind mismatch as itself, not as a missing attribute", () => {
    // `link <person> decision <id>` — an entity type in the relation slot. Answering "missing
    // required attribute: conclusion" sent the caller to add one, which cannot help.
    const asRelation = validateInput(ont, {
      type: "decision",
      attributes: {},
      from: "a",
      to: "b",
    });
    expect(asRelation.ok).toBe(false);
    if (asRelation.ok) return;
    expect(asRelation.reason).toContain("entity type");
    expect(asRelation.reason).not.toContain("conclusion");

    const asEntity = validateInput(ont, { type: "works_on", attributes: {} });
    expect(asEntity.ok).toBe(false);
    if (asEntity.ok) return;
    expect(asEntity.reason).toContain("relation type");
  });

  it("requires non-empty from/to on relation", () => {
    const missing = validateInput(ont, {
      type: "relates_to",
      attributes: {},
      from: "",
      to: "b",
    });
    expect(missing.ok).toBe(false);

    const ok = validateInput(ont, {
      type: "relates_to",
      attributes: {},
      from: "a",
      to: "b",
    });
    expect(ok.ok).toBe(true);
  });
});
