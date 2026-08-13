// persona — the person-anchored reading of an injection, rendered as a SKILL.md (PLAN 6.1–6.2).
// A persona is not stored but derived (VISION): regenerated each time from the current verified knowledge.
// Citation, not impersonation — the output must be citation-based to be auditable.
//
// Collection is deliberately NOT here: it is inject() anchored on the person entity, the same
// one-hop walk a collaboration anchor uses (authorship is a graph edge — the commit gate mirrors
// provenance into authored_by). One mechanism, two named entry points. What persona adds is how
// that anchor is read: strictly. A collaboration anchor prioritizes and lets org-wide knowledge in;
// a persona anchors on authored_by/'in' with no query and filters locally, because presenting
// knowledge a person did not author as their judgment would be impersonation.
// Time is injected (never call new Date() in core).

import { readEntities, type StoragePort } from "../ports/storage.js";
import { identitySet } from "./identity.js";
import { inject, pointer } from "./inject.js";
import { effectiveStatus } from "./lifecycle.js";
import { normalizeNs } from "./namespace.js";
import type { TypeDef } from "./ontology.js";
import type { Entity } from "./types.js";

export interface PersonaResult {
  decisions: Entity[];
  facts: Entity[];
}

/** Thrown when the anchor is not someone a persona can be about. */
export class NotAPerson extends Error {}

/**
 * The entity type a persona can be anchored on.
 *
 * Hardcoded, like `decision` in the conflict heuristic and `authored_by` in the authorship mirror: a
 * persona is inherently about a person, so the type is part of the mechanism rather than a
 * configuration of it.
 *
 * ceiling: a tenant whose people are some other type (`employee`, `colleague`) cannot anchor a
 * persona. Lifting that means a `TypeDef` marker, the same extension point `membership` and
 * `structural` are — not a second string compared here.
 */
const PERSON_TYPE = "person";

/**
 * The persona entry point: an injection anchored on a person, read strictly.
 * authored_by means "entity authored by person" → from:entity → to:person, so the person's dir:'in'
 * neighbors are exactly the knowledge they authored — never what merely touches them (the collaboration
 * they work on, the colleague who filed their person record).
 * @param query filters the person's OWN records (substring over attributes). It deliberately does
 *   not go through inject's query path: that unions in org-wide matches, which is right for a
 *   collaboration and wrong for a persona.
 */
export async function personaQuery(
  port: StoragePort,
  ontology: TypeDef[],
  personId: string,
  now: string,
  opts?: { query?: string; ns?: string | null },
): Promise<PersonaResult> {
  // The anchor has to be a person. `persona <fact-id>` used to succeed: zero sources, a SKILL.md
  // headed "Persona grounded in 01KZWW1T…'s recorded judgments", and `--check` on it reporting "0
  // sources, all current" — a green light on a document about nobody. An anchor that is knowledge
  // rather than someone cannot have authored anything, so an empty result is guaranteed and reporting
  // it as a persona is the lie.
  //
  // Enforced here rather than per surface: the CLI checked the id EXISTS (a fact id passes that) and
  // MCP and the web checked nothing.
  const anchor = await port.getEntity(personId);
  if (!anchor) throw new NotAPerson(`not found: ${personId}`);
  if (anchor.type !== PERSON_TYPE)
    throw new NotAPerson(
      `a persona is anchored on a ${PERSON_TYPE}, and ${personId} is a ${anchor.type}`,
    );
  // One person can hold several records (`same_as`, v5.6), and a persona built from one of them is
  // half of that person's judgment presented as all of it. Anchor on each and union.
  //
  // ceiling: one anchored injection per record, sequentially. The set is a person's duplicates — two
  // or three — not a corpus walk, so batching this before anything has felt it would be inventing a
  // problem. `identitySet` is a no-op walk (one `neighbors` call) on the ordinary single-record case.
  const ids = await identitySet(port, personId, opts?.ns);
  const items = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const one = await inject(port, ontology, "", now, {
      scope: id,
      scopeRel: "authored_by",
      scopeDir: "in",
      ns: opts?.ns,
    });
    // Deduplicated by entity id: a record authored by two of the same person's records is one record.
    // Order is per-anchor, anchors in `identitySet` order — deterministic, which is what a generated
    // SKILL.md needs, rather than meaningful across the union.
    for (const i of one.items)
      if (!seen.has(i.entity.id)) {
        seen.add(i.entity.id);
        items.push(i);
      }
  }
  const q = opts?.query?.toLowerCase();
  return classifyPersona(
    items
      .map((i) => i.entity)
      .filter(
        (e) =>
          q === undefined ||
          JSON.stringify(e.attributes).toLowerCase().includes(q),
      ),
  );
}

