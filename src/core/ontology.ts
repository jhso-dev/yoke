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
 * and web one-liner (`summarize`), the text the relater compares records by, and the sentence
 * `serializeText` indexes. `sources` is in it for a sharper reason than the rest — it holds the
 * verbatim span a record rests on, often longer than the record itself, so a surface that falls back
 * to it renders a quote dump instead of a reading, and a batch of them crowds out the records a model
 * is being asked to compare.
 *
 * Kept OUT of the sentence is not the same as kept out of the index: `serializeText` re-appends
 * `sources` and the identifiers verbatim after it, for reasons written there. This set answers "is
 * this what the record says", and each caller decides what to do with the answer.
 */
export const BOOKKEEPING_ATTRS = new Set([
  "external_id",
  "sources",
  "author",
  "topic",
  "key",
  "status",
]);

/**
 * Whether a required attribute has no value.
 *
 * `""` and `[]` are absent, not present-and-empty: required means a value a reader can use, and an
 * empty string or empty array is none. `false` and `0` are values and stay values.
 */
function isAbsent(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  // Trimmed, not just empty: a value of only whitespace ("   ") renders as a blank cell in the review
  // queue, blank link text, an `aria-label` of "Select " and nothing, and an unlabelled node in the
  // graph. Whitespace is not a value a reader can use, which is what `required` means.
  if (typeof value === "string" && value.trim() === "") return true;
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
 * — so a malformed definition is caught nowhere downstream and must be rejected here: a missing `attrs`,
 * a `kind` that is neither entity nor relation, an `attrs` that is not an object, an attribute type no
 * value can satisfy, a name flip onto a populated type. The `ttl_days` cases cost knowledge rather than
 * crashing — a non-numeric or negative TTL makes `isFresh` permanently false, withholding a
 * human-verified record from injection forever, silent and indistinguishable from a TTL that genuinely
 * elapsed.
 *
 * A kind flip on a type that already has rows is refused by the callers, which are the ones that can
 * count them — this function judges the definition alone.
 */
/**
 * Every key a type definition may carry. A definition is REJECTED for anything else.
 *
 * Enumerating only known keys makes a validator a spell-checker for its own vocabulary — `ttl_dayz: 30`
 * would be accepted and silently mean no expiry. Unknown keys are refused rather than ignored because an
 * ignored key is indistinguishable from an applied one at every surface afterwards.
 */
const TYPE_DEF_KEYS = [
  "name",
  "kind",
  "attrs",
  "ttl_days",
  "membership",
  "structural",
  "symmetric",
] as const;

export function validateTypeDef(def: unknown): string | null {
  if (typeof def !== "object" || def === null || Array.isArray(def))
    return "a type definition must be a JSON object";
  const d = def as Record<string, unknown>;
  const unknown = Object.keys(d).filter(
    (k) => !(TYPE_DEF_KEYS as readonly string[]).includes(k),
  );
  if (unknown.length > 0)
    return `unknown field(s): ${unknown.join(", ")} — a type definition takes ${TYPE_DEF_KEYS.join(", ")}`;
  if (typeof d.name !== "string" || d.name.trim() === "")
    return "name must be a non-empty string";
  // Refused, not silently trimmed or slugified: the name is an identity every stored row carries, and
  // saving something other than what was written is its own surprise the next time someone greps.
  //
  // Whitespace makes an invisible twin — `" fact"` listed directly under `fact`, indistinguishable to
  // a reader, and `list --type fact` never finds its records. A colon collides with the RBAC scope
  // grammar (`ns:type:action`, rbac.ts): `team:note` makes `teamA:team:note:read` four segments, which
  // `parseScope` refuses, so that type can never be granted to anyone. It fails closed, and silently —
  // the deployment where it matters is the one where nobody is reading this file.
  if (d.name !== d.name.trim())
    return `name cannot start or end with whitespace (got ${JSON.stringify(d.name)})`;
  if (/[\s:]/.test(d.name))
    return `name cannot contain spaces or ":" (got ${JSON.stringify(d.name)}) — ":" separates the segments of an access scope, and a type carrying one can never be granted`;
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
 * A kind flip rewrites what the gate demands of a type that already has meaning: flipping `fact` to a
 * relation would leave stored facts injected as entities while `yoke add fact` is refused as a relation
 * needing `from` and `to`, with no `remove-type` to undo it.
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

/**
 * Relation type names core itself reads. Renaming one is a code change disguised as a data change.
 *
 * Every entry is a name that appears in a `neighbors(...)` call in core: `authored_by` (persona's anchor,
 * the overview's author ranking, backfill), `same_as` (identitySet), `derived_from` (downstreamOf),
 * `conflicts_with` (the gate's stage 4 and injection's contradiction marker), `supersedes` (injection's
 * supersession filter), `relates_to` (the gate's `attachTo`).
 *
 * `membership` and `structural` are NOT here, deliberately: those are ontology FLAGS, so an org renames
 * `works_on` to `assigned_to`, marks it, and core never needed the name.
 */
const CORE_ANCHORED = [
  "authored_by",
  "same_as",
  "derived_from",
  "conflicts_with",
  "supersedes",
  "relates_to",
] as const;

/**
 * May `from` be renamed to `to`? Returns a reason, or null.
 *
 * Rewriting a type name rewrites rows in place — deliberately, and SPEC records that history cannot
 * capture it — so every refusal here is about damage nothing can undo. Four adapters implement
 * `renameType`, which is why the rules live in core and the front tier supplies the counts.
 */
export function renameRefusal(
  from: string,
  to: string,
  opts: {
    /** Rows already carrying `to` in this namespace (0 or 1 is enough — the caller may cap the read). */
    toRows: number;
    /** Whether `to` is declared in the effective ontology for this namespace. */
    toDeclared: boolean;
    /** The namespace being renamed in. null = the default shared one. */
    ns: string | null;
    /** Whether `from`'s only declaration is the shared one, so a tenant rename would not rewrite it. */
    fromSharedOnly: boolean;
  },
): string | null {
  if (from === to) return `${from} and ${to} are the same name`;
  if ((CORE_ANCHORED as readonly string[]).includes(from))
    return `${from} is a relation core reads by name (persona, identity, derivation, conflicts, supersession) — renaming it would silently empty those answers`;
  // The same list guards the DESTINATION, not only the source. Renaming a type AWAY from a name core
  // reads empties an answer, which is bad and visible; renaming a type ONTO one fills an answer with
  // edges that never meant it, which is worse and invisible — `rename-type notes supersedes` turns every
  // `notes` edge into a supersession, and the next `yoke inject` withholds a verified record for a
  // replacement nobody recorded, with no trace but an audit line.
  if ((CORE_ANCHORED as readonly string[]).includes(to))
    return `${to} is a relation core acts on by name (persona, identity, derivation, conflicts, supersession) — renaming onto it would make every ${from} edge mean something it was never filed to mean`;
  if (opts.toDeclared && opts.toRows > 0)
    return `${to} already exists and has records: this would merge two types and drop the ${from} declaration, and nothing records which rows were rewritten so it could not be undone`;
  if (opts.ns !== null && opts.fromSharedOnly && !opts.toDeclared)
    return `${from} is declared in the shared ontology, not in ${opts.ns}, so renaming it here would leave this tenant's rows on a type declared nowhere — and an undeclared type has no TTL, so stale records would start being injected as current. Declare ${to} in ${opts.ns} first.`;
  return null;
}

export function validateInput(
  ontology: TypeDef[],
  input: EntityInput | RelationInput,
): { ok: true } | { ok: false; reason: string } {
  const def = ontology.find((t) => t.name === input.type);
  // The valid names travel with the refusal. `yoke ontology list` answers this for a person, but an agent
  // over MCP has no equivalent — the commit tool's own description says "rejected if the type is not in
  // the ontology" and named no way to read it, so a typo'd type left the agent guessing. The ontology is
  // the argument to this function; withholding it was a choice, not a limitation. Split by kind because a
  // relation is not a substitute for an entity.
  if (!def) {
    const names = (kind: TypeDef["kind"]) =>
      ontology
        .filter((t) => t.kind === kind)
        .map((t) => t.name)
        .join(", ") || "(none)";
    return {
      ok: false,
      reason:
        `unknown type: ${input.type}\n` +
        `entity types: ${names("entity")}\n` +
        `relation types: ${names("relation")}`,
    };
  }

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

  // Every failure in one pass, in declared order — reporting one at a time makes the required set
  // discoverable only by committing repeatedly, one attribute per refusal. Missing is reported before
  // wrong-type because an absent attribute is the commoner mistake and reporting both at once would
  // bury it.
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
    // labels, personas, the stale-owner roster — and the ontology-driven create form offers exactly the
    // declared fields, so an undeclared `name` gives the one type whose records anchor personas a form
    // with no fields.
    {
      name: "person",
      kind: "entity",
      attrs: { name: { type: "string", required: true } },
      structural: true,
    },
    // Declared, and in this order, because the ontology is what tells `summarize` which attribute
    // carries the meaning; an undeclared type is guessed at and offers zero fields in the create form.
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
      // `title` only. A free-text `status` attribute is deliberately absent: it would collide with the
      // lifecycle status every record already carries — assigned by the gate, moved by verify/deprecate,
      // never typed — and a create form built from the ontology would render the two side by side.
      // Whether the work is under way is what its records and their freshness say; an org that wants a
      // workflow field declares its own, with a name that does not already mean something here.
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
