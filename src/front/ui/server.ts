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
import { backfillAuthorship, backfillEmbeddings } from "../../core/backfill.js";
import { CommitRejected, commit } from "../../core/commit.js";
import { type Embedder, makeFetchEmbedder } from "../../core/embedding.js";
import { BRIEFING_LIMIT, citation, inject } from "../../core/inject.js";
import {
  deprecate,
  effectiveStatus,
  listVersions,
  staleEntities,
  verify,
} from "../../core/lifecycle.js";
import { normalizeNs } from "../../core/namespace.js";
import type { TypeDef } from "../../core/ontology.js";
import { personaQuery } from "../../core/persona.js";
import type { Entity, Relation } from "../../core/types.js";
import { injectDetail, summarize, ULID } from "../display.js";
import { openStore, type YokeStore } from "../store.js";
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
  /** Whether this deployment requires a credential — reported by /api/meta so the shell knows to
   * show a login. Set by serve mode; `yoke ui` leaves it false (local single-user). */
  authRequired?: boolean;
  /** Read replica: the client disables mutation controls up front rather than letting people
   * discover replica mode by clicking and getting a 409. */
  readOnly?: boolean;
  /** Same embedder the CLI builds from env. Passed so a record created in the browser gets the same
   * duplicate and contradiction detection one created by `yoke add` does — without it the gate's
   * stages 3 and 4 would silently be weaker on this adapter than on the others. */
  embedder?: Embedder;
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

/** A person's display name: the `name` attribute by convention, else the first string attribute.
 * The seed ontology declares `person` with no required attrs, so this is a convention, not a schema
 * guarantee — hence the fallback and the `undefined` when there is nothing readable. */
function personName(e: Entity, ontology: TypeDef[]): string | undefined {
  const named = e.attributes.name;
  if (typeof named === "string" && named) return named;
  return summarize(e, ontology) || undefined;
}

/**
 * actor id → display name, memoized for one request.
 *
 * `provenance.actor` is "a person entity id or agent identifier" (core/types.ts), so half the time
 * it is a ULID that means nothing to a reader. Resolution lives HERE, in the front tier, and never
 * in `citation()`: the citation is the audit pointer and an id is what makes it one — names are not
 * unique and they change, so a renamed person must not rewrite history.
 *
 * ponytail: one point read per distinct actor per request, memoized. A page of 100 rows by 3 authors
 * costs 3 reads. Batch it via a port method only if a profile ever says these reads matter.
 */
function makeActorNames(store: YokeStore, ontology: TypeDef[]) {
  const seen = new Map<string, string | undefined>();
  return async (actorId: string): Promise<string | undefined> => {
    if (!seen.has(actorId)) {
      // Agent identifiers are namespaced with a colon ('yoke:system', 'connector:github-pr');
      // ULIDs never contain one, so this skips the pointless read for every machine actor.
      const e = actorId.includes(":") ? null : await store.getEntity(actorId);
      seen.set(
        actorId,
        e?.type === "person" ? personName(e, ontology) : undefined,
      );
    }
    return seen.get(actorId);
  };
}

/** The audit-visible knowledge row shape shared by every screen (citation everywhere).
 * effectiveStatus is always present because 'stale' is computed at read time and never stored
 * (core/lifecycle) — without it a client physically cannot render an expired record as expired,
 * and would show it as verified. The client renders effectiveStatus and never recomputes TTL.
 * `actor` stays the id (it is what the citation points at); `actorName` is the readable rendering
 * and is absent when the actor is a machine or an unresolvable person. */
function row(
  e: Entity,
  ontology: TypeDef[],
  ts: string,
  actorName?: string,
): {
  id: string;
  type: string;
  version: number;
  status: string;
  effectiveStatus: string;
  summary: string;
  actor: string;
  actorName?: string;
  occurred_at: string;
  citation: string;
} {
  return {
    id: e.id,
    type: e.type,
    version: e.version,
    status: e.status,
    effectiveStatus: effectiveStatus(e, ontology, ts),
    summary: summarize(e, ontology),
    actor: e.provenance.actor,
    ...(actorName === undefined ? {} : { actorName }),
    occurred_at: e.provenance.occurred_at,
    citation: citation(e),
  };
}

