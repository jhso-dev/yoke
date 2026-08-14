#!/usr/bin/env node

// yoke MCP server (PLAN 3.1–3.3) — stdio transport. Started with `yoke mcp [--db path]`.
// Six tools: yoke_inject / yoke_commit / yoke_record_decision / yoke_overview / yoke_persona / yoke_use_scope.
// Governance: agents may only ingest drafts (no verify/deprecate tools — promotion is the CLI's job).
// Time is obtained only in this front tier (core receives `now` by injection).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { AuditEvent } from "../../adapters/storage-sqlite/index.js";
import { overview } from "../../core/aggregate.js";
import { CommitRejected, commit } from "../../core/commit.js";
import { type Embedder, makeFetchEmbedder } from "../../core/embedding.js";
import {
  BRIEFING_LIMIT,
  entityIdCandidates,
  inject,
  WALK_BUDGET,
} from "../../core/inject.js";
import { normalizeNs, resolveNs } from "../../core/namespace.js";
import type { TypeDef } from "../../core/ontology.js";
import {
  NotAPerson,
  PERSON_TYPE,
  type PersonaResult,
  personaQuery,
} from "../../core/persona.js";
import type { Entity, EntityInput, RelationInput } from "../../core/types.js";
import type { StoragePort } from "../../ports/storage.js";
import { describeWithheld, injectDetail } from "../display.js";
import { openStore } from "../store.js";

const ORIGIN = "mcp";

export interface YokeMcpDeps {
  /** logAudit (PLAN 8.4) is optional: adapters without it simply skip injection auditing.
   * Everything else the tools need is the plain port — persona included, since authorship is a
   * graph edge rather than a provenance lookup outside the contract. */
  store: StoragePort & { logAudit?(event: AuditEvent): void };
  ontology: TypeDef[];
  /** Default actor when a tool call omits one (resolved from env at server startup). */
  defaultActor: string;
  /** Tenant namespace scope (PLAN-V2 10.1), read from YOKE_NS at startup. null = default shared ns. */
  ns?: string | null;
  /** Current time as ISO 8601. Defaults to new Date().toISOString() — tests inject a fixed value. */
  now?: () => string;
  /** Embedder for the duplicate/conflict gate. Tests inject a deterministic stub; unset = detection skipped. */
  embedder?: Embedder;
  /** Per-request RBAC hook (PLAN-V2 10.4). Default allow-all — stdio `yoke mcp` is single-user
   * (ungated); serve mode binds this to the Bearer token's scopes. Denied calls return a tool error. */
  authorize?: (action: "read" | "write" | "verify", type?: string) => boolean;
  /** Default injection/capture scope (a collaboration/entity id) resolved at startup from YOKE_SCOPE
   * (v4.0). The agent can also pin one at runtime via yoke_use_scope; a tool-call `scope` argument
   * always overrides both. null = no default. */
  defaultScope?: string | null;
}

/** Resolve a work-item key (or entity id) to an anchor entity. Exact entity id wins (getEntity);
 * otherwise search for an entity whose `key` OR `title` attribute equals the key, preferring a
 * `collaboration` since that is what a work-item key names. Any entity type may anchor an injection —
 * a collaboration is the shared working context, a person is a persona — so the fallback is not
 * restricted to one type. Front-tier only. Returns null when nothing matches. Shared by startup
 * (YOKE_SCOPE) and the yoke_use_scope tool.
 */
export async function resolveScope(
  store: Pick<StoragePort, "getEntity" | "search">,
  ns: string | null,
  key: string,
): Promise<{ id: string; title: string } | null> {
  const asEntity = (e: Entity) => ({
    id: e.id,
    title: String(e.attributes.title ?? e.id),
  });
  const byId = await store.getEntity(key);
  // The id path took `ns` and never used it, so this was the one MCP read that crossed a tenant
  // boundary. Measured: a `teamA:read` token resolved a teamB resource and got its title back —
  // "Acquisition of Northwind Corp - confidential term sheet". It was also an existence oracle, since a
  // nonexistent id answered "no collaboration matches" while any real id in any namespace resolved.
  // Every other MCP read (`yoke_inject`, `yoke_persona`) already held the line; the `search` fallback
  // below always did, because `search` takes the ns.
  if (byId && normalizeNs(byId.ns) === normalizeNs(ns)) return asEntity(byId);
  const hits = await store.search({ text: key, ns });
  const named = hits.filter(
    (e) => e.attributes.key === key || e.attributes.title === key,
  );
  const found = named.find((e) => e.type === "collaboration") ?? named[0];
  return found ? asEntity(found) : null;
}

