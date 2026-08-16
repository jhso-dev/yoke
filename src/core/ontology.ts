// yoke ontology — type definitions, input validation, and the seed set.
// The validator is a hand-rolled implementation covering only 4 AttrSpec kinds. No schema library.
// ceiling: 4 attribute kinds, validated by hand. Reach for zod if nested object schemas become necessary.

import type { EntityInput, RelationInput } from "./types.js";

export type AttrSpec = {
  type: "string" | "number" | "boolean" | "string[]";
  required?: boolean;
};

export type TypeDef = {
  name: string;
  kind: "entity" | "relation";
  attrs: Record<string, AttrSpec>;
  /** TTL (in days) for freshness. Omit = unlimited. Used by the 2.1 lifecycle. */
  ttl_days?: number;
  /**
   * Relation types only: this edge records WHO IS INVOLVED in something, not knowledge attached to it.
   *
   * An anchored briefing walks every relation on the anchor, so without this a collaboration briefing
   * hands an agent the roster (`works_on` → three person records) as though it were knowledge — and
   * under a limit the roster can crowd the knowledge out entirely.
   *
   * It is ontology DATA, not a name hardcoded in core, because orgs define their own equivalents
   * (assigned_to, member_of, reviews) — see the collaboration note below. A tenant that adds a
   * membership relation marks it here and gets the same behaviour, with no core change.
   */
  membership?: boolean;
  /**
   * Entity types only: an entity of this type NAMES something knowledge is attached to — a person, a
   * piece of work — rather than being something someone recorded as true.
   *
   * The counterpart of `membership` one level down. That keeps a roster RELATION out of a briefing;
   * this keeps the roster's members out of it whatever relation reached them, which matters because
   * `membership` is escapable: link a person to a collaboration with `relates_to` instead of
   * `works_on` and the briefing hands the person over as knowledge again.
   *
   * It is what stops a persona from listing the projects someone created as things they know. A
   * collaboration record is the trace of having started something, not a judgment — and a persona
   * that mixes the two says a person "knows" a project name, under a limit that real judgments then
   * have to compete with.
   *
   * Ontology DATA for the same reason `membership` is: an org whose unit is `squad`, `service` or
   * `initiative` marks that type and gets the behaviour with no core change.
   */
  structural?: boolean;
  /**
   * Relation types only: this edge means the same thing read either way, so `from` and `to` carry no
   * claim — only the order someone happened to type.
   *
   * It exists because direction was being asked for where there is no answer. The link control put a
   * direction toggle on every relation, so recording "these two are related" made the reader choose
   * between two identical facts — and the choice was not free: A→B and B→A are one claim stored as two
   * rows, which is the duplicate the gate is supposed to prevent. With this declared, either
   * direction finds the other and the second commit is a no-op, and the control stops asking.
   *
   * `same_as` is the proof this was always a property of the model rather than a new idea:
   * `identitySet` has always walked it with no direction, because "the same person" cannot have one.
   *
   * Storage is NOT rewritten — the row keeps the direction it was recorded with, because provenance
   * is a record of what happened. What changes is that a second row is no longer created, and that
   * nothing asks a reader to pick.
   */
  symmetric?: boolean;
};

/**
 * Attributes that are bookkeeping rather than what a record says.
 *
 * One set, because every surface that reads a record for its meaning needs the same answer: the CLI
 * and web one-liner (`summarize`), and the text the relater compares records by. `sources` is in it
 * for a sharper reason than the rest — it holds the verbatim span a record rests on, often longer
 * than the record itself, so a surface that falls back to it renders a quote dump instead of a
 * reading, and a batch of them crowds out the records a model is being asked to compare.
 */
export const BOOKKEEPING_ATTRS = new Set([
  "external_id",
  "sources",
  "author",
  "topic",
  "key",
  "status",
]);

/** Whether the actual value matches AttrSpec.type. */
function matchesType(spec: AttrSpec["type"], value: unknown): boolean {
  switch (spec) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "string[]":
      return Array.isArray(value) && value.every((v) => typeof v === "string");
  }
}

export function validateInput(
  ontology: TypeDef[],
  input: EntityInput | RelationInput,
): { ok: true } | { ok: false; reason: string } {
  const def = ontology.find((t) => t.name === input.type);
  if (!def) return { ok: false, reason: `unknown type: ${input.type}` };

  const isRelation = "from" in input;
  if (def.kind === "relation" || isRelation) {
    const r = input as RelationInput;
    if (!r.from)
      return { ok: false, reason: "relation requires non-empty from" };
    if (!r.to) return { ok: false, reason: "relation requires non-empty to" };
  }

  for (const [key, spec] of Object.entries(def.attrs)) {
    const value = input.attributes[key];
    if (value === undefined || value === null) {
      if (spec.required)
        return { ok: false, reason: `missing required attribute: ${key}` };
      continue;
    }
    if (!matchesType(spec.type, value)) {
      return { ok: false, reason: `attribute ${key} must be ${spec.type}` };
    }
  }
  return { ok: true };
}

