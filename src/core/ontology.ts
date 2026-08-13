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
 * Whether a required attribute has no value.
 *
 * `""` and `[]` are absent, not present-and-empty: required means a value a reader can use, and an
 * empty string satisfied nothing while passing the check — `--attr statement=""` committed a fact
 * whose knowledge was the empty string, one keystroke away from the rejection it had just been given.
 * `false` and `0` are values and stay values.
 */
function isAbsent(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  return Array.isArray(value) && value.length === 0;
}

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

const ATTR_TYPES: ReadonlyArray<AttrSpec["type"]> = [
  "string",
  "number",
  "boolean",
  "string[]",
];

/**
 * Validate a type DEFINITION before it is stored. Returns a reason, or null when it is well formed.
 *
 * `add-type` is the one write that does not pass the commit gate — it changes the rules the gate applies
 * — and it validated `name` and `kind` and nothing else. Everything below was accepted:
 *
 *   {"name":"junk"}                          → saved. `ontology list` then throws
 *                                              "Cannot convert undefined or null to object" for EVERY
 *                                              type in the database, and `yoke add junk` throws the
 *                                              same. There is no `remove-type`, so the database cannot
 *                                              be repaired from the CLI at all.
 *   {"kind":"wormhole"}                      → saved. Neither entity nor relation; `add` accepts it.
 *   {"attrs":"nope"}                         → saved. `Object.entries("nope")` yields the string's
 *                                              indices, so the type renders four attributes named
 *                                              0, 1, 2, 3.
 *   {"ttl_days":"soon"} / {"ttl_days":-30}    → saved. `last_confirmed + "soon" * DAY_MS` is NaN, so
 *                                              `isFresh` is permanently false: a human-verified record
 *                                              is withheld from injection FOREVER and every surface
 *                                              says only "past its freshness window".
 *   {"attrs":{"x":{"type":"datetime"}}}       → saved. No value can ever satisfy it.
 *   {"name":"fact","kind":"relation"}         → saved, flipping a populated entity type into a relation.
 *
 * The `ttl_days` cases are the ones that cost knowledge rather than crashing: they are silent, permanent,
 * and indistinguishable from a TTL that has genuinely elapsed.
 *
 * A kind flip on a type that already has rows is refused by the callers, which are the ones that can
 * count them — this function judges the definition alone.
 */
export function validateTypeDef(def: unknown): string | null {
  if (typeof def !== "object" || def === null || Array.isArray(def))
    return "a type definition must be a JSON object";
  const d = def as Record<string, unknown>;
  if (typeof d.name !== "string" || d.name.trim() === "")
    return "name must be a non-empty string";
  if (d.kind !== "entity" && d.kind !== "relation")
    return `kind must be "entity" or "relation" (got ${JSON.stringify(d.kind)})`;
  if (typeof d.attrs !== "object" || d.attrs === null || Array.isArray(d.attrs))
    return "attrs must be an object of attribute name → { type, required? }";
  for (const [key, spec] of Object.entries(
    d.attrs as Record<string, unknown>,
  )) {
    if (key.trim() === "") return "an attribute name cannot be empty";
    if (typeof spec !== "object" || spec === null || Array.isArray(spec))
      return `attribute ${key} must be { type, required? }`;
    const s = spec as Record<string, unknown>;
    if (!ATTR_TYPES.includes(s.type as AttrSpec["type"]))
      return `attribute ${key}: type must be one of ${ATTR_TYPES.join(", ")} (got ${JSON.stringify(s.type)})`;
    if (s.required !== undefined && typeof s.required !== "boolean")
      return `attribute ${key}: required must be true or false`;
  }
  if (d.ttl_days !== undefined) {
    if (
      typeof d.ttl_days !== "number" ||
      !Number.isFinite(d.ttl_days) ||
      d.ttl_days < 0 ||
      !Number.isInteger(d.ttl_days)
    )
      return `ttl_days must be a whole number of days, 0 or more (got ${JSON.stringify(d.ttl_days)}) — omit it for no expiry`;
  }
  for (const flag of ["membership", "structural", "symmetric"] as const)
    if (d[flag] !== undefined && typeof d[flag] !== "boolean")
      return `${flag} must be true or false`;
  // Relation-only and entity-only flags, so a definition cannot claim behaviour its kind never reads.
  if (d.kind === "entity" && (d.membership || d.symmetric))
    return "membership and symmetric describe relation types, not entity types";
  if (d.kind === "relation" && d.structural)
    return "structural describes entity types, not relation types";
  return null;
}