/** Splits injected knowledge into the persona shape. type==='decision' → decisions, rest → facts.
 * The verified/stale/draft filtering already happened in inject — no second filter lives here. */
function classifyPersona(entities: Entity[]): PersonaResult {
  const decisions: Entity[] = [];
  const facts: Entity[] = [];
  for (const e of entities) (e.type === "decision" ? decisions : facts).push(e);
  return { decisions, facts };
}

/** Makes personId safe for use as a file/skill name (anything but alphanumerics, -, _ → -). */
export function safeName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "-");
}

/** The first string value in attributes (for a knowledge summary). Empty string if none. */
function firstString(attrs: Record<string, unknown>): string {
  for (const v of Object.values(attrs)) {
    if (typeof v === "string") return v;
  }
  return "";
}

/**
 * Renders a personaQuery result into a single SKILL.md (a derivative — regeneration is the rule).
 * The header records the generation time and source-knowledge versions as the audit basis.
 */
export function renderPersonaSkill(
  person: Entity,
  result: PersonaResult,
  now: string,
): string {
  const { decisions, facts } = result;
  const name =
    typeof person.attributes.name === "string"
      ? person.attributes.name
      : person.id;
  const sources = [...decisions, ...facts];

  const out: string[] = [];
  out.push("---");
  out.push(`name: persona-${safeName(person.id)}`);
  out.push(
    `description: Persona grounded in ${name}'s recorded judgments and knowledge`,
  );
  out.push("---");
  out.push("");
  out.push(`# ${name} persona`);
  out.push("");
  out.push(`Generated: ${now}`);
  out.push(
    `Source knowledge (${sources.length}): ${
      sources.map((e) => `${e.id}@v${e.version}`).join(", ") || "(none)"
    }`,
  );
  out.push("");

  out.push("## Guiding principles");
  out.push("");
  if (decisions.length === 0) out.push("(no recorded decisions)");
  else
    for (const d of decisions) out.push(`- ${String(d.attributes.rationale)}`);
  out.push("");

  out.push("## Decision record");
  out.push("");
  if (decisions.length === 0) out.push("(none)");
  else
    for (const d of decisions) {
      out.push(`### ${String(d.attributes.conclusion)}`);
      out.push(`- Rationale: ${String(d.attributes.rationale)}`);
      // What was NOT chosen is the half of a judgment that transfers. "Use SQLite" is a fact about a
      // codebase; "Postgres was on the table and lost" is how this person decides — and the ontology
      // has carried it since v1 (`decision` declares rejected_alternatives, VISION calls it the raw
      // material for a persona) while the export dropped it on the floor.
      const rejected = d.attributes.rejected_alternatives;
      if (Array.isArray(rejected) && rejected.length > 0)
        out.push(`- Rejected: ${rejected.map(String).join(", ")}`);
      // `pointer`, not `citation`: a citation carries `provenance.actor`, and on a promoted record that
      // is whoever VERIFIED it. Every Source line in a document titled "Ada persona" read
      // "yoke:system" — the one name the document must not put there. Authorship is the anchor of this
      // walk (authored_by, dir 'in'), so the author is known without a lookup.
      out.push(
        `- Source: ${pointer(d)} recorded by ${name}, last confirmed ${d.last_confirmed}`,
      );
      out.push("");
    }

  out.push("## Knowledge");
  out.push("");
  if (facts.length === 0) out.push("(none)");
  else
    for (const f of facts)
      out.push(
        `- ${firstString(f.attributes)} — ${pointer(f)} recorded by ${name}, last confirmed ${f.last_confirmed}`,
      );
  out.push("");

  out.push("## Instructions");
  out.push("");
  out.push(
    'Do not answer without a citation. If it is not in the records above, answer "no record".',
  );
  out.push(`Do not speak as if you were ${name}; cite the records.`);
  out.push("");

  return out.join("\n");
}

// ── Auditing an exported snapshot (v5.8) ───────────────────────────────────────────────────────────
//
// The export above has recorded its source versions since v1, and SPEC said that was "so a stale
// snapshot can be identified" — while nothing could read them back, so identifying one meant a person
// diffing two files by eye. A file that names its sources is only worth the bytes if something other
// than a person can check them.