// Identical on both write tools. The wording IS the mechanism: a derivation is caller-asserted (SPEC
// "Derivation"), so what the agent is told decides whether the edge means anything. Naming the two tools
// that hand out ids keeps it to records that were actually retrieved, and "omit rather than guess" is
// there because a padded list files a false basis under a decision where no reader can catch it.
const DERIVED_FROM_DESC =
  "Ids of the knowledge this record rests on. Cite only ids that yoke_inject or yoke_persona actually " +
  "returned to you and that you actually used. Omit rather than guess — these edges are how deprecating " +
  "a record finds what has to change, so a wrong basis is worse than none.";

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const err = (text: string) => ({ ...ok(text), isError: true });

/** Assembles an MCP server instance. Tests connect to it over InMemoryTransport. */
export function createYokeMcpServer(deps: YokeMcpDeps): McpServer {
  const { store, ontology, defaultActor, embedder } = deps;
  const ns = deps.ns ?? null;
  const defaultScope = deps.defaultScope ?? null;
  // Runtime scope pinned by yoke_use_scope. Mutable state in the closure is fine for stdio's
  // long-lived process; serve mode uses a fresh server per request so it simply never persists.
  let sessionScope: string | null = null;
  // Precedence: explicit per-call scope > session pin (yoke_use_scope) > startup YOKE_SCOPE.
  // An explicit empty string opts OUT for that call — without it, a pinned session
  // could never record or query knowledge outside its collaboration.
  const effectiveScope = (scope?: string) =>
    scope === ""
      ? undefined
      : (scope ?? sessionScope ?? defaultScope ?? undefined);
  const now = deps.now ?? (() => new Date().toISOString());
  const authorize = deps.authorize ?? (() => true);
  const forbidden = () =>
    err("forbidden: token scope does not allow this action");
  const server = new McpServer({ name: "yoke", version: "0.1.0" });

  // Input actor > server startup env (defaultActor) > 'yoke:system' (already folded into defaultActor).
  const resolveActor = (actor?: string) => actor ?? defaultActor;

  async function doCommit(
    input: EntityInput | RelationInput,
    actor?: string,
    scope?: string,
    derivedFrom?: string[],
  ) {
    if (!authorize("write", input.type)) return forbidden();
    const ts = now();
    const prov = {
      actor: resolveActor(actor),
      origin: ORIGIN,
      occurred_at: ts,
    };
    try {
      // Capture-side linking (v4.0): attach the new knowledge to the scope entity via relates_to.
      // Passed INTO the gate rather than filed afterwards: as a second commit its endpoint check
      // threw after the entity was durable, so an agent heard "rejected" about a record that exists
      // and retried (see `attachTo` in core/commit.ts).
      const linkTo = effectiveScope(scope);
      const { entity, duplicates, duplicateDetection, unrecorded } =
        await commit(store, ontology, input, prov, ts, {
          embedder,
          ns,
          ...(linkTo ? { attachTo: linkTo } : {}),
        });
      const edges: Array<[string, string]> = [];
      // Derivation (v5.8) travels this same road for the same reason: the caller declares its basis, so
      // the edge belongs where the caller is. Deduped and self-edge-free — citing one record twice, or
      // citing the record being written, files one edge and none respectively.
      //
      // Skipped when the ontology in force does not declare the type, on stage 4b's rule: this DB may
      // predate the seed (`derived_from` is v5.8 and the seed applies to new DBs only), and a derived
      // edge must never fail the caller's own commit — the knowledge is already stored by this point.
      const ignored: string[] = [];
      if (ontology.some((t) => t.name === "derived_from"))
        for (const raw of new Set(derivedFrom ?? [])) {
          // The one place a relation endpoint is checked, and only because of what the caller can see:
          // every surface renders a record as `[fact:01K…@v2]`, so an agent citing "what inject
          // returned" cites that. Measured: 3 of 3 agents populated the field unprompted and 2 of 3
          // passed a citation rather than an id. Unresolvable is reported, never filed — an edge
          // pointing at nothing makes `downstreamOf` answer "nothing rests on this", which is the
          // silent wrong answer the whole feature exists to prevent.
          let src: string | undefined;
          for (const cand of entityIdCandidates(raw)) {
            if (cand === entity.id) break; // self-citation: not an error, just nothing to file
            if (await store.getEntity(cand)) {
              src = cand;
              break;
            }
          }
          if (src) edges.push(["derived_from", src]);
          else if (!entityIdCandidates(raw).includes(entity.id))
            ignored.push(raw);
        }
      for (const [type, to] of edges)
        await commit(
          store,
          ontology,
          { type, attributes: {}, from: entity.id, to },
          prov,
          ts,
          { ns },
        );
      return ok(
        JSON.stringify({
          id: entity.id,
          version: entity.version,
          status: entity.status,
          // Similar-knowledge candidates — no auto-merge. Included in the result for the agent to judge.
          duplicates: duplicates.map((d) => ({ id: d.id, type: d.type })),
          // WHY the list is empty. `[]` reads as "checked, nothing similar", and with no embedder
          // configured nothing was checked at all — the CLI has said so since the gate started reporting
          // it ("no duplicate check ran: set YOKE_EMBED_URL …") and MCP dropped the field. It matters
          // twice over: conflict detection consumes the same candidates, so on a keyless install an agent
          // recording a contradiction is told nothing about either.
          duplicate_check:
            duplicateDetection === "skipped"
              ? "not run — this deployment has no embedding provider configured, so nothing was compared and no contradiction could be detected"
              : "compared against similar records",
          // How many derivation edges were actually filed. Reported rather than assumed: on a DB that
          // never migrated the type this is 0 while the commit succeeded, and an agent told nothing
          // would believe it had recorded a basis that is not there.
          ...(derivedFrom?.length
            ? {
                derived_from: edges.filter((e) => e[0] === "derived_from")
                  .length,
              }
            : {}),
          // What was passed and could not be resolved, verbatim. Named rather than counted: the caller
          // has to see the string it sent to learn that a citation is not an id.
          ...(ignored.length ? { derived_from_ignored: ignored } : {}),
          // The record is durable and part of the commit is not. An agent reading only `id` would
          // report success, and a missing `authored_by` edge is silent afterwards — the record never
          // shows up in a persona or an author ranking. Phrased as the instruction, like the other
          // agent-facing notices: a model has to be told what to do, not handed a field.
          ...(unrecorded
            ? {
                partial:
                  `the record was stored but these could not be written: ${unrecorded.join("; ")}. ` +
                  "Do not report this as fully recorded; authorship is re-derivable by running " +
                  "'yoke backfill', and an attachment has to be filed again with yoke_link.",
              }
            : {}),
        }),
      );
    } catch (e) {
      if (e instanceof CommitRejected)
        return err(`rejected (${e.reason}): ${e.message}`);
      throw e;
    }
  }

  server.registerTool(
    "yoke_inject",
    {
      description:
        "Before starting a task, use this tool to retrieve relevant knowledge (past decisions, facts, terms). " +
        "It returns verified knowledge matching the query, each with its citation. " +
        "Set includeDraft to also include unverified (draft) knowledge, tagged with its status label. " +
        "Set scope to focus on one working context — e.g. the collaboration the team is currently on.",
      inputSchema: {
        query: z.string().describe("Natural-language query to search for"),
        includeDraft: z
          .boolean()
          .optional()
          .describe(
            "Whether to include unverified draft knowledge (default false)",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `Maximum number of results. A scope briefing (scope set, empty query) defaults to ` +
              `${BRIEFING_LIMIT}, most recently confirmed first; raise it to see more of the briefing. ` +
              `A query is never capped by default.`,
          ),
        scope: z
          .string()
          .optional()
          .describe(
            "Entity id to scope the injection to — e.g. a collaboration id to " +
              'retrieve only the knowledge linked to that unit of work. Pass "" to query ' +
              "without any scope when a session scope is pinned",
          ),
        depth: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "How many relation hops out from `scope` to walk (default 1). Use 2 or 3 to follow " +
              "chains: a decision that superseded a decision, or what the neighbouring work knows. " +
              "Nearer records are always ordered first, so a deeper walk adds context rather than " +
              "displacing the subject. Ignored without `scope`",
          ),
      },
    },
    async ({ query, includeDraft, limit, scope, depth }) => {
      if (!authorize("read")) return forbidden();
      const ts = now();
      const anchor = effectiveScope(scope);
      // A briefing (anchored, no query) had no cap at all: a collaboration with 300 records attached
      // returned all 300 in full, ~15k tokens, because someone pinned a scope. Default it, and let an
      // explicit limit override. Only the briefing — a query is already narrowed by its own terms.
      const briefing = anchor !== undefined && !query;
      const { items, omitted, walk, withheld } = await inject(
        store,
        ontology,
        query,
        ts,
        {
          includeDraft,
          limit: limit ?? (briefing ? BRIEFING_LIMIT : undefined),
          ns,
          scope: anchor,
          depth,
          // The same embedder the commit gate gets (SPEC "Hybrid retrieval"). Without it an agent's
          // query was keyword-only while its writes were being embedded — half a vector index.
          embedder,
        },
      );
      // Injection audit (PLAN 8.4): who got what knowledge injected. Front-tier I/O — core stays pure.
      // The anchor goes in the subject: without it the trail cannot tell an anchored injection from an
      // unscoped one, and which of the two agents actually do is the measurement that decides whether
      // graph expansion is worth investing in at all (docs/RESEARCH.md).
      store.logAudit?.({
        actor: defaultActor,
        action: "inject",
        detail: injectDetail(
          items.map((it) => it.entity.id),
          { query, scope: anchor },
        ),
        at: ts,
        ns,
      });
      // An agent that reads "no verified knowledge" as "there is none" answers from nothing and says
      // so confidently. Knowledge awaiting review, retired, or of a type that is not injectable are
      // three different situations and none of them is absence — so the reason travels, phrased by the
      // same helper the CLI and the web use.
      if (items.length === 0)
        return ok(
          withheld
            ? `no verified knowledge for: ${query} — ${describeWithheld(withheld)}`
            : `no verified knowledge found for: ${query}`,
        );
      const blocks = items.map(
        (it) =>
          `${it.citation} [${it.effectiveStatus}]` +
          // An agent handed two contradicting records as two equal facts answers with whichever it read
          // first and cites it. The instruction is the mechanism here, as it is for the truncation
          // notice: the model has to be told what to DO with the disagreement, not handed a field.
          (it.conflictsWith
            ? `\n[CONTRADICTED by ${it.conflictsWith.join(", ")} — both are recorded and nobody has ` +
              `settled which is right. Do not present this as established; say the org's records ` +
              `disagree and cite both.]`
            : "") +
          `\n${JSON.stringify(it.entity.attributes)}`,
      );
      // The same reasons on a NON-empty answer, phrased as the instruction an agent needs. This is the
      // case that produces a confident wrong answer: the model receives a full page, has no way to know
      // the record that actually answered the question was one day past its TTL, and reports what it
      // was handed as the state of the org's knowledge.
      if (withheld)
        blocks.push(
          `[Also matched but NOT injected: ${describeWithheld(withheld)}. ` +
            `Do not report the records above as everything known on this subject — say that ` +
            `${withheld.draft > 0 ? "unreviewed or " : ""}withheld knowledge exists and name the reason.]`,
        );
      // Never a silent slice — and for a model the notice has to be an INSTRUCTION, not a flag. An
      // agent that reads a truncated briefing as the complete record answers from part of the
      // knowledge without knowing it. Saying where the rest is turns the cap from loss into paging.
      if (omitted > 0)
        blocks.push(
          `[${items.length} of ${items.length + omitted} records on this scope, most recently confirmed first. ` +
            `The other ${omitted} are NOT lost: ask yoke_inject a specific question and it searches ` +
            `everything, scope-linked results first. Raise "limit" to see more of the briefing.]`,
        );
      // A multi-hop walk, in words, for the same reason `omitted` is: a truncated walk means absence
      // is not evidence, and a model has to be told that rather than handed a boolean.
      if (walk)
        blocks.push(
          `[Walked ${walk.depth} relation hop(s) from ${anchor}, reaching ${walk.nodes} record(s). ` +
            `Nearer records come first.` +
            (walk.truncated
              ? ` The walk stopped at its ${WALK_BUDGET}-node budget, so the OUTERMOST hop is ` +
                `incomplete — do not read a gap there as "no such knowledge"; ask a specific question ` +
                `instead, which searches everything.`
              : "") +
            "]",
        );
      return ok(blocks.join("\n\n"));
    },
  );

  server.registerTool(
    "yoke_commit",
    {
      description:
        "Ingest a new piece of knowledge into the knowledge DB — an entity (a fact, term, resource) or a " +
        "RELATION between two records (supersedes, conflicts_with, relates_to, derived_from). It enters in " +
        "the draft state and only becomes eligible for injection after a human verifies it. Rejected if the " +
        "type is not in the ontology or a required attribute is missing; the rejection lists the types that " +
        "are. To record a decision, use yoke_record_decision.\n" +
        'A relation is knowledge in its own right: "this decision replaced that one" and "these two ' +
        'records disagree" are things only you may know after reading both, and injection reads both — a ' +
        "superseded record stops being served, and contradicting ones are served marked as disputed.",
      inputSchema: {
        type: z
          .string()
          .describe(
            "Type registered in the ontology — an entity type (fact, term, …) or a relation type " +
              "(supersedes, conflicts_with, relates_to, …)",
          ),
        from: z
          .string()
          .optional()
          .describe(
            "Relation types only: the id of the record the edge starts at. For supersedes this is the " +
              "REPLACEMENT — `from supersedes to` means `from` replaced `to`",
          ),
        to: z
          .string()
          .optional()
          .describe(
            "Relation types only: the id of the record the edge points at. Both ids must be records " +
              "that exist",
          ),
        attributes: z
          .record(z.string(), z.unknown())
          .describe("Attributes validated against the per-type schema"),
        actor: z
          .string()
          .optional()
          .describe("Actor id (defaults to the server default when omitted)"),
        scope: z
          .string()
          .optional()
          .describe(
            "Entity id (e.g. a collaboration) to link the new knowledge to via a relates_to relation. " +
              'Pass "" to record outside the pinned session scope',
          ),
        derived_from: z
          .array(z.string())
          .optional()
          .describe(DERIVED_FROM_DESC),
      },
    },
    ({ type, attributes, actor, scope, derived_from, from, to }) =>
      // `from`/`to` were absent from this schema, so a relation attempt was answered "supersedes is a
      // relation type: it needs a from and a to" — about arguments the caller HAD passed and the schema
      // had silently dropped. An agent reading that message retries it forever.
      doCommit(
        from !== undefined && to !== undefined
          ? { type, attributes, from, to }
          : { type, attributes },
        actor,
        scope,
        derived_from,
      ),
  );

  server.registerTool(
    "yoke_record_decision",
    {
      description:
        "When you make a decision, always record its conclusion and rationale with this tool. Call it right " +
        "after an architecture, design, or trade-off choice. Include any rejected alternatives to prevent them " +
        "from being relitigated later. The record enters as a draft and is injected only after a human verifies it.",
      inputSchema: {
        conclusion: z.string().describe("The conclusion reached"),
        rationale: z.string().describe("The reasoning that led to it"),
        rejected_alternatives: z
          .array(z.string())
          .optional()
          .describe("Alternatives that were considered but rejected"),
        actor: z
          .string()
          .optional()
          .describe("Actor id (defaults to the server default when omitted)"),
        scope: z
          .string()
          .optional()
          .describe(
            "Entity id (e.g. a collaboration) to link this decision to via a relates_to relation. " +
              'Pass "" to record outside the pinned session scope',
          ),
        derived_from: z
          .array(z.string())
          .optional()
          .describe(DERIVED_FROM_DESC),
      },
    },
    ({
      conclusion,
      rationale,
      rejected_alternatives,
      actor,
      scope,
      derived_from,
    }) => {
      const attributes: Record<string, unknown> = { conclusion, rationale };
      if (rejected_alternatives)
        attributes.rejected_alternatives = rejected_alternatives;
      return doCommit(
        { type: "decision", attributes },
        actor,
        scope,
        derived_from,
      );
    },
  );

  server.registerTool(
    "yoke_overview",
    {
      description:
        "Describe the SHAPE of the whole knowledge base: how many records of each type and in what " +
        "state, which records the rest of the corpus is organised around, and whose verified " +
        "knowledge it holds. " +
        "Call this when the question is about the corpus rather than answerable from it — starting on " +
        "an unfamiliar codebase or team, deciding who to ask, or checking whether a topic is covered " +
        "at all before concluding it is not. " +
        "It returns structure, never a summary: no claim here was written by anyone, so nothing in it " +
        "is quotable as knowledge. Use yoke_inject for that, and the ids below are where to aim it.",
      inputSchema: {
        top: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "How many hubs and authors to list (default 10). Counts always cover everything.",
          ),
      },
    },
    async ({ top }) => {
      if (!authorize("read")) return forbidden();
      const ts = now();
      const o = await overview(store, ontology, ts, { ns, top });
      // Audited like every other read that returns knowledge attributes — a hub row carries a record's
      // own text (SPEC "Any route that returns knowledge attributes writes an audit row").
      store.logAudit?.({
        actor: defaultActor,
        action: "overview",
        detail: `overview -> ${o.hubs.map((h) => h.entity.id).join(" ")}`,
        at: ts,
        ns,
      });
      const typeLines = Object.entries(o.entities.byType)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([type, c]) => {
          const parts = (["verified", "draft", "stale", "deprecated"] as const)
            .filter((k) => c[k] > 0)
            .map((k) => `${c[k]} ${k}`);
          return `  ${type}: ${parts.join(", ")}`;
        });
      const blocks = [
        `${o.entities.total} records, ${o.relations.total} relations.`,
        `By type (only 'verified' is injectable; 'stale' means it exists but has passed its ` +
          `freshness window, so injection withholds it):\n${typeLines.join("\n")}`,
        `Most connected records — what the corpus is organised around. Authorship and roster edges ` +
          `are excluded, since those touch everything. Anchor yoke_inject on one of these ids with ` +
          `\`scope\` to read its context:\n` +
          o.hubs
            .map(
              (h) =>
                `  ${h.entity.id} (${h.entity.type}, ${h.degree} links) ${JSON.stringify(h.entity.attributes).slice(0, 160)}`,
            )
            .join("\n"),
        `Verified knowledge by author — pass one of these to yoke_persona to read their judgment. ` +
          `Counted from the authorship edge, so these are authors, not whoever approved the ` +
          `records:\n` +
          o.authors.map((a) => `  ${a.actor} (${a.verified})`).join("\n"),
      ];
      return ok(blocks.join("\n\n"));
    },
  );

  server.registerTool(
    "yoke_persona",
    {
      description:
        "Retrieve a specific person's recorded (verified) judgments and knowledge, each with its citation. " +
        "When a decision calls for the judgment of an absent colleague or owner, call this tool (even if the user does not name them directly). " +
        'For questions like "How would Alex decide this?", it provides that person\'s decisions, rationales, and facts on a citation basis. ' +
        "It is generated live from the verified knowledge at the moment of each call. " +
        'This is citation, not impersonation — if it is not in the records, answer "no record".',
      inputSchema: {
        person: z.string().describe("person entity id"),
        query: z
          .string()
          .optional()
          .describe(
            "Text to filter decisions/facts (optional, simple substring match)",
          ),
      },
    },
    async ({ person, query }) => {
      if (!authorize("read")) return forbidden();
      const ts = now();
      // Both refusals come from core now: an id that is not a record, and an id that is a record but
      // not a person (a fact id used to produce a SKILL.md about nobody, with zero sources).
      let persona: PersonaResult;
      try {
        persona = await personaQuery(store, ontology, person, ts, {
          query,
          ns,
        });
      } catch (e) {
        if (!(e instanceof NotAPerson)) throw e;
        // The CLI's hint has no MCP equivalent, and the only route to a person id here was
        // `yoke_overview`'s author list — which counts VERIFIED knowledge, so on a corpus with a review
        // backlog (the normal state, since everything an agent records is a draft) it is empty. That made
        // this a dead end unless the agent already held a ULID. The people are one read away.
        const people = (
          await store.listEntities({ type: PERSON_TYPE, ns, limit: 20 })
        ).items
          .map((p) => `${p.id} (${String(p.attributes.name ?? "unnamed")})`)
          .join(", ");
        return err(
          `${e.message}\n` +
            (people
              ? `people on record: ${people}`
              : "no person records exist in this namespace yet"),
        );
      }
      const { decisions, facts } = persona;
      // Persona reads are injections too (PLAN 8.4) — same audit trail as yoke_inject.
      const injected = [...decisions, ...facts].map((i) => i.entity);
      store.logAudit?.({
        actor: defaultActor,
        action: "persona",
        detail: `${person}${query ? ` ${query}` : ""} -> ${injected.map((e) => e.id).join(" ")}`,
        at: ts,
        ns,
      });
      // The contradiction marker, in the words yoke_inject uses. Both sides of a live conflicts_with
      // are returned — the policy is that contradictions are surfaced and never auto-resolved — and
      // this tool returned them as two equal statements of the person's position, which is the one
      // place a reader would take a disagreement for a conviction.
      const marker = (i: { conflictsWith?: string[] }) =>
        i.conflictsWith
          ? `\n[CONTRADICTED by ${i.conflictsWith.join(", ")} — both are recorded and nobody has ` +
            `settled which is right. Do not present this as ${person}'s settled position; say the ` +
            `records disagree and cite both.]`
          : "";
      const blocks: string[] = [];
      for (const i of decisions) {
        const d = i.entity;
        // What lost is half the judgment and the SKILL.md export has carried it since v5.x while this
        // path — the SPEC-designated PRIMARY one — dropped it. "Postgres was on the table and lost"
        // is how a person decides; VISION calls rejected alternatives the raw material of a persona.
        const rejected = d.attributes.rejected_alternatives;
        blocks.push(
          `[decision] ${String(d.attributes.conclusion)}\n` +
            `Rationale: ${String(d.attributes.rationale)}\n` +
            (Array.isArray(rejected) && rejected.length > 0
              ? `Rejected alternatives: ${rejected.map(String).join(", ")}\n`
              : "") +
            // `i.citation`, not `citation(d)`: core already rebuilt it with the author off the
            // `authored_by` edge. Rebuilt here without one, every line of a document that claims to be
            // Alex's judgment named whoever VERIFIED it — `yoke:system` on a single-reviewer corpus —
            // which is docs/SPEC.md:682's rule ("authorship comes off the authored_by edge, never
            // provenance.actor") broken on the surface it matters most.
            i.citation +
            marker(i),
        );
      }
      for (const i of facts)
        blocks.push(
          `[knowledge] ${JSON.stringify(i.entity.attributes)}\n${i.citation}${marker(i)}`,
        );
      // Say when this answer is a union, and that the link behind it is unreviewed. `same_as` is the
      // one input that adds a SECOND person's judgment under this anchor, and no path can promote a
      // relation, so the claim sits permanently outside governance (see inject's meaningEdges ceiling).
      if (persona.identities)
        blocks.push(
          `[This person has ${persona.identities.length} records, combined here: ` +
            `${persona.identities.map((p) => `${p.name} (${p.id})`).join(", ")}. They are recorded as ` +
            `one person by same_as, which is an unreviewed claim — if it is wrong, some of the above ` +
            `is someone else's judgment.]`,
        );
      // "no recorded knowledge" was a statement of FACT, and it was false whenever the person's
      // records were merely awaiting review — the normal state, since everything an agent commits is a
      // draft. An agent told that answers from nothing and says so confidently. Same reasons, same
      // phrasing helper as yoke_inject's empty answer.
      //
      // Phrased as a fact about the PERSON rather than about `query`, and that is not decoration: core
      // returns counts, not ids, so a filtered persona cannot say how many of the withheld records the
      // filter would have matched. Claiming it did would trade one false statement for another.
      if (blocks.length === 0)
        return ok(
          persona.withheld
            ? `no verified knowledge for ${person}${query ? ` matching "${query}"` : ""}. ` +
                `Their records also hold ${describeWithheld(persona.withheld)} — do not report this ` +
                `as "nothing recorded"; say some of their knowledge is withheld and name the reason.`
            : `no recorded knowledge for ${person} (no record).`,
        );
      // ...and on a NON-empty answer, for the reason yoke_inject says it there: a full page with the
      // one relevant record held back reads as the complete state of what this person recorded.
      if (persona.withheld)
        blocks.push(
          `[Also on record for ${person} but NOT injected: ${describeWithheld(persona.withheld)}. ` +
            `Counted over everything they authored, not over this query. Do not report the above as ` +
            `everything they have recorded.]`,
        );
      return ok(blocks.join("\n\n"));
    },
  );

  server.registerTool(
    "yoke_use_scope",
    {
      description:
        "When the user states or implies which work item / collaboration the current work belongs to " +
        "(e.g. 'this is ABC-12345 work'), call this once — subsequent injections and recordings default " +
        "to that scope. Resolves the key to a collaboration (by exact entity id, or a collaboration whose key " +
        "or title matches). If none matches, it says so and you can create one via yoke_commit (type " +
        "collaboration, attributes { title, key }) then call yoke_use_scope again. In stateless deployments " +
        "the session pin does not persist, so pass scope per call — this tool still returns the resolved id for reuse.",
      inputSchema: {
        key: z
          .string()
          .describe(
            "The work-item key (e.g. ABC-12345) or collaboration entity id the current work belongs to",
          ),
      },
    },
    async ({ key }) => {
      if (!authorize("read")) return forbidden();
      const found = await resolveScope(store, ns, key);
      if (!found)
        return ok(
          `no collaboration matches "${key}". Create one via yoke_commit ` +
            `(type: collaboration, attributes: { title, key }), then call yoke_use_scope again.`,
        );
      sessionScope = found.id;
      return ok(JSON.stringify({ id: found.id, title: found.title }));
    },
  );

  return server;
}

