// yoke ui — embedded governance-workbench server (PLAN 9.1). node:http only, NO express (NON-GOALS).
// The API is only the HTTP exposure of existing core/adapter functions — no UI-only business logic,
// so every action stays CLI-achievable (WEB-UI.md rule). Time is obtained in this front tier and
// passed into core; mutations are audit-logged via logAudit (same pattern as the CLI inject path).

import { existsSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { fileURLToPath } from "node:url";
import { citation, inject } from "../../core/inject.js";
import { deprecate, effectiveStatus, verify } from "../../core/lifecycle.js";
import { normalizeNs } from "../../core/namespace.js";
import type { TypeDef } from "../../core/ontology.js";
import { personaQuery } from "../../core/persona.js";
import type { Entity, Relation } from "../../core/types.js";
import { openStore, type YokeStore } from "../store.js";
import { html } from "./static/index.html.js";
import { createStaticHandler } from "./static.js";

type Env = Record<string, string | undefined>;

export interface UiDeps {
  store: YokeStore;
  /** Resolved once from env (verify/deprecate provenance + audit actor). */
  actor: string;
  /** Tenant namespace scope (PLAN-V2 10.1). Omitted/null = the default shared namespace. */
  ns?: string | null;
  now?: () => string;
  /** RBAC hook (PLAN-V2 10.4) — checked per API endpoint. Default allow-all (local single-user
   * `yoke ui` stays ungated); serve mode injects a per-request scope check. */
  authorize?: (action: "read" | "write" | "verify", type?: string) => boolean;
  /** Directory holding the built web bundle. Injectable so tests point at a fixture and never
   * depend on a build existing (CI runs tests before build). Defaults to the resolved location. */
  webRoot?: string | null;
}

/** Where the built bundle lives: the published layout first, then the source checkout, so
 * `tsx src/front/cli/index.ts ui` works in development. Memoized because serve mode constructs a
 * handler per request — an un-memoized probe would be filesystem I/O on every one. */
let cachedWebRoot: string | null | undefined;
function defaultWebRoot(): string | null {
  if (cachedWebRoot !== undefined) return cachedWebRoot;
  const candidates = [
    new URL("./app/", import.meta.url), // dist/front/ui/app
    new URL("../../../web/out/", import.meta.url), // repo checkout
  ];
  cachedWebRoot = null;
  for (const c of candidates) {
    const p = fileURLToPath(c).replace(/[/\\]$/, "");
    if (existsSync(p)) {
      cachedWebRoot = p;
      break;
    }
  }
  return cachedWebRoot;
}

/** First string value in attributes, truncated — same compact summary the CLI uses. */
function summarize(attributes: Record<string, unknown>): string {
  for (const val of Object.values(attributes)) {
    if (typeof val === "string") return val.slice(0, 60);
  }
  return "";
}

/** The audit-visible knowledge row shape shared by every screen (citation everywhere).
 * effectiveStatus is always present because 'stale' is computed at read time and never stored
 * (core/lifecycle) — without it a client physically cannot render an expired record as expired,
 * and would show it as verified. The client renders effectiveStatus and never recomputes TTL. */
function row(e: Entity, ontology: TypeDef[], ts: string) {
  return {
    id: e.id,
    type: e.type,
    version: e.version,
    status: e.status,
    effectiveStatus: effectiveStatus(e, ontology, ts),
    summary: summarize(e.attributes),
    actor: e.provenance.actor,
    occurred_at: e.provenance.occurred_at,
    citation: citation(e),
  };
}

/** A relation row: the same shape plus its endpoints (row() reads a Relation structurally). */
function relRow(r: Relation, ontology: TypeDef[], ts: string) {
  return { ...row(r, ontology, ts), from: r.from, to: r.to };
}

/** A bounded positive-int query param. Throws (→400) on garbage or over max — never a silent cap,
 * so a client asking for more than we serve learns it rather than quietly getting less. */
function intParam(url: URL, name: string, def: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`${name} must be a positive integer`);
  if (n > max) throw new Error(`${name} must be <= ${max}`);
  return n;
}