/** A relation row: the same shape plus its endpoints (row() reads a Relation structurally). */
function relRow(
  r: Relation,
  ontology: TypeDef[],
  ts: string,
  actorName?: string,
) {
  return { ...row(r, ontology, ts, actorName), from: r.from, to: r.to };
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

function newestFirst<
  T extends { provenance: { occurred_at: string }; id: string },
>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      b.provenance.occurred_at.localeCompare(a.provenance.occurred_at) ||
      b.id.localeCompare(a.id),
  );
}

async function graphEntities(
  store: YokeStore,
  ontology: TypeDef[],
  ns: string | null,
  limit: number,
  after?: string,
) {
  if (after) return store.listEntities({ ns, limit, after });
  const types = ontology.filter((t) => t.kind === "entity").map((t) => t.name);
  if (types.length === 0) return store.listEntities({ ns, limit });
  const perType = Math.max(1, Math.ceil(limit / types.length));
  const pages = await Promise.all(
    types.map((type) => store.listEntities({ ns, type, limit: perType })),
  );
  const items = pages.flatMap((p) => p.items).slice(0, limit);
  return {
    items,
    next: pages.some((p) => p.next !== null)
      ? (items.at(-1)?.id ?? null)
      : null,
  };
}

async function visibleGraphRelations(
  store: YokeStore,
  ids: Set<string>,
  inNs: (x: { ns?: string | null }) => boolean,
  limit: number,
) {
  const edges = new Map<string, Relation>();
  for (const id of ids) {
    for (const r of await store.neighbors(id)) {
      if (!inNs(r) || edges.has(r.id) || !ids.has(r.from) || !ids.has(r.to))
        continue;
      edges.set(r.id, r);
      if (edges.size >= limit)
        return { items: [...edges.values()], next: r.id };
    }
  }
  return { items: [...edges.values()], next: null };
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

/** How many of an audit event's referenced records get resolved to a readable summary. A bulk verify
 * can name thousands of ids; resolving all of them would turn one audit page into thousands of point
 * reads. The untouched `detail` string still holds every id, so nothing is hidden — only unexpanded.
 * ponytail: a flat per-event cap. Make it a budget across the page if audit pages ever feel slow. */
const AUDIT_REFS = 20;

async function readBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
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
  return raw ? JSON.parse(raw) : {};
}

async function readIds(req: IncomingMessage): Promise<string[]> {
  const ids = (await readBody(req)).ids;
  if (!Array.isArray(ids) || ids.some((i) => typeof i !== "string")) {
    throw new Error("body must be { ids: string[] }");
  }
  return ids as string[];
}

/** Attribute values a form can send. Anything else (nested objects, numbers that should have been
 * strings) is refused here rather than reaching the gate as a shape the ontology cannot describe. */