export function seedOntology(): TypeDef[] {
  return [
    // `name` is declared because a person is referred to by it everywhere a person appears — record
    // labels, personas, the stale-owner roster. Undeclared it still worked from the CLI (the gate is
    // lenient about extra attributes), but the ontology-driven create form offers exactly the
    // declared fields, so the one type whose records anchor personas had a form with no fields.
    {
      name: "person",
      kind: "entity",
      attrs: { name: { type: "string", required: true } },
      structural: true,
    },
    // Declared, and in this order, because the ontology is what tells `summarize` which attribute
    // carries the meaning — undeclared, three types were guessed at, the create form offered zero
    // fields for them, and an empty record committed cleanly.
    //
    // `statement` is required and `title` is not, because that is what the capture path can promise:
    // the Slack and meeting-notes connectors turn a message into a statement and have no honest
    // title to give (inventing one would be writing knowledge nobody recorded). A hand-filed fact
    // adds the title, and then it is what the row reads as.
    //
    // `sources` is declared on every type a connector can file, and declared LAST: it is what a
    // record rests on, so an ontology-driven surface has to offer it — and declared order is what
    // `summarize` reads, so the quote must never be a type's first declared string.
    {
      name: "fact",
      kind: "entity",
      attrs: {
        title: { type: "string" },
        statement: { type: "string", required: true },
        sources: { type: "string" },
      },
      ttl_days: 180,
    },
    {
      name: "decision",
      kind: "entity",
      attrs: {
        conclusion: { type: "string", required: true },
        rationale: { type: "string", required: true },
        rejected_alternatives: { type: "string[]" },
        sources: { type: "string" },
      },
      ttl_days: 365,
    },
    // A term is a name and what it means here; both are required because either alone is unusable —
    // a name with no meaning explains nothing, a meaning with no name cannot be looked up.
    {
      name: "term",
      kind: "entity",
      attrs: {
        title: { type: "string", required: true },
        statement: { type: "string", required: true },
        sources: { type: "string" },
      },
    },
    // A resource is a pointer: it needs a name to be referred to, and everything else is optional —
    // `url` for the ones that have an address, `statement` for what it is good for.
    {
      name: "resource",
      kind: "entity",
      attrs: {
        title: { type: "string", required: true },
        statement: { type: "string" },
        url: { type: "string" },
        sources: { type: "string" },
      },
    },
    // One thing being worked on together, for as long as it lasts (v4.0 shared working context). Named
    // for what the definition always said — "a unit of collaborative work" — because a type name that
    // is a different word from its own definition is a name nobody can guess. It groups nothing in the
    // containment sense: people and records point AT it, so deprecating one leaves them all intact.
    // Orgs define their own equivalents in their ontology (initiative, experiment, …).
    {
      name: "collaboration",
      kind: "entity",
      // `title` only. The seed also declared a free-text `status` attribute: nothing ever read it,
      // no document said what it meant, and it collided with the word every record already carries —
      // a lifecycle status, which is assigned by the gate and moved by verify/deprecate, never typed.
      // A create form built from the ontology rendered the two side by side and invited exactly that
      // confusion. Whether the work is under way is what its records and their freshness say; an org
      // that wants a workflow field declares its own, with a name that does not already mean
      // something here.
      attrs: {
        title: { type: "string", required: true },
      },
      structural: true,
    },
    { name: "authored_by", kind: "relation", attrs: {} },
    // `rationale` on the three edges a model can propose: what makes the link true, in the words of
    // whoever (or whatever) claimed it. Declared rather than merely tolerated, because the create
    // form, the ontology export and every ontology-driven surface offer exactly the declared fields —
    // undeclared, the one thing a reviewer needs in order to judge an edge had nowhere to be typed.
    {
      name: "relates_to",
      kind: "relation",
      attrs: { rationale: { type: "string" } },
      symmetric: true,
    },
    {
      name: "supersedes",
      kind: "relation",
      attrs: { rationale: { type: "string" } },
    },
    {
      name: "conflicts_with",
      kind: "relation",
      attrs: { rationale: { type: "string" } },
      symmetric: true,
    },
    // Links a person to a collaboration they participate in (v4.0). Membership, not knowledge: the
    // roster belongs on the collaboration screen, not in the briefing an agent is handed.
    { name: "works_on", kind: "relation", attrs: {}, membership: true },
    // Two records, one person (v5.6). Directed alias -> canonical for readability only: the resolver
    // follows it both ways, since a direction that changed the answer would mean asking about the alias
    // and asking about the canonical record gave two different accounts of one person.
    //
    // `membership: true` for the same reason `works_on` carries it, and it is the flag's behaviour
    // rather than its name that applies: this edge is not knowledge. Without it, a briefing anchored on
    // a person would hand an agent the person's OTHER record as a finding.
    {
      name: "same_as",
      kind: "relation",
      attrs: {},
      membership: true,
      symmetric: true,
    },
    // What a record rests on (v5.8). Deliberately NOT `membership`, unlike the two above: the evidence
    // under a decision is knowledge, so an anchored briefing SHOULD reach it. persona is unaffected —
    // it passes `scopeRel: 'authored_by'`, so it never traverses this and cannot present a fact the
    // person did not author as their judgment.
    { name: "derived_from", kind: "relation", attrs: {} },
  ];
}