function sendJson(res: ServerResponse, code: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** 256 KiB — a bulk verify of thousands of ULIDs still fits, and an unbounded stream cannot pin
 * memory. ponytail: one cap for the one POST shape we accept; make it per-route if that changes. */
const MAX_BODY = 256 * 1024;

async function readIds(req: IncomingMessage): Promise<string[]> {
  const ct = req.headers["content-type"] ?? "";
  if (!ct.includes("application/json"))
    throw new Error("content-type must be application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("request body too large");
    chunks.push(c as Buffer);
  }
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
  const serveStatic = createStaticHandler(
    deps.webRoot === undefined ? defaultWebRoot() : deps.webRoot,
  );
  /** A row serializer bound to this request's ontology and clock — so effectiveStatus is computed
   * once per request rather than per row, and every route reports freshness the same way. */
  const asRow = () => {
    const ontology = store.loadOntology(ns);
    const ts = now();
    return (e: Entity) => row(e, ontology, ts);
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
      const drafts = await store.listEntities({ status: "draft", ns });
      sendJson(res, 200, drafts.items.map(asRow()));
      return;
    }

    // Browse: enumerate knowledge. `type` doubles as the RBAC key, so a token scoped to one
    // ontology type can use this endpoint by naming that type — and only that type.
    if (method === "GET" && path === "/api/entities") {
      const type = url.searchParams.get("type") ?? undefined;
      if (!authorize("read", type) && deny(res)) return;
      const q = {
        ns,
        type,
        status: url.searchParams.get("status") ?? undefined,
        after: url.searchParams.get("after") ?? undefined,
        limit: intParam(url, "limit", 100, 1000),
      };
      const p = await store.listEntities(q);
      sendJson(res, 200, { items: p.items.map(asRow()), next: p.next });
      return;
    }

    // Entity detail: the record as stored — full attributes (not the truncated summary), every
    // version, and the relations on both sides with the other end resolved.
    if (method === "GET" && path.startsWith("/api/entity/")) {
      const id = decodeURIComponent(path.slice("/api/entity/".length));
      const e = await store.getEntity(id);
      // Authorize on the loaded type before answering, and 404 after — so a denied caller cannot
      // use the 404-vs-403 difference to probe which ids exist.
      const ok = e ? authorize("read", e.type) : authorize("read");
      if (!ok && deny(res)) return;
      if (!e || normalizeNs(e.ns) !== normalizeNs(ns)) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      const asR = asRow();
      const ont = store.loadOntology(ns);
      const ts = now();
      const rels = await store.neighbors(id);
      const side = async (other: string) => {
        const o = await store.getEntity(other);
        return o && normalizeNs(o.ns) === normalizeNs(ns)
          ? asR(o)
          : { id: other, missing: true };
      };
      const edges = await Promise.all(
        rels
          .filter((r) => normalizeNs(r.ns) === normalizeNs(ns))
          .map(async (r) => ({
            ...relRow(r, ont, ts),
            dir: r.from === id ? ("out" as const) : ("in" as const),
            other: await side(r.from === id ? r.to : r.from),
          })),
      );
      sendJson(res, 200, {
        entity: {
          ...asR(e),
          attributes: e.attributes,
          last_confirmed: e.last_confirmed,
          origin: e.provenance.origin,
          ...(e.ns != null ? { ns: e.ns } : {}),
        },
        history: store.listHistory(id).map(asR),
        relations: {
          out: edges.filter((x) => x.dir === "out"),
          in: edges.filter((x) => x.dir === "in"),
        },
      });
      return;
    }

    if (method === "GET" && path === "/api/conflicts") {
      if (!authorize("read") && deny(res)) return;
      const rels = (await store.listRelations({ type: "conflicts_with", ns }))
        .items;
      const asR = asRow();
      // getEntity is id-based and deliberately not ns-filtered (ids are globally unique), so the
      // resolved side is checked here — the same guard core applies for the same reason (inject.ts).
      const side = async (id: string) => {
        const e = await store.getEntity(id);
        return e && normalizeNs(e.ns) === normalizeNs(ns)
          ? asR(e)
          : { id, missing: true };
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

    // Injection preview: the real inject(), so what a human sees here is byte-for-byte what an
    // agent would receive — a re-implementation with similar filters could drift from the behaviour
    // the screen claims to show. Audited as `inject_preview`, distinct from `inject`, so a human
    // checking does not pollute the record of what an agent was actually told.
    if (method === "GET" && path === "/api/inject") {
      if (!authorize("read") && deny(res)) return;
      const query = url.searchParams.get("q") ?? "";
      const scope = url.searchParams.get("scope") ?? undefined;
      if (!query && !scope)
        throw new Error("q or scope is required (scope alone is a briefing)");
      const ts = now();
      const includeDraft = url.searchParams.get("includeDraft") === "true";
      const { items } = await inject(store, store.loadOntology(ns), query, ts, {
        includeDraft,
        limit: intParam(url, "limit", 50, 500),
        ns,
        scope,
      });
      store.logAudit({
        actor,
        action: "inject_preview",
        detail: `${query} -> ${items.map((it) => it.entity.id).join(" ")}`,
        at: ts,
        ns,
      });
      const asR = asRow();
      sendJson(res, 200, {
        query,
        scope: scope ?? null,
        includeDraft,
        items: items.map((it) => asR(it.entity)),
      });
      return;
    }

    // Graph: bounded, and explicit about it. Two modes — a whole-namespace page (each side carries
    // its own cursor), or an anchored neighbourhood for click-to-expand. `truncated` is reported so
    // the client can say "showing N of more" instead of silently drawing a partial graph.
    // When truncated, an edge may reference a node outside `nodes`; that is documented, and only
    // possible in the case the banner already flags.
    if (method === "GET" && path === "/api/graph") {
      if (!authorize("read") && deny(res)) return;
      const limit = intParam(url, "limit", 300, 2000);
      const scope = url.searchParams.get("scope");
      const asR = asRow();
      const ont = store.loadOntology(ns);
      const ts = now();
      const inNs = (x: { ns?: string | null }) =>
        normalizeNs(x.ns) === normalizeNs(ns);

      if (scope) {
        const depth = intParam(url, "depth", 1, 3);
        const nodes = new Map<string, Entity>();
        const edges = new Map<string, Relation>();
        let frontier = [scope];
        for (let d = 0; d < depth && nodes.size < limit; d++) {
          const next: string[] = [];
          for (const id of frontier) {
            for (const r of await store.neighbors(id)) {
              if (!inNs(r) || edges.has(r.id)) continue;
              edges.set(r.id, r);
              const other = r.from === id ? r.to : r.from;
              if (nodes.has(other) || other === id) continue;
              const e = await store.getEntity(other);
              if (e && inNs(e)) {
                nodes.set(other, e);
                next.push(other);
              }
            }
          }
          frontier = next;
        }
        const anchor = await store.getEntity(scope);
        if (anchor && inNs(anchor)) nodes.set(scope, anchor);
        const kept = [...nodes.values()].slice(0, limit);
        const keptIds = new Set(kept.map((e) => e.id));
        sendJson(res, 200, {
          anchor: scope,
          nodes: kept.map(asR),
          edges: [...edges.values()]
            .filter((r) => keptIds.has(r.from) || keptIds.has(r.to))
            .map((r) => relRow(r, ont, ts)),
          next: { nodes: null, edges: null },
          truncated: nodes.size > kept.length,
          limit,
        });
        return;
      }

      const [ents, rels] = await Promise.all([
        store.listEntities({
          ns,
          limit,
          after: url.searchParams.get("afterNode") ?? undefined,
        }),
        store.listRelations({
          ns,
          limit,
          after: url.searchParams.get("afterEdge") ?? undefined,
        }),
      ]);
      sendJson(res, 200, {
        anchor: null,
        nodes: ents.items.map(asR),
        edges: rels.items.map((r) => relRow(r, ont, ts)),
        next: { nodes: ents.next, edges: rels.next },
        truncated: ents.next !== null || rels.next !== null,
        limit,
      });
      return;
    }

    // Audit viewer: the append-only trail, namespace-scoped. Most-recent-N, oldest-first — the same
    // direction `yoke audit` prints, so a paging client does not have to reverse it.
    if (method === "GET" && path === "/api/audit") {
      if (!authorize("read") && deny(res)) return;
      const limit = intParam(url, "limit", 200, 2000);
      const events = store.listAudit({
        since: url.searchParams.get("since") ?? undefined,
        ns,
        limit,
      });
      sendJson(res, 200, { items: events, limit });
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
      const ts = now();
      const result = await personaQuery(store, store.loadOntology(ns), id, ts, {
        ns,
      });
      // A persona read IS an injection — same knowledge, same citations — so it leaves the same
      // trail as its MCP twin. ENTERPRISE.md's audit target is "who got what knowledge injected",
      // and a read path that answers with attributes but writes no row makes that claim false.
      const injected = [...result.decisions, ...result.facts];
      store.logAudit({
        actor,
        action: "persona",
        detail: `${id} -> ${injected.map((e) => e.id).join(" ")}`,
        at: ts,
        ns,
      });
      const asR = asRow();
      sendJson(res, 200, {
        decisions: result.decisions.map(asR),
        facts: result.facts.map(asR),
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
        ns,
      });
      sendJson(res, 200, done.map(asRow()));
      return;
    }

    // Anything that is not an API route may be a bundle asset. /api/* JSON-404s without touching
    // the filesystem, so an API typo never reads a file and never leaves the JSON contract.
    if (!path.startsWith("/api/") && (await serveStatic(req, res, path)))
      return;
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

/** The default bind address. Loopback, not every interface: node's `listen(port)` binds `::`/
 * `0.0.0.0`, so an ungated workbench on a laptop was reachable by anyone on the same network while
 * the console said "localhost". Widening is an explicit `--host`. */
export const DEFAULT_HOST = "127.0.0.1";

/** Whether an address reaches only this machine (so serving it ungated is safe). */
export function isLoopback(host: string): boolean {
  return (
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "localhost" ||
    host.startsWith("127.")
  );
}

/** listen() that rejects on bind failure — EADDRINUSE becomes a one-line actionable message
 * (runCli's catch prints it and exits 1; no stack trace). Shared with serve mode. */
export function listen(
  server: Server,
  port: number,
  host: string = DEFAULT_HOST,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once("error", (e: NodeJS.ErrnoException) => {
      reject(
        e.code === "EADDRINUSE"
          ? new Error(`port ${port} is already in use (try --port ${port + 1})`)
          : e,
      );
    });
    server.listen(port, host, resolve);
  });
}

/** Open the DB, resolve the actor from env, start listening. Returns the running server. */
export async function runUi(
  db: string,
  port: number,
  env: Env,
  ns?: string | null,
  shards?: string,
  host: string = DEFAULT_HOST,
): Promise<Server> {
  const store = await openStore({ db, shards }, env);
  await store.init();
  const actor = env.YOKE_ACTOR ?? "yoke:system";
  const server = createUiServer({ store, actor, ns: ns ?? null });
  server.on("close", () => store.close());
  await listen(server, port, host);
  const addr = server.address();
  const bound = typeof addr === "object" && addr ? addr.port : port;
  // `yoke ui` has no authentication at all, so a non-loopback bind is a decision, not a detail.
  // It is allowed (a container cannot port-forward to a loopback-bound process) but never quiet.
  if (!isLoopback(host))
    process.stderr.write(
      `yoke ui: bound to ${host} with NO authentication — anyone who can reach this port can read\n` +
        `  and deprecate knowledge. Use 'yoke serve --auth --host ${host}' to expose it safely.\n`,
    );
  console.log(`yoke ui listening: http://${host}:${bound}`);
  return server;
}
