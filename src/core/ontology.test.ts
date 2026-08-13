import { describe, expect, it } from "vitest";
import {
  kindChangeRefusal,
  seedOntology,
  validateInput,
  validateTypeDef,
} from "./ontology.js";

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

// `add-type` is the one write that does not pass the commit gate — it changes the rules the gate applies
// — and it validated `name` and `kind` and nothing else. The ttl cases are the ones that cost knowledge
// rather than crashing: silent, permanent, and indistinguishable from a TTL that genuinely elapsed.
describe("validateTypeDef", () => {
  it("accepts a well-formed definition", () => {
    expect(
      validateTypeDef({
        name: "runbook",
        kind: "entity",
        attrs: { title: { type: "string", required: true } },
        ttl_days: 30,
      }),
    ).toBeNull();
  });

  it("accepts a type with no attributes, which the seed itself has", () => {
    expect(
      validateTypeDef({ name: "term", kind: "entity", attrs: {} }),
    ).toBeNull();
  });

  it.each([
    [
      "no kind at all — broke `ontology list` for every type in the database",
      { name: "j", attrs: {} },
      /kind must be/,
    ],
    [
      "an invented kind",
      { name: "j", kind: "wormhole", attrs: {} },
      /kind must be/,
    ],
    [
      "a non-string name",
      { name: 12345, kind: "entity", attrs: {} },
      /name must be/,
    ],
    [
      "an empty name",
      { name: "  ", kind: "entity", attrs: {} },
      /name must be/,
    ],
    [
      "attrs as a string — rendered four attributes called 0,1,2,3",
      { name: "j", kind: "entity", attrs: "nope" },
      /attrs must be/,
    ],
    [
      "an unsatisfiable attribute type",
      { name: "j", kind: "entity", attrs: { x: { type: "datetime" } } },
      /type must be one of/,
    ],
    [
      "an empty attribute name, which no ontology can address",
      { name: "j", kind: "entity", attrs: { "": { type: "string" } } },
      /attribute name cannot be empty/,
    ],
    [
      "a non-numeric ttl — withheld every record of the type forever",
      { name: "j", kind: "entity", attrs: {}, ttl_days: "soon" },
      /ttl_days must be/,
    ],
    [
      "a negative ttl — stale on arrival",
      { name: "j", kind: "entity", attrs: {}, ttl_days: -30 },
      /ttl_days must be/,
    ],
    [
      "a fractional ttl",
      { name: "j", kind: "entity", attrs: {}, ttl_days: 1.5 },
      /ttl_days must be/,
    ],
    [
      "an entity claiming a relation's flag",
      { name: "j", kind: "entity", attrs: {}, symmetric: true },
      /relation types/,
    ],
    [
      "a relation claiming an entity's flag",
      { name: "j", kind: "relation", attrs: {}, structural: true },
      /entity types/,
    ],
    ["not an object at all", "just a string", /must be a JSON object/],
  ])("refuses %s", (_why, def, expected) => {
    expect(validateTypeDef(def)).toMatch(expected);
  });

  it("allows ttl_days: 0, which is a real choice", () => {
    // Everything of this type is stale the moment it is confirmed. Odd, but it is what a caller asking
    // for "always needs re-confirmation" means, and the tests use it to age a record deliberately.
    expect(
      validateTypeDef({ name: "j", kind: "entity", attrs: {}, ttl_days: 0 }),
    ).toBeNull();
  });
});

describe("kindChangeRefusal", () => {
  it("allows a caller's own unused type to be corrected", () => {
    // No remove-type exists, so refusing here would trap someone with an unusable declaration.
    expect(kindChangeRefusal("my_type", "entity", "relation", 0)).toBeNull();
  });

  it("refuses a populated type", () => {
    expect(kindChangeRefusal("my_type", "entity", "relation", 3)).toMatch(
      /has records/,
    );
  });

  it("refuses a seeded type whatever its row count", () => {
    // `{"name":"fact","kind":"relation"}` was accepted: stored facts kept being injected as entities
    // while `yoke add fact` started being refused as a relation needing from/to. An empty fact table is
    // not permission to redefine what every surface and test is written against.
    expect(kindChangeRefusal("fact", "entity", "relation", 0)).toMatch(
      /seeded types/,
    );
  });

  it("is silent when the kind is unchanged", () => {
    expect(kindChangeRefusal("fact", "entity", "entity", 99)).toBeNull();
  });
});
