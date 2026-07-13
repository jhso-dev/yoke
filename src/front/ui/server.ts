// yoke ui — embedded governance-workbench server (PLAN 9.1). node:http only, NO express (NON-GOALS).
// The API is only the HTTP exposure of existing core/adapter functions — no UI-only business logic,
// so every action stays CLI-achievable (WEB-UI.md rule). Time is obtained in this front tier and
// passed into core; mutations are audit-logged via logAudit (same pattern as the CLI inject path).

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { SqliteStorage } from "../../adapters/storage-sqlite/index.js";
import { citation } from "../../core/inject.js";
import { deprecate, verify } from "../../core/lifecycle.js";
import { personaQuery } from "../../core/persona.js";
import type { Entity } from "../../core/types.js";
import { html } from "./static/index.html.js";

type Env = Record<string, string | undefined>;

export interface UiDeps {
  store: SqliteStorage;
  /** Resolved once from env (verify/deprecate provenance + audit actor). */
  actor: string;
  now?: () => string;
}

/** First string value in attributes, truncated — same compact summary the CLI uses. */
function summarize(attributes: Record<string, unknown>): string {
  for (const val of Object.values(attributes)) {
    if (typeof val === "string") return val.slice(0, 60);
  }
  return "";
}

/** The audit-visible knowledge row shape shared by every screen (citation everywhere). */
function row(e: Entity) {
  return {
    id: e.id,
    type: e.type,
    version: e.version,
    status: e.status,
    summary: summarize(e.attributes),
    actor: e.provenance.actor,
    occurred_at: e.provenance.occurred_at,
    citation: citation(e),
  };
}

function sendJson(res: ServerResponse, code: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readIds(req: IncomingMessage): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  const body = raw ? JSON.parse(raw) : {};
  const ids = (body as { ids?: unknown }).ids;
  if (!Array.isArray(ids) || ids.some((i) => typeof i !== "string")) {
    throw new Error("body must be { ids: string[] }");
  }
  return ids as string[];
}

export function createUiServer(deps: UiDeps): Server {
  const { store, actor } = deps;
  const now = deps.now ?? (() => new Date().toISOString());

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "GET" && path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (method === "GET" && path === "/api/review") {
      // Only this reviewer's raw draft list — no peers' pending approvals (Delphi independence
      // guard, see the note in index.html). Hook for v3 multi-reviewer aggregation.
      sendJson(res, 200, store.listByStatus("draft").map(row));
      return;
    }

    if (method === "GET" && path === "/api/conflicts") {
      const rels = store.listRelationsByType("conflicts_with");
      const side = async (id: string) => {
        const e = await store.getEntity(id);
        return e ? row(e) : { id, missing: true };
      };
      const pairs = await Promise.all(
        rels.map(async (r) => ({
          id: r.id,
          from: await side(r.from),
          to: await side(r.to),
        })),
      );
      sendJson(res, 200, pairs);
      return;
    }

    if (method === "GET" && path === "/api/ontology") {
      sendJson(res, 200, store.loadOntology());
      return;
    }

    if (method === "GET" && path.startsWith("/api/persona/")) {
      const id = decodeURIComponent(path.slice("/api/persona/".length));
      const result = await personaQuery(store, store.loadOntology(), id, now());
      sendJson(res, 200, {
        decisions: result.decisions.map(row),
        facts: result.facts.map(row),
      });
      return;
    }

    if (
      method === "POST" &&
      (path === "/api/verify" || path === "/api/deprecate")
    ) {
      const action = path === "/api/verify" ? "verify" : "deprecate";
      const ids = await readIds(req);
      const ts = now();
      const fn = action === "verify" ? verify : deprecate;
      const done = await fn(store, ids, actor, ts);
      // Governance action audit — who verified/deprecated what, when (same tier as CLI inject audit).
      store.logAudit({
        actor,
        action,
        detail: done.map((e) => e.id).join(" "),
        at: ts,
      });
      sendJson(res, 200, done.map(row));
      return;
    }

    sendJson(res, 404, { error: "not found" });
  }

  return createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) sendJson(res, 400, { error: (e as Error).message });
      else res.end();
    });
  });
}

/** Open the DB, resolve the actor from env, start listening. Returns the running server. */
export async function runUi(
  db: string,
  port: number,
  env: Env,
): Promise<Server> {
  const store = new SqliteStorage(db);
  await store.init();
  const actor = env.YOKE_ACTOR ?? "yoke:system";
  const server = createUiServer({ store, actor });
  server.on("close", () => store.close());
  await new Promise<void>((resolve) => server.listen(port, resolve));
  const addr = server.address();
  const bound = typeof addr === "object" && addr ? addr.port : port;
  console.log(`yoke ui listening: http://localhost:${bound}`);
  return server;
}
