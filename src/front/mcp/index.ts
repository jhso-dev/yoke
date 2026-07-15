#!/usr/bin/env node

// yoke MCP server (PLAN 3.1–3.3) — stdio transport. Started with `yoke mcp [--db path]`.
// Three tools: yoke_inject / yoke_commit / yoke_record_decision.
// Governance: agents may only ingest drafts (no verify/deprecate tools — promotion is the CLI's job).
// Time is obtained only in this front tier (core receives `now` by injection).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { AuditEvent } from "../../adapters/storage-sqlite/index.js";
import { CommitRejected, commit } from "../../core/commit.js";
import { type Embedder, makeFetchEmbedder } from "../../core/embedding.js";
import { citation, inject } from "../../core/inject.js";
import { resolveNs } from "../../core/namespace.js";
import type { TypeDef } from "../../core/ontology.js";
import { type PersonaPort, personaQuery } from "../../core/persona.js";
import type { Entity, EntityInput } from "../../core/types.js";
import type { StoragePort } from "../../ports/storage.js";
import { openStore } from "../store.js";

const ORIGIN = "mcp";

export interface YokeMcpDeps {
  /** The persona tool needs provenance.actor lookups (listByActor), which requires the adapter extension.
   * logAudit (PLAN 8.4) is optional: adapters without it simply skip injection auditing. */
  store: StoragePort &
    Pick<PersonaPort, "listByActor"> & { logAudit?(event: AuditEvent): void };
  ontology: TypeDef[];
  /** Default actor when a tool call omits one (resolved from env at server startup). */
  defaultActor: string;
  /** Tenant namespace scope (PLAN-V2 10.1), read from YOKE_NS at startup. null = default shared ns. */
  ns?: string | null;
  /** Current time as ISO 8601. Defaults to new Date().toISOString() — tests inject a fixed value. */
  now?: () => string;
  /** Embedder for the duplicate/conflict gate. Tests inject a deterministic stub; unset = no-op (FTS fallback). */
  embedder?: Embedder;
  /** Per-request RBAC hook (PLAN-V2 10.4). Default allow-all — stdio `yoke mcp` is single-user
   * (ungated); serve mode binds this to the Bearer token's scopes. Denied calls return a tool error. */
  authorize?: (action: "read" | "write" | "verify", type?: string) => boolean;
  /** Default injection/capture scope (a workstream/entity id) resolved at startup from YOKE_SCOPE
   * (v4.0). The agent can also pin one at runtime via yoke_use_scope; a tool-call `scope` argument
   * always overrides both. null = no default. */
  defaultScope?: string | null;
}

