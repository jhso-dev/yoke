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
      attributes: { conclusion: "ship it" }, // rationale 누락
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
