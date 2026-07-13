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
  /** Tenant namespace scope (PLAN-V2 10.1). Omitted/null = the default shared namespace. */
  ns?: string | null;
  now?: () => string;
  /** RBAC hook (PLAN-V2 10.4) — checked per API endpoint. Default allow-all (local single-user
   * `yoke ui` stays ungated); serve mode injects a per-request scope check. */
  authorize?: (action: "read" | "write" | "verify", type?: string) => boolean;
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

/** The bare request handler (no Server wrapper) so serve mode can reuse the exact same routes
 * behind its auth/MCP combined server (PLAN-V2 10.2). createUiServer wraps this in node:http. */
export function createUiHandler(
  deps: UiDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { store, actor } = deps;
  const ns = deps.ns ?? null;
  const now = deps.now ?? (() => new Date().toISOString());
  const authorize = deps.authorize ?? (() => true);
  /** 403 + false when denied, so callers early-return. */
  const deny = (res: ServerResponse): boolean => {
    sendJson(res, 403, { error: "forbidden" });
    return true;
  };

  return async function handle(
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
      if (!authorize("read") && deny(res)) return;
      // Only this reviewer's raw draft list — no peers' pending approvals (Delphi independence
      // guard, see the note in index.html). Hook for v3 multi-reviewer aggregation.
      sendJson(res, 200, store.listByStatus("draft", ns).map(row));
      return;
    }

    if (method === "GET" && path === "/api/conflicts") {
      if (!authorize("read") && deny(res)) return;
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
      if (!authorize("read") && deny(res)) return;
      sendJson(res, 200, store.loadOntology(ns));
      return;
    }

    if (method === "GET" && path.startsWith("/api/persona/")) {
      if (!authorize("read") && deny(res)) return;
      const id = decodeURIComponent(path.slice("/api/persona/".length));
      const result = await personaQuery(
        store,
        store.loadOntology(ns),
        id,
        now(),
        ns,
      );
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
      // Both verify and deprecate are governance actions → gated on the verify permission.
      if (!authorize("verify") && deny(res)) return;
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
  };
}

export function createUiServer(deps: UiDeps): Server {
  const handle = createUiHandler(deps);
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
  ns?: string | null,
): Promise<Server> {
  const store = new SqliteStorage(db);
  await store.init();
  const actor = env.YOKE_ACTOR ?? "yoke:system";
  const server = createUiServer({ store, actor, ns: ns ?? null });
  server.on("close", () => store.close());
  await new Promise<void>((resolve) => server.listen(port, resolve));
  const addr = server.address();
  const bound = typeof addr === "object" && addr ? addr.port : port;
  console.log(`yoke ui listening: http://localhost:${bound}`);
  return server;
}