/** Resolve a work-item key (or entity id) to a scope entity. Exact entity id wins (getEntity);
 * otherwise search for a `workstream` whose `key` OR `title` attribute equals the key. Front-tier
 * only. Returns null when nothing matches. Shared by startup (YOKE_SCOPE) and the yoke_use_scope tool.
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
  if (byId) return asEntity(byId);
  const hits = await store.search({ text: key, ns });
  const ws = hits.find(
    (e) =>
      e.type === "workstream" &&
      (e.attributes.key === key || e.attributes.title === key),
  );
  return ws ? asEntity(ws) : null;
}

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
  // could never record or query knowledge outside its workstream.
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

  async function doCommit(input: EntityInput, actor?: string, scope?: string) {
    if (!authorize("write", input.type)) return forbidden();
    const ts = now();
    const prov = {
      actor: resolveActor(actor),
      origin: ORIGIN,
      occurred_at: ts,
    };
    try {
      const { entity, duplicates } = await commit(
        store,
        ontology,
        input,
        prov,
        ts,
        { embedder, ns },
      );
      // Capture-side linking (v4.0): attach the new knowledge to the scope entity via relates_to.
      // A second gate-passing commit at the front tier — core commit stays untouched (like conflicts_with,
      // but that lives inside commit for decisions; this is caller-driven so it belongs here).
      const linkTo = effectiveScope(scope);
      if (linkTo) {
        await commit(
          store,
          ontology,
          { type: "relates_to", attributes: {}, from: entity.id, to: linkTo },
          prov,
          ts,
          { ns },
        );
      }
      return ok(
        JSON.stringify({
          id: entity.id,
          version: entity.version,
          status: entity.status,
          // Similar-knowledge candidates — no auto-merge. Included in the result for the agent to judge.
          duplicates: duplicates.map((d) => ({ id: d.id, type: d.type })),
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
        "Set scope to focus on one working context — e.g. the workstream the team is currently on.",
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
          .describe("Maximum number of results"),
        scope: z
          .string()
          .optional()
          .describe(
            "Entity id to scope the injection to (one relation hop) — e.g. a workstream id to " +
              'retrieve only the knowledge linked to that unit of work. Pass "" to query ' +
              "without any scope when a session scope is pinned",
          ),
      },
    },
    async ({ query, includeDraft, limit, scope }) => {
      if (!authorize("read")) return forbidden();
      const ts = now();
      const { items } = await inject(store, ontology, query, ts, {
        includeDraft,
        limit,
        ns,
        scope: effectiveScope(scope),
      });
      // Injection audit (PLAN 8.4): who got what knowledge injected. Front-tier I/O — core stays pure.
      store.logAudit?.({
        actor: defaultActor,
        action: "inject",
        detail: `${query} -> ${items.map((it) => it.entity.id).join(" ")}`,
        at: ts,
      });
      if (items.length === 0)
        return ok(`no verified knowledge found for: ${query}`);
      const blocks = items.map(
        (it) =>
          `${it.citation} [${it.effectiveStatus}]\n${JSON.stringify(it.entity.attributes)}`,
      );
      return ok(blocks.join("\n\n"));
    },
  );

  server.registerTool(
    "yoke_commit",
    {
      description:
        "Ingest a new piece of knowledge (a fact, term, etc.) into the knowledge DB. It enters in the " +
        "draft state and only becomes eligible for injection after a human verifies it. Rejected if the " +
        "type is not in the ontology or a required attribute is missing. To record a decision, use yoke_record_decision.",
      inputSchema: {
        type: z
          .string()
          .describe("Entity type registered in the ontology (e.g. fact, term)"),
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
            "Entity id (e.g. a workstream) to link the new knowledge to via a relates_to relation. " +
              'Pass "" to record outside the pinned session scope',
          ),
      },
    },
    ({ type, attributes, actor, scope }) =>
      doCommit({ type, attributes }, actor, scope),
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
            "Entity id (e.g. a workstream) to link this decision to via a relates_to relation. " +
              'Pass "" to record outside the pinned session scope',
          ),
      },
    },
    ({ conclusion, rationale, rejected_alternatives, actor, scope }) => {
      const attributes: Record<string, unknown> = { conclusion, rationale };
      if (rejected_alternatives)
        attributes.rejected_alternatives = rejected_alternatives;
      return doCommit({ type: "decision", attributes }, actor, scope);
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
      if (!(await store.getEntity(person)))
        return err(`person not found: ${person}`);
      const ts = now();
      const { decisions, facts } = await personaQuery(
        store,
        ontology,
        person,
        ts,
        ns,
      );
      const q = query?.toLowerCase();
      const hit = (e: Entity) =>
        q === undefined ||
        JSON.stringify(e.attributes).toLowerCase().includes(q);
      // Persona reads are injections too (PLAN 8.4) — same audit trail as yoke_inject.
      const injected = [...decisions.filter(hit), ...facts.filter(hit)];
      store.logAudit?.({
        actor: defaultActor,
        action: "persona",
        detail: `${person}${query ? ` ${query}` : ""} -> ${injected.map((e) => e.id).join(" ")}`,
        at: ts,
      });
      const blocks: string[] = [];
      for (const d of decisions.filter(hit))
        blocks.push(
          `[decision] ${String(d.attributes.conclusion)}\nRationale: ${String(d.attributes.rationale)}\n${citation(d)}`,
        );
      for (const f of facts.filter(hit))
        blocks.push(
          `[knowledge] ${JSON.stringify(f.attributes)}\n${citation(f)}`,
        );
      if (blocks.length === 0)
        return ok(`no recorded knowledge for ${person} (no record).`);
      return ok(blocks.join("\n\n"));
    },
  );

  server.registerTool(
    "yoke_use_scope",
    {
      description:
        "When the user states or implies which work item / workstream the current work belongs to " +
        "(e.g. 'this is ABC-12345 work'), call this once — subsequent injections and recordings default " +
        "to that scope. Resolves the key to a workstream (by exact entity id, or a workstream whose key " +
        "or title matches). If none matches, it says so and you can create one via yoke_commit (type " +
        "workstream, attributes { title, key }) then call yoke_use_scope again. In stateless deployments " +
        "the session pin does not persist, so pass scope per call — this tool still returns the resolved id for reuse.",
      inputSchema: {
        key: z
          .string()
          .describe(
            "The work-item key (e.g. ABC-12345) or workstream entity id the current work belongs to",
          ),
      },
    },
    async ({ key }) => {
      if (!authorize("read")) return forbidden();
      const found = await resolveScope(store, ns, key);
      if (!found)
        return ok(
          `no workstream matches "${key}". Create one via yoke_commit ` +
            `(type: workstream, attributes: { title, key }), then call yoke_use_scope again.`,
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
    process.exit(1);
  }
  const ns = resolveNs(undefined, env);
  // Default working-context scope (v4.0): YOKE_SCOPE, an explicit entity id or workstream key resolved
  // at startup (for fixed setups). At runtime the agent pins scope via the yoke_use_scope tool instead.
  let defaultScope: string | null = null;
  if (env.YOKE_SCOPE) {
    const resolved = await resolveScope(store, ns, env.YOKE_SCOPE);
    if (resolved) defaultScope = resolved.id;
    else
      process.stderr.write(
        `yoke: YOKE_SCOPE "${env.YOKE_SCOPE}" did not resolve to any entity or workstream — no default scope\n`,
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