/** Entry point for the CLI `yoke mcp` command. Opens the DB, loads the ontology, and starts the stdio server. */
export async function runMcp(
  db: string,
  env: Record<string, string | undefined>,
  shards?: string,
): Promise<void> {
  const store = await openStore({ db, shards }, env);
  await store.init();
  // An uninitialized DB has no bootstrap actor (yoke:system) → error and exit 1.
  if (!(await store.getEntity("yoke:system"))) {
    store.close();
    process.stderr.write(
      `not initialized: ${db}\nrun 'yoke init --db ${db}' first\n`,
    );
    // exitCode + return, not `process.exit()`: an MCP server's stderr is a pipe the client owns, and
    // `process.exit()` discards whatever node has buffered for it. The one message that tells the
    // operator why the server would not start is the message most likely to be thrown away — see the
    // measurement in the CLI's entry point.
    process.exitCode = 1;
    return;
  }
  const ns = resolveNs(undefined, env);
  // Default working-context scope (v4.0): YOKE_SCOPE, an explicit entity id or collaboration key resolved
  // at startup (for fixed setups). At runtime the agent pins scope via the yoke_use_scope tool instead.
  let defaultScope: string | null = null;
  if (env.YOKE_SCOPE) {
    const resolved = await resolveScope(store, ns, env.YOKE_SCOPE);
    if (resolved) defaultScope = resolved.id;
    else
      process.stderr.write(
        `yoke: YOKE_SCOPE "${env.YOKE_SCOPE}" did not resolve to any entity or collaboration — no default scope\n`,
      );
  }
  const server = createYokeMcpServer({
    store,
    ontology: store.loadOntology(ns),
    defaultActor: env.YOKE_ACTOR ?? "yoke:system",
    ns,
    embedder: makeFetchEmbedder(env),
    defaultScope,
  });
  await server.connect(new StdioServerTransport());
  // Wait until the client closes stdin (until then runCli does not resolve, so the process stays alive).
  await new Promise<void>((resolve) => {
    server.server.onclose = resolve;
  });
  store.close();
}