/**
 * May `name`'s kind be changed from `prior` to `next`? Returns a reason, or null.
 *
 * A kind flip rewrites what the gate demands of a type that already has meaning. `{"name":"fact",
 * "kind":"relation"}` was accepted: stored facts kept being injected as entities while `yoke add fact`
 * started being refused as a relation needing `from` and `to`, and there is no `remove-type` to undo it.
 *
 * `rows` is passed in because counting them belongs to the store, not here.
 *
 * Seeded types are refused whatever their row count: they are part of the v1 contract every surface and
 * every test is written against, and an empty `fact` table today is not permission to redefine `fact`.
 * A type the caller declared themselves and has not used yet is theirs to correct — which matters
 * because without `remove-type` a refusal there would trap them with an unusable declaration.
 */
export function kindChangeRefusal(
  name: string,
  prior: "entity" | "relation",
  next: "entity" | "relation",
  rows: number,
): string | null {
  if (prior === next) return null;
  if (seedOntology().some((t) => t.name === name))
    return `${name} is one of the seeded types and every surface is written against it being a ${prior} — declare a new type instead of redefining this one`;
  if (rows > 0)
    return `${name} is already declared as ${prior} and has records — changing its kind would leave them unreadable`;
  return null;
}

export function validateInput(
  ontology: TypeDef[],
  input: EntityInput | RelationInput,
): { ok: true } | { ok: false; reason: string } {
  const def = ontology.find((t) => t.name === input.type);
  if (!def) return { ok: false, reason: `unknown type: ${input.type}` };

  // A kind mismatch is reported as itself. Without this the checks below answered a question nobody
  // asked: recording an entity type as a relation ("<person> decision <id>") reached the attribute
  // loop and came back "missing required attribute: conclusion", so the fix it named — supply a
  // conclusion — could not work, and the caller retried a wrong command with more arguments. An
  // entity type used as a relation is not an under-specified relation, it is the wrong type.
  const isRelation = "from" in input;
  if (def.kind === "relation" && !isRelation)
    return {
      ok: false,
      reason: `${input.type} is a relation type: it needs a from and a to`,
    };
  if (def.kind === "entity" && isRelation)
    return {
      ok: false,
      reason: `${input.type} is an entity type: it cannot be recorded as a relation`,
    };
  if (isRelation) {
    const r = input as RelationInput;
    if (!r.from)
      return { ok: false, reason: "relation requires non-empty from" };
    if (!r.to) return { ok: false, reason: "relation requires non-empty to" };
  }

  // Every failure in one pass, in declared order. One-at-a-time reporting made the required set
  // discoverable only by committing repeatedly: a `decision` took three rejections to file, and each
  // one named a single attribute, so the caller learned the shape of the type from its refusals.
  // Missing is reported before wrong-type because an absent attribute is the commoner mistake and
  // reporting both at once would bury it.
  const missing: string[] = [];
  const wrongType: string[] = [];
  for (const [key, spec] of Object.entries(def.attrs)) {
    const value = input.attributes[key];
    if (isAbsent(value)) {
      if (spec.required) missing.push(key);
      continue;
    }
    if (!matchesType(spec.type, value))
      wrongType.push(`${key} must be ${spec.type}`);
  }
  if (missing.length > 0)
    return {
      ok: false,
      reason: `missing required attribute${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`,
    };
  if (wrongType.length > 0)
    return { ok: false, reason: `attribute ${wrongType.join("; ")}` };
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
    {
      name: "fact",
      kind: "entity",
      attrs: {
        title: { type: "string" },
        statement: { type: "string", required: true },
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
    { name: "relates_to", kind: "relation", attrs: {}, symmetric: true },
    { name: "supersedes", kind: "relation", attrs: {} },
    { name: "conflicts_with", kind: "relation", attrs: {}, symmetric: true },
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