/** One `id@vN` entry from an exported SKILL.md header. */
export interface PersonaSource {
  id: string;
  version: number;
}

export interface PersonaHeader {
  sources: PersonaSource[];
  /** Header tokens that were not `id@vN` — a hand-edited file, reported rather than dropped. */
  unparsed: string[];
  /** False when there is no `Source knowledge` line at all: not an exported persona. */
  recognized: boolean;
}

const SOURCE_LINE = "Source knowledge (";

/**
 * The inverse of `renderPersonaSkill`'s header, and it lives beside it on purpose — a format the writer
 * and the reader disagree about is the failure mode of every snapshot, so a render → parse round trip
 * asserts them together.
 *
 * `lastIndexOf("@v")` rather than a split, because an id may carry a namespace prefix.
 */
export function parsePersonaSources(md: string): PersonaHeader {
  const line = md.split("\n").find((l) => l.startsWith(SOURCE_LINE));
  if (line === undefined)
    return { sources: [], unparsed: [], recognized: false };
  const list = line.slice(line.indexOf("): ") + 3).trim();
  const header: PersonaHeader = {
    sources: [],
    unparsed: [],
    recognized: true,
  };
  if (list === "(none)" || list === "") return header;
  for (const token of list.split(",").map((t) => t.trim())) {
    const at = token.lastIndexOf("@v");
    const version = Number(token.slice(at + 2));
    if (at > 0 && Number.isInteger(version) && version > 0)
      header.sources.push({ id: token.slice(0, at), version });
    else header.unparsed.push(token);
  }
  return header;
}

/**
 * Why a snapshot's source is no longer what it was. One verdict per source, most actionable first —
 * `deprecated` > `superseded` > `stale`/`draft` > `outdated` > `ok` — because the remedy for every
 * non-`ok` verdict is the same (re-export), so a second reason changes nothing a reader would do.
 *
 * `draft` is unreachable from an export today (`inject` returns only verified records), and is here
 * because reporting the status found beats mapping an unexpected one onto a neighbouring label.
 */
export type SourceVerdict =
  | "ok"
  | "outdated"
  | "stale"
  | "draft"
  | "deprecated"
  | "superseded"
  | "missing";

export interface SourceCheck extends PersonaSource {
  verdict: SourceVerdict;
  /** The version in the store now. Absent when `missing`. */
  current?: number;
  /** Enough of the record to label it — no caller should have to show a person only an id. Carried
   * rather than rendered here: `summarize` reads the ontology to pick the attribute that means
   * something (a decision's `conclusion` over whatever happened to be written first) and lives in the
   * front tier, which core does not import. Absent when `missing`. */
  type?: string;
  attributes?: Record<string, unknown>;
}

/**
 * Each recorded source against the store as it is now.
 *
 * One batch read for every source (v5.5), then one `neighbors` call per surviving source for the
 * supersession check. Namespace-filtered on both, for `identitySet`'s reason: `neighbors` takes no `ns`,
 * and a source that exists only in another tenant is `missing` here, which is the true answer.
 */
export async function checkPersonaSources(
  port: StoragePort,
  ontology: TypeDef[],
  sources: PersonaSource[],
  now: string,
  opts?: { ns?: string | null },
): Promise<SourceCheck[]> {
  const wantNs = normalizeNs(opts?.ns);
  const found = new Map(
    (
      await readEntities(
        port,
        sources.map((s) => s.id),
      )
    )
      .filter((e) => normalizeNs(e.ns) === wantNs)
      .map((e) => [e.id, e] as const),
  );
  const out: SourceCheck[] = [];
  for (const s of sources) {
    const e = found.get(s.id);
    if (e === undefined) {
      out.push({ ...s, verdict: "missing" });
      continue;
    }
    const base = {
      ...s,
      current: e.version,
      type: e.type,
      attributes: e.attributes,
    };
    const status = effectiveStatus(e, ontology, now);
    if (status === "deprecated") {
      out.push({ ...base, verdict: "deprecated" });
      continue;
    }
    const superseded = (await port.neighbors(s.id, "supersedes", "in")).some(
      (r) => normalizeNs(r.ns) === wantNs && r.from !== s.id,
    );
    out.push({
      ...base,
      verdict: superseded
        ? "superseded"
        : status !== "verified"
          ? status
          : e.version !== s.version
            ? "outdated"
            : "ok",
    });
  }
  return out;
}