function readAttributes(v: unknown): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v))
    throw new Error("attributes must be an object");
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const ok =
      typeof val === "string" ||
      (Array.isArray(val) && val.every((x) => typeof x === "string"));
    if (!ok) throw new Error(`attribute "${k}" must be a string or string[]`);
  }
  return v as Record<string, unknown>;
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
  /** One audit row for a knowledge read, in the `<subject> -> <id> …` shape every other action
   * uses so the trail is comparable across adapters (SPEC "HTTP API"). Called with what is about
   * to be sent, never with what was asked for, so a row cannot claim ids the response withheld. */
  const auditRead = (
    action: "read" | "search",
    ids: string[],
    subject?: string,
  ) =>
    store.logAudit({
      actor,
      action,
      detail: subject ? `${subject} -> ${ids.join(" ")}` : ids.join(" "),
      at: now(),
      ns,
    });
  const serveStatic = createStaticHandler(
    deps.webRoot === undefined ? defaultWebRoot() : deps.webRoot,
  );
  /** A row serializer bound to this request's ontology and clock — so effectiveStatus is computed
   * once per request rather than per row, and every route reports freshness the same way.
   * Async because it also resolves actor ids to display names; the name memo is created here, per
   * call, so it cannot outlive one response and serve a renamed person their old name. */
  const asRow = () => {
    const ontology = store.loadOntology(ns);
    const ts = now();
    const nameOf = makeActorNames(store, ontology);
    return async (e: Entity) =>
      row(e, ontology, ts, await nameOf(e.provenance.actor));
  };
  /** The same, for relations — a relation is knowledge with an author too, so its row carries the
   * readable actor for the identical reason. */
  const asRelRow = () => {
    const ontology = store.loadOntology(ns);
    const ts = now();
    const nameOf = makeActorNames(store, ontology);
    return async (r: Relation) =>
      relRow(r, ontology, ts, await nameOf(r.provenance.actor));
  };

  return async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    // The shell. Served from the built bundle; when it is absent the answer is an honest 503 with
    // the command that fixes it, not a fallback UI — a second, less-tested UI is worse than a
    // message, and the v2.5 inline template proved it (its client script never parsed).
    if ((method === "GET" || method === "HEAD") && path === "/") {
      if (!(await serveStatic(req, res, path))) {
        sendJson(res, 503, {
          error:
            "web bundle not built — run 'npm run build:web' (the CLI, MCP and JSON API work without it)",
        });
      }
      return;
    }

    // Ungated on purpose: the shell must learn whether a credential is needed BEFORE it has one,
    // and a static export has no middleware to tell it. Carries no knowledge — and when the caller
    // is unauthenticated it withholds actor and ns too, so it cannot be used to enumerate tenants.
    if (method === "GET" && path === "/api/meta") {
      const authenticated = authorize("read");
      // The topbar says who you are signed in as. Under --auth that actor is a person entity id, so
      // without resolution the header reads as a ULID.
      const actorName = authenticated
        ? await makeActorNames(store, store.loadOntology(ns))(actor)
        : undefined;
      sendJson(res, 200, {
        auth: deps.authRequired ?? false,
        readOnly: deps.readOnly ?? false,
        ns: authenticated ? ns : null,
        actor: authenticated ? actor : null,
        ...(actorName === undefined ? {} : { actorName }),
      });
      return;
    }

    if (method === "GET" && path === "/api/review") {
      if (!authorize("read") && deny(res)) return;
      // The other queue: verified records past their type's TTL. SPEC's injection filter has said
      // since v1 that "viewing stale is the job of review/CLI" and neither showed one, so stale
      // knowledge left injection with nobody told — the failure docs/RESEARCH.md's freshness findings
      // all land on. Same route because it takes the same two actions.
      if (url.searchParams.get("stale") === "1") {
        const { items, next, scanned } = await staleEntities(
          store,
          store.loadOntology(ns),
          now(),
          {
            ns,
            type: url.searchParams.get("type") ?? undefined,
            limit: intParam(url, "limit", 100, 1000),
            after: url.searchParams.get("after") ?? undefined,
          },
        );
        // `scanned` travels with the rows: the walk is bounded, so a screen that printed only the
        // count would be claiming a corpus-wide number this did not compute.
        sendJson(res, 200, {
          items: await Promise.all(items.map(asRow())),
          next,
          scanned,
        });
        return;
      }
      // Every draft in the namespace. It carries no peer approval state — not because it is
      // filtered out, but because none exists: verify is immediate and per-actor, so there is no
      // pending approval to leak. The Delphi independence constraint (docs/RESEARCH.md §2–3) binds
      // whoever adds multi-reviewer aggregation; this route is not currently enforcing it, and the
      // comment that used to say "only this reviewer's list" described a filter that is not here.
      const drafts = await store.listEntities({ status: "draft", ns });
      sendJson(
        res,
        200,
        await Promise.all(newestFirst(drafts.items).map(asRow())),
      );
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
      sendJson(res, 200, {
        items: await Promise.all(p.items.map(asRow())),
        next: p.next,
      });
      return;
    }

    // The text query on browse. Deliberately the port's own `search()` — the one `inject` falls
    // back to when there is no embedder — so there is no second ranker in the product and WEB-UI
    // test 2 still holds. Same summary row shape as the listing above, through the same table, so
    // a draft hit reads as a draft.
    //
    // No cursor, by design: `search` is a top-N, not a walk of the corpus. `next` is always null
    // and `truncated` says when the cap bit, which is the honest way to cap something (the graph
    // and briefing screens already do it this way). Getting everything is `inject`, or the CLI.
    if (method === "GET" && path === "/api/search") {
      const type = url.searchParams.get("type") ?? undefined;
      if (!authorize("read", type) && deny(res)) return;
      const text = (url.searchParams.get("q") ?? "").trim();
      if (!text) {
        sendJson(res, 400, { error: "q is required" });
        return;
      }
      const limit = intParam(url, "limit", 50, 200);
      // One over the limit, so `truncated` is a fact rather than a guess about whether the cap
      // happened to land exactly on the last match.
      const found = await store.search({
        text,
        type,
        status: url.searchParams.get("status") ?? undefined,
        limit: limit + 1,
        ns,
      });
      const items = found.slice(0, limit);
      auditRead(
        "search",
        items.map((e) => e.id),
        text,
      );
      sendJson(res, 200, {
        items: await Promise.all(items.map(asRow())),
        next: null,
        truncated: found.length > limit,
        limit,
      });
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
      const asRel = asRelRow();
      const rels = await store.neighbors(id);
      const side = async (other: string) => {
        const o = await store.getEntity(other);
        return o && normalizeNs(o.ns) === normalizeNs(ns)
          ? await asR(o)
          : { id: other, missing: true };
      };
      const edges = await Promise.all(
        rels
          .filter((r) => normalizeNs(r.ns) === normalizeNs(ns))
          .map(async (r) => ({
            ...(await asRel(r)),
            dir: r.from === id ? ("out" as const) : ("in" as const),
            other: await side(r.from === id ? r.to : r.from),
          })),
      );
      // Full attributes leave the process here, which is the line SPEC draws for auditing a read:
      // the summary rows a listing returns do not, this does. One id, not the neighbours' — the
      // versions and the resolved ends come back as summary rows, so naming them would overstate
      // what this response actually disclosed.
      auditRead("read", [e.id]);
      sendJson(res, 200, {
        entity: {
          ...(await asR(e)),
          attributes: e.attributes,
          last_confirmed: e.last_confirmed,
          origin: e.provenance.origin,
          ...(e.ns != null ? { ns: e.ns } : {}),
        },
        // Core's helper, not `store.listHistory` — that extension is synchronous and therefore absent
        // on a remote backend (SPEC "Remote backends"), and it is what makes this screen work there.
        history: await Promise.all((await listVersions(store, id)).map(asR)),
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
          ? await asR(e)
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
      // As-of: what this query would have injected then. Rejected here rather than passed through, so
      // a typo produces a 400 instead of Date.parse's NaN quietly excluding every record — a screen
      // showing "0 records" for a bad date reads as "we knew nothing then", which is a lie.
      const asOfParam = url.searchParams.get("asOf") ?? undefined;
      if (asOfParam !== undefined && Number.isNaN(Date.parse(asOfParam))) {
        sendJson(res, 400, { error: "asOf must be an ISO instant" });
        return;
      }
      const { items, omitted } = await inject(
        store,
        store.loadOntology(ns),
        query,
        ts,
        {
          includeDraft,
          // This route already defaulted to 50; what it lacked was saying so. A preview that quietly
          // shows 50 of 312 misrepresents what an agent would receive.
          limit: intParam(url, "limit", BRIEFING_LIMIT, 500),
          ns,
          scope,
          asOf: asOfParam,
        },
      );
      store.logAudit({
        actor,
        action: "inject_preview",
        detail: injectDetail(
          items.map((it) => it.entity.id),
          { query, scope, asOf: asOfParam },
        ),
        at: ts,
        ns,
      });
      const asR = asRow();
      sendJson(res, 200, {
        query,
        scope: scope ?? null,
        asOf: asOfParam ?? null,
        includeDraft,
        omitted,
        items: await Promise.all(items.map((it) => asR(it.entity))),
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
      const asRel = asRelRow();
      const inNs = (x: { ns?: string | null }) =>
        normalizeNs(x.ns) === normalizeNs(ns);

      if (scope) {
        const depth = intParam(url, "depth", 1, 3);
        const nodes = new Map<string, Entity>();
        const edges = new Map<string, Relation>();
        const anchor = await store.getEntity(scope);
        if (anchor && inNs(anchor)) nodes.set(scope, anchor);
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
        const kept = [...nodes.values()].slice(0, limit);
        const keptIds = new Set(kept.map((e) => e.id));
        sendJson(res, 200, {
          anchor: scope,
          nodes: await Promise.all(kept.map(asR)),
          edges: await Promise.all(
            [...edges.values()]
              .filter((r) => keptIds.has(r.from) && keptIds.has(r.to))
              .map(asRel),
          ),
          next: { nodes: null, edges: null },
          truncated: nodes.size > kept.length,
          limit,
        });
        return;
      }

      const ontology = store.loadOntology(ns);
      const ents = await graphEntities(
        store,
        ontology,
        ns,
        limit,
        url.searchParams.get("afterNode") ?? undefined,
      );
      const keptIds = new Set(ents.items.map((e) => e.id));
      const rels = await visibleGraphRelations(store, keptIds, inNs, limit);
      sendJson(res, 200, {
        anchor: null,
        nodes: await Promise.all(ents.items.map(asR)),
        edges: await Promise.all(rels.items.map(asRel)),
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
      // The trail records ids — that is the auditable fact — but an id tells a reader nothing about
      // WHAT was injected. So the actor and every id named in `detail` are resolved for reading,
      // alongside the untouched `detail` string. One batched pass over the whole page: ids repeat
      // heavily across events (the same knowledge injected again and again), so a shared memo turns
      // what would be limit×refs point reads into one per distinct id.
      const auditOnt = store.loadOntology(ns);
      const nameOf = makeActorNames(store, auditOnt);
      const seen = new Map<string, { type: string; summary: string } | null>();
      const resolve = async (id: string) => {
        if (!seen.has(id)) {
          const e = await store.getEntity(id);
          // A miss is cached as null too: a deleted or foreign-ns id must not be re-read per event.
          const inNs = e !== null && normalizeNs(e.ns) === normalizeNs(ns);
          seen.set(
            id,
            inNs && e
              ? { type: e.type, summary: summarize(e, auditOnt) }
              : null,
          );
        }
        return seen.get(id) ?? null;
      };
      const items = await Promise.all(
        events.map(async (e) => {
          const actorName = await nameOf(e.actor);
          // `detail` has two shapes: `<subject> -> <id> <id> …` for a read, and a bare id list for a
          // lifecycle transition (verify/deprecate). Reading only the post-arrow half meant a verify
          // row rendered as raw ULIDs — the exact defect this pass exists to remove, in the rows the
          // audit screen most needs to be legible.
          const after = e.detail.split(" -> ");
          const ids = (after[1] ?? after[0] ?? "")
            .split(" ")
            .filter(Boolean)
            .slice(0, AUDIT_REFS);
          // The subject is a TOKEN LIST, not one opaque string (SPEC "HTTP API"): a persona row's
          // subject is a person id, an anchored injection's is an anchor id followed by the query
          // text. Testing the whole head against the ULID shape only resolved the first case, so an
          // anchored injection would have rendered its anchor as a raw ULID. Only ULID-shaped tokens
          // are looked up, so query words never cost a point read.
          const head = after.length > 1 ? (after[0] ?? "") : "";
          for (const token of head.split(" ").filter(Boolean))
            if (ULID.test(token)) ids.unshift(token);
          const refs = (
            await Promise.all(
              ids.map(async (id) => {
                const r = await resolve(id);
                return r === null ? null : { id, ...r };
              }),
            )
          ).filter((r) => r !== null);
          return {
            ...e,
            ...(actorName === undefined ? {} : { actorName }),
            ...(refs.length ? { refs } : {}),
          };
        }),
      );
      sendJson(res, 200, { items, limit });
      return;
    }

    if (method === "GET" && path === "/api/ontology") {
      if (!authorize("read") && deny(res)) return;
      sendJson(res, 200, store.loadOntology(ns));
      return;
    }

    if (method === "GET" && path === "/api/tokens") {
      if (!authorize("verify") && deny(res)) return;
      sendJson(res, 200, store.listTokens());
      return;
    }

    if (method === "POST" && path === "/api/tokens") {
      if (!authorize("verify") && deny(res)) return;
      const body = await readBody(req);
      const name = body.name;
      const scopes = body.scopes;
      if (
        typeof name !== "string" ||
        !name.trim() ||
        !Array.isArray(scopes) ||
        scopes.some((s) => typeof s !== "string" || !s.trim())
      ) {
        sendJson(res, 400, {
          error: "body must be { name: string, scopes: string[] }",
        });
        return;
      }
      const cleanScopes = scopes.map((s) => s.trim());
      const created_at = now();
      const { token } = store.createToken({
        name: name.trim(),
        scopes: cleanScopes,
        created_at,
      });
      sendJson(res, 201, {
        name: name.trim(),
        scopes: cleanScopes,
        created_at,
        token,
      });
      return;
    }

    if (method === "DELETE" && path.startsWith("/api/tokens/")) {
      if (!authorize("verify") && deny(res)) return;
      const name = decodeURIComponent(path.slice("/api/tokens/".length));
      if (!name) {
        sendJson(res, 400, { error: "token name is required" });
        return;
      }
      if (!store.revokeToken(name)) {
        sendJson(res, 404, { error: `no such token: ${name}` });
        return;
      }
      sendJson(res, 200, { name, revoked: true });
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
        decisions: await Promise.all(result.decisions.map(asR)),
        facts: await Promise.all(result.facts.map(asR)),
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
      sendJson(res, 200, await Promise.all(done.map(asRow())));
      return;
    }

    // Creating a record, and linking two of them. Allowed since the 2026-07-31 WEB-UI amendment:
    // the gate, not the adapter, is what enforces entry, so a record typed at a screen faces the
    // same ontology validation and the same draft-then-verify path as one an agent commits. What
    // makes that honest is `origin: "web"` below — hand-typed knowledge is permitted and labelled,
    // rather than forbidden and therefore invisible when someone works around the ban.
    //
    // No audit row: a create IS recorded, by the v1 row it produces, which carries actor, origin and
    // timestamp. That is the schema's own rule for entity mutations (see audit_log's comment), and
    // `rename_type` is an exception only because it rewrites the rows that would record it.
    if (method === "POST" && (path === "/api/entity" || path === "/api/link")) {
      const isLink = path === "/api/link";
      const body = await readBody(req);
      const type = body.type;
      if (typeof type !== "string" || !type) {
        sendJson(res, 400, { error: "type is required" });
        return;
      }
      // Per-type write permission — the same key the read routes pass, so a `ns:fact:write` token
      // can create facts and nothing else.
      if (!authorize("write", type) && deny(res)) return;
      const ontology = store.loadOntology(ns);
      if (ontology.length === 0) {
        sendJson(res, 409, { error: "not initialized: run 'yoke init' first" });
        return;
      }
      const ts = now();
      const prov = { actor, origin: "web", occurred_at: ts };
      try {
        const attributes = readAttributes(body.attributes);
        if (isLink) {
          const { from, to } = body;
          if (
            typeof from !== "string" ||
            typeof to !== "string" ||
            !from ||
            !to
          ) {
            sendJson(res, 400, { error: "from and to are required" });
            return;
          }
          const { entity } = await commit(
            store,
            ontology,
            { type, attributes, from, to },
            prov,
            ts,
            { ns },
          );
          sendJson(res, 201, await asRelRow()(entity as Relation));
          return;
        }
        const { entity, duplicates, duplicateDetection } = await commit(
          store,
          ontology,
          { type, attributes },
          prov,
          ts,
          { embedder: deps.embedder, ns },
        );
        // Capture-side linking, the same second commit `yoke add --scope` makes — so the browser
        // path and the CLI path attach knowledge to a collaboration identically.
        if (typeof body.scope === "string" && body.scope) {
          await commit(
            store,
            ontology,
            {
              type: "relates_to",
              attributes: {},
              from: entity.id,
              to: body.scope,
            },
            prov,
            ts,
            { ns },
          );
        }
        // Duplicates travel with the response: the gate found them, and a form that discards them
        // is a form that helps someone create the thing they were warned about.
        //
        // So does WHY the list is empty. "no duplicates found" and "nobody looked" are different
        // facts, and only the gate knows which one happened (SPEC gate stage 3) — a form that shows
        // neither lets someone believe their record was checked when it was not.
        sendJson(res, 201, {
          ...(await asRow()(entity)),
          duplicates: await Promise.all(duplicates.map(asRow())),
          duplicateDetection,
        });
        return;
      } catch (e) {
        // A rejection is the gate working, not a server fault — 400 with the reason it gave, so the
        // form can show the ontology's own words instead of inventing its own validation.
        if (e instanceof CommitRejected) {
          sendJson(res, 400, { error: e.message, reason: e.reason });
          return;
        }
        throw e;
      }
    }

    // Ontology migration — `yoke ontology add-type`. Gated on `verify`, not `write`: this is the
    // one write that BYPASSES the commit gate (the gate reads the ontology, so validating it against
    // itself would be circular), which makes it the most powerful action here. Append-only per name,
    // so an existing name is a new version — a migration, exactly as it is from the CLI.
    if (method === "POST" && path === "/api/ontology") {
      if (!authorize("verify") && deny(res)) return;
      const def = (await readBody(req)).def;
      if (
        !def ||
        typeof def !== "object" ||
        typeof (def as TypeDef).name !== "string" ||
        !(def as TypeDef).name ||
        ((def as TypeDef).kind !== "entity" &&
          (def as TypeDef).kind !== "relation")
      ) {
        sendJson(res, 400, {
          error: 'def must be { name, kind: "entity"|"relation", attrs }',
        });
        return;
      }
      // attrs defaulted, not overridden: a type with no attributes is legitimate (the seed's `term`
      // and `resource` both are), and the CLI's JSON-file path allows omitting the key.
      const incoming = def as TypeDef;
      const typeDef: TypeDef = { ...incoming, attrs: incoming.attrs ?? {} };
      await store.saveOntology([typeDef], ns);
      sendJson(res, 201, typeDef);
      return;
    }

    // Repair: re-derive authorship edges for records committed before the gate made them. Gated on
    // `write` because that is what it produces — edges, through the same gate, attributed to each
    // record's recorded author rather than to whoever pressed the button.
    if (method === "POST" && path === "/api/backfill") {
      if (!authorize("write") && deny(res)) return;
      const ontology = store.loadOntology(ns);
      if (ontology.length === 0) {
        sendJson(res, 409, { error: "not initialized: run 'yoke init' first" });
        return;
      }
      const body = await readBody(req);
      // The other repair: the vector index rather than the authorship graph. Still `write` and still
      // unaudited — an embedding is a derived index, not knowledge, so there is no disclosure and no
      // trust change to record (SPEC "The vector index").
      if (body.embeddings === true) {
        sendJson(
          res,
          200,
          await backfillEmbeddings(store, {
            embedder: deps.embedder ?? (async () => null),
            ns,
            limit: intParam(url, "limit", 500, 5000),
            after: typeof body.after === "string" ? body.after : undefined,
            rebuild: body.rebuild === true,
          }),
        );
        return;
      }
      sendJson(
        res,
        200,
        await backfillAuthorship(store, ontology, now(), { ns }),
      );
      return;
    }

    // Renaming a type rewrites every row that carries it, including history. Gated on `verify` for
    // that reason, and it writes the `rename_type` audit row for the reason the store documents:
    // it is the one mutation the append-only history cannot record, because it rewrites those rows.
    if (method === "POST" && path === "/api/rename-type") {
      if (!authorize("verify") && deny(res)) return;
      const body = await readBody(req);
      const { from, to } = body;
      if (typeof from !== "string" || typeof to !== "string" || !from || !to) {
        sendJson(res, 400, { error: "from and to are required" });
        return;
      }
      if (from === to) {
        sendJson(res, 400, { error: "from and to are the same name" });
        return;
      }
      const ts = now();
      const rows = await store.renameType(from, to, ns);
      if (rows > 0)
        store.logAudit({
          actor,
          action: "rename_type",
          detail: `${from} -> ${to}`,
          at: ts,
          ns,
        });
      sendJson(res, 200, { from, to, rows });
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
  // Same embedder the CLI builds, so the gate's duplicate and contradiction stages are as strong
  // for a record created in the browser as for one created by `yoke add`.
  const server = createUiServer({
    store,
    actor,
    ns: ns ?? null,
    embedder: makeFetchEmbedder(env),
  });
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
