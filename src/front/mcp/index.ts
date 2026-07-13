#!/usr/bin/env node

// yoke MCP server (PLAN 3.1–3.3) — stdio transport. Started with `yoke mcp [--db path]`.
// Three tools: yoke_inject / yoke_commit / yoke_record_decision.
// Governance: agents may only ingest drafts (no verify/deprecate tools — promotion is the CLI's job).
// Time is obtained only in this front tier (core receives `now` by injection).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SqliteStorage } from "../../adapters/storage-sqlite/index.js";
import { CommitRejected, commit } from "../../core/commit.js";
import { type Embedder, makeFetchEmbedder } from "../../core/embedding.js";
import { citation, inject } from "../../core/inject.js";
import type { TypeDef } from "../../core/ontology.js";
import { type PersonaPort, personaQuery } from "../../core/persona.js";
import type { Entity, EntityInput } from "../../core/types.js";
import type { StoragePort } from "../../ports/storage.js";

const ORIGIN = "mcp";

export interface YokeMcpDeps {
  /** The persona tool needs provenance.actor lookups (listByActor), which requires the adapter extension. */
  store: StoragePort & Pick<PersonaPort, "listByActor">;
  ontology: TypeDef[];
  /** Default actor when a tool call omits one (resolved from env at server startup). */
  defaultActor: string;
  /** Current time as ISO 8601. Defaults to new Date().toISOString() — tests inject a fixed value. */
  now?: () => string;
  /** Embedder for the duplicate/conflict gate. Tests inject a deterministic stub; unset = no-op (FTS fallback). */
  embedder?: Embedder;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const err = (text: string) => ({ ...ok(text), isError: true });

/** Assembles an MCP server instance. Tests connect to it over InMemoryTransport. */
export function createYokeMcpServer(deps: YokeMcpDeps): McpServer {
  const { store, ontology, defaultActor, embedder } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const server = new McpServer({ name: "yoke", version: "0.1.0" });

  // Input actor > server startup env (defaultActor) > 'yoke:system' (already folded into defaultActor).
  const resolveActor = (actor?: string) => actor ?? defaultActor;

  async function doCommit(input: EntityInput, actor?: string) {
    const ts = now();
    try {
      const { entity, duplicates } = await commit(
        store,
        ontology,
        input,
        {
          actor: resolveActor(actor),
          origin: ORIGIN,
          occurred_at: ts,
        },
        ts,
        { embedder },
      );
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
        "Set includeDraft to also include unverified (draft) knowledge, tagged with its status label.",
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
      },
    },
    async ({ query, includeDraft, limit }) => {
      const { items } = await inject(store, ontology, query, now(), {
        includeDraft,
        limit,
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
      },
    },
    ({ type, attributes, actor }) => doCommit({ type, attributes }, actor),
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
      },
    },
    ({ conclusion, rationale, rejected_alternatives, actor }) => {
      const attributes: Record<string, unknown> = { conclusion, rationale };
      if (rejected_alternatives)
        attributes.rejected_alternatives = rejected_alternatives;
      return doCommit({ type: "decision", attributes }, actor);
    },
  );

  server.registerTool(
    "yoke_persona",
    {
      description:
        "Retrieve a specific person's recorded (verified) judgments and knowledge, each with its citation. " +
        "When a decision calls for the judgment of an absent colleague or owner, call this tool (even if the user does not name them directly). " +
        'For questions like "How would Nathen decide this?", it provides that person\'s decisions, rationales, and facts on a citation basis. ' +
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
      if (!(await store.getEntity(person)))
        return err(`person not found: ${person}`);
      const { decisions, facts } = await personaQuery(
        store,
        ontology,
        person,
        now(),
      );
      const q = query?.toLowerCase();
      const hit = (e: Entity) =>
        q === undefined ||
        JSON.stringify(e.attributes).toLowerCase().includes(q);
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

  return server;
}

/** Entry point for the CLI `yoke mcp` command. Opens the DB, loads the ontology, and starts the stdio server. */
export async function runMcp(
  db: string,
  env: Record<string, string | undefined>,
): Promise<void> {
  const store = new SqliteStorage(db);
  await store.init();
  // An uninitialized DB has no bootstrap actor (yoke:system) → error and exit 1.
  if (!(await store.getEntity("yoke:system"))) {
    store.close();
    process.stderr.write(
      `not initialized: ${db}\nrun 'yoke init --db ${db}' first\n`,
    );
    process.exit(1);
  }
  const server = createYokeMcpServer({
    store,
    ontology: store.loadOntology(),
    defaultActor: env.YOKE_ACTOR ?? "yoke:system",
    embedder: makeFetchEmbedder(env),
  });
  await server.connect(new StdioServerTransport());
  // Wait until the client closes stdin (until then runCli does not resolve, so the process stays alive).
  await new Promise<void>((resolve) => {
    server.server.onclose = resolve;
  });
  store.close();
}
