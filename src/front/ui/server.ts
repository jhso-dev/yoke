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
import { CommitRejected, commit, parseInstant } from "../../core/commit.js";
import { type Embedder, makeFetchEmbedder } from "../../core/embedding.js";
import { BRIEFING_LIMIT, citation, inject } from "../../core/inject.js";
import {
  deprecate,
  downstreamOf,
  effectiveStatus,
  listVersions,
  staleEntities,
  verify,
} from "../../core/lifecycle.js";
import { normalizeNs } from "../../core/namespace.js";
import { type TypeDef, validateTypeDef } from "../../core/ontology.js";
import {
  NotAPerson,
  type PersonaResult,
  personaQuery,
} from "../../core/persona.js";
import type { Entity, Relation } from "../../core/types.js";
import { readEntities } from "../../ports/storage.js";
import {
  CONSUMPTION_WINDOW,
  consumptionCounts,
  injectDetail,
  makeActorNames,
  rankByConsumption,
  refuseKindChange,
  refuseRename,
  retirementOf,
  summarize,
  ULID,
} from "../display.js";
import { parseScope } from "../serve/rbac.js";
import { type AuditEvent, openStore, type YokeStore } from "../store.js";
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
  authorize?: (
    action: "read" | "write" | "verify" | "admin",
    type?: string,
  ) => boolean;
  /**
   * Which of `wanted` this caller may NOT put into a credential (empty = all of them).
   *
   * Holding `admin` is permission to run these routes; it is not permission to write any scope string
   * into a token. Injected rather than computed here because only serve mode knows the principal's own
   * scopes — and because the local ungated path has no principal and must stay unrestricted
   * (invariant 4). See `ungrantable` in serve/rbac.ts for the reach rule.
   */
  grantable?: (wanted: string[]) => string[];
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

/**
 * A timestamp query param, or a 400 — returned NORMALIZED to UTC ISO 8601, never as sent.
 *
 * The CLI's `instantFlag`, for the web tier, for both of that function's reasons: garbage must not
 * reach a comparison (`Date.parse` → NaN → every row excluded → an empty screen that reads as "nothing
 * happened then"), and a VALID instant in offset notation must not either — `?since=2026-08-14T12:00:00+09:00`
 * compared as a string against stored `...Z` stamps sorts above every `Z` row and answers "no audit
 * events" for a governance trail that has them.
 */
function instantParam(url: URL, name: string): string | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  // The gate's own strict parser (CLAUDE.md: the second place that parses calls the first). `Date.parse`
  // accepted what the gate rejects — `2026-02-30` (rolls to Mar 2), `"2026-08-14 00:00:00"`
  // (tz-dependent), `"0"` (→ 1999) — all 200 with silently-wrong filtering. Rethrown as this route's
  // 400 with the field name so the message still says which param was bad.
  try {
    return parseInstant(raw);
  } catch {
    throw new Error(`${name} must be an ISO 8601 instant (got "${raw}")`);
  }
}

function newestFirst<
  T extends { provenance: { occurred_at: string }; id: string },
>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      // By instant, not by string: a database predating the gate's canonicalization holds both
      // vintages, and `Z` sorts after `.`, so a record confirmed at 00:00:00.500Z would sort OLDER
      // than one at 00:00:00Z. The last collating comparison of a timestamp in the product.
      Date.parse(b.provenance.occurred_at) -
        Date.parse(a.provenance.occurred_at) || b.id.localeCompare(a.id),
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

/**
 * How many `neighbors` calls are in flight at once. The graph reads issue one per node, and a frontier
 * is bounded only by `limit` (2000) — an unbounded `Promise.all` over it opens a socket per node, which
 * a remote backend answers with a connection error rather than a slow reply. 16 is the same order as
 * the workflow concurrency cap and well under any server's default connection limit.
 */
const FANOUT = 16;

/** Map with bounded concurrency, preserving input order. */
async function mapLimit<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  limit = FANOUT,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    const done = await Promise.all(chunk.map(fn));
    done.forEach((r, j) => {
      out[i + j] = r;
    });
  }
  return out;
}

/**
 * Edges among a known node set — both ends inside it, so the client never has to draw a dangling one.
 *
 * The `neighbors` calls are issued together and folded afterwards **in the original id order**, which
 * keeps the answer byte-identical to a sequential walk: the fold, including the early return when
 * `limit` is reached, still walks ids in the order the caller gave them.
 *
 * ceiling: still one call per node — `neighbors` takes a single id, and a batch form is a port method
 * with four implementations and a conformance case behind it. Concurrency was the free half; add the
 * port method when a measurement says the remaining round trips cost more than the wall clock does.
 */
async function visibleGraphRelations(
  store: YokeStore,
  ids: Set<string>,
  inNs: (x: { ns?: string | null }) => boolean,
  limit: number,
) {
  const order = [...ids];
  const perNode = await mapLimit(order, (id) => store.neighbors(id));
  const edges = new Map<string, Relation>();
  for (const rels of perNode) {
    for (const r of rels) {
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
 * memory. ceiling: one cap for the one POST shape we accept; make it per-route if that changes. */
const MAX_BODY = 256 * 1024;

/** How many of an audit event's referenced records get resolved to a readable summary. A bulk verify
 * can name thousands of ids; resolving all of them would turn one audit page into thousands of point
 * reads. The untouched `detail` string still holds every id, so nothing is hidden — only unexpanded.
 * ceiling: a flat per-event cap. Make it a budget across the page if audit pages ever feel slow. */
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

async function readIds(
  req: IncomingMessage,
): Promise<{ ids: string[]; reason?: string }> {
  const body = await readBody(req);
  const ids = body.ids;
  if (!Array.isArray(ids) || ids.some((i) => typeof i !== "string")) {
    throw new Error("body must be { ids: string[] }");
  }
  // `reason` is optional and only a governance act carries one. Rejected if it is the wrong shape
  // rather than coerced: a number where a sentence belongs is a caller bug, not a reason.
  const reason = body.reason;
  if (reason !== undefined && typeof reason !== "string")
    throw new Error("reason must be a string");
  return { ids: ids as string[], reason: reason as string | undefined };
}

/** Attribute values a form can send. Anything else (nested objects, numbers that should have been
 * strings) is refused here rather than reaching the gate as a shape the ontology cannot describe. */
/**
 * The four value shapes an attribute may take — the same four the ontology declares (`string`,
 * `number`, `boolean`, `string[]`, see core/ontology.ts AttrSpec).
 *
 * It used to accept only strings and string arrays, which made the route narrower than the gate it
 * fronts: a type declaring a `number` attribute could be committed from the CLI and not from HTTP,
 * so the web form had no honest way to offer the field at all. Validation still belongs to the gate;
 * this only refuses shapes no attribute can ever hold (objects, nested arrays, null).
 */
function readAttributes(v: unknown): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v))
    throw new Error("attributes must be an object");
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const ok =
      typeof val === "string" ||
      typeof val === "number" ||
      typeof val === "boolean" ||
      (Array.isArray(val) && val.every((x) => typeof x === "string"));
    if (!ok)
      throw new Error(
        `attribute "${k}" must be a string, number, boolean or string[]`,
      );
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
  /**
   * Refuse the credential routes to a remote caller on a server that authenticates nobody.
   *
   * `yoke ui --host 0.0.0.0` warns and binds anyway, which is deliberate: a container cannot
   * port-forward to a loopback-bound process, so widening the bind is a decision the operator is
   * allowed to make. What they did not decide is that anonymous LAN callers may MINT CREDENTIALS — a
   * token minted this way authenticates against a hardened `serve --auth` process on the same database,
   * so the exposure escapes the server that was deliberately exposed.
   *
   * Narrow on purpose. Reading and retiring knowledge over a bind the operator widened is the
   * documented trade; issuing credentials that work somewhere else is not, and it is the one thing on
   * this surface that is not about this deployment's knowledge.
   */
  const remoteCredentialRequest = (req: IncomingMessage): boolean =>
    // serve --auth: scopes decide, not the socket.
    !deps.authRequired && !isLoopbackPeer(req.socket.remoteAddress);
  const refusedRemoteCredential = (
    req: IncomingMessage,
    res: ServerResponse,
  ): boolean => {
    if (!remoteCredentialRequest(req)) return false;
    sendJson(res, 403, {
      error:
        "credentials cannot be issued or listed over a non-loopback connection on an " +
        "unauthenticated server — run 'yoke token create' on the host, or 'yoke serve --auth'",
    });
    return true;
  };
  // No principal on the local ungated path, so nothing is out of reach there (invariant 4).
  const grantable = deps.grantable ?? (() => []);
  /**
   * Authorize, and on refusal answer 403 naming the scope that would have granted it.
   *
   * A bare `{"error":"forbidden"}` refuses correctly and tells the holder nothing they can act on —
   * not which permission to ask for, and not whether the refusal was about this record's type or the
   * namespace. "Errors explain what went wrong and how to fix it."
   *
   * Only the REQUIRED scope is named, never the token's own. What the caller holds does not change
   * what they have to go and ask for, and the handler would have to be threaded the principal to say
   * it — surface bought for nothing.
   *
   * Returns true when refused, so call sites stay `if (denied(...)) return;`.
   */
  const denied = (
    res: ServerResponse,
    action: "read" | "write" | "verify" | "admin",
    type?: string,
  ): boolean => {
    if (authorize(action, type)) return false;
    // The scope grammar is `action` | `ns:action` | `ns:type:action` (serve/rbac.ts), and a wildcard
    // in either position also grants it — so the message names the grant needed, not one exact string
    // that would read as the only acceptable spelling.
    const where = [
      type === undefined ? null : `type '${type}'`,
      ns === null ? null : `namespace '${ns}'`,
    ].filter(Boolean);
    sendJson(res, 403, {
      error:
        `forbidden: this credential has no '${action}' scope` +
        (where.length ? ` for ${where.join(" in ")}` : ""),
      required: action,
      ...(type === undefined ? {} : { type }),
      ...(ns === null ? {} : { ns }),
    });
    return true;
  };
  /**
   * A read's audit row, written best-effort (C7).
   *
   * A search/entity/inject read whose answer is already computed must not be discarded because the
   * trail INSERT lost the write lock to a concurrent writer — WAL's guarantee is that readers never
   * block, so a `database is locked` on a secondary trail row must not become a failed query. A failed
   * write is logged and dropped (the read succeeded — the trail is a secondary record), never
   * propagated to the response. Write routes keep their audit inline; only reads use this.
   */
  const bestEffortAudit = (event: AuditEvent): void => {
    try {
      store.logAudit(event);
    } catch (err) {
      console.error(
        `audit row not written (read succeeded): ${(err as Error).message}`,
      );
    }
  };
  /** One audit row for a knowledge read, in the `<subject> -> <id> …` shape every other action
   * uses so the trail is comparable across adapters (SPEC "HTTP API"). Called with what is about
   * to be sent, never with what was asked for, so a row cannot claim ids the response withheld. */
  const auditRead = (
    action: "read" | "search",
    ids: string[],
    subject?: string,
  ) =>
    bestEffortAudit({
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
  /** Entity rows, relation rows, and the actor-name prefetch — ONE memo behind all three, so a route
   * serializing both entities and relations (the graph route) does not read every author twice. */
  const serializers = () => {
    const ontology = store.loadOntology(ns);
    const ts = now();
    // ns-scoped: nameOf withholds a name whose resolved person is in a DIFFERENT namespace than this
    // route's ns, so a tenant-a response never carries a default-ns person's name (W-SECURITY).
    const { nameOf, prefetch } = makeActorNames(store, ontology, ns);
    return {
      asR: async (e: Entity) =>
        row(e, ontology, ts, await nameOf(e.provenance.actor)),
      asRel: async (r: Relation) =>
        relRow(r, ontology, ts, await nameOf(r.provenance.actor)),
      prefetch,
      // Exposed so the inject/persona routes can resolve an AUTHOR id (off the authored_by edge, not
      // provenance.actor) to a name — the citation core built names the writer, and the screen has to
      // render it. ceiling: a point read per distinct author not already prefetched; the memo dedups,
      // and a persona's rows share one author so it costs one read.
      nameOf,
    };
  };
  const asRow = () => serializers().asR;
  /** The same, for relations — a relation is knowledge with an author too, so its row carries the
   * readable actor for the identical reason. */
  const asRelRow = () => serializers().asRel;
  /** Serialize a list: the actors resolve in one batch read, then the rows. Every route that returns
   * more than one row goes through this — the alternative is a point read per distinct author, which
   * is what a real corpus has one of per record. */
  const rowsOf = async <T extends Entity>(xs: T[]) => {
    const { asR, prefetch } = serializers();
    await prefetch(xs);
    return Promise.all(xs.map(asR));
  };

  return async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    // The shell. Served from the built bundle; when it is absent the answer is an honest 503 with
    // the command that fixes it, not a fallback UI — a second, less-tested UI is worse than a message.
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
      // "Authenticated" is holding ANY scope, not `read` specifically: a least-privileged admin
      // (`tenant-a:*:admin`) has no `read`, and a type-scoped principal (`*:fact:read`) grants no
      // untyped action, so both must be found by probing every declared type as well as the four
      // untyped actions — otherwise their credential works but Create is a dead button (W-META). ns is
      // this principal's own namespace (the 403 body already discloses it), so any valid credential may
      // learn it. Fails closed: an anonymous caller has authorize()===false for every pair, so it still
      // cannot enumerate the actor or namespace.
      const metaOntology = store.loadOntology(ns);
      const actions = ["read", "write", "verify", "admin"] as const;
      const authenticated =
        actions.some((a) => authorize(a)) ||
        metaOntology.some((t) => actions.some((a) => authorize(a, t.name)));
      // The topbar says who you are signed in as. Under --auth that actor is a person entity id, so
      // without resolution the header reads as a ULID.
      const actorName = authenticated
        ? await makeActorNames(store, metaOntology, ns).nameOf(actor)
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
      if (denied(res, "read")) return;
      // The other queue: verified records past their type's TTL. SPEC's injection filter makes viewing
      // stale review's job — otherwise stale knowledge leaves injection with nobody told, the failure
      // docs/RESEARCH.md's freshness findings all land on. Same route because it takes the same two
      // actions.
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
        // Most-consumed first (same rule as `yoke review --stale`): the count is inject+persona
        // audit rows naming the record, so re-confirmation effort goes where agents are actually
        // reading. Ranked before serialization; `injections` rides on each row. Bounded to the most
        // recent CONSUMPTION_WINDOW audit rows (F1): the whole trail materialized every row into JS.
        const ranked = rankByConsumption(
          items,
          consumptionCounts(store.listAudit({ ns, limit: CONSUMPTION_WINDOW })),
        );
        // `scanned` travels with the rows: the walk is bounded, so a screen that printed only the
        // count would be claiming a corpus-wide number this did not compute. `consumptionWindow` is
        // the count's own bound — never a silent slice: the screen can say what "injections" counts.
        sendJson(res, 200, {
          items: (await rowsOf(ranked)).map((r, i) => ({
            ...r,
            injections: ranked[i].injections,
          })),
          next,
          scanned,
          consumptionWindow: CONSUMPTION_WINDOW,
        });
        return;
      }
      // Every draft in the namespace. It carries no peer approval state — not because it is
      // filtered out, but because none exists: verify is immediate and per-actor, so there is no
      // pending approval to leak. The Delphi independence constraint (docs/RESEARCH.md §2–3) binds
      // whoever adds multi-reviewer aggregation. This route enforces nothing of the sort today, and
      // saying it returned "only this reviewer's list" would describe a filter that is not here.
      const drafts = await store.listEntities({ status: "draft", ns });
      sendJson(res, 200, await rowsOf(newestFirst(drafts.items)));
      return;
    }

    // Browse: enumerate knowledge. `type` doubles as the RBAC key, so a token scoped to one
    // ontology type can use this endpoint by naming that type — and only that type.
    if (method === "GET" && path === "/api/entities") {
      const type = url.searchParams.get("type") ?? undefined;
      if (denied(res, "read", type)) return;
      const q = {
        ns,
        type,
        status: url.searchParams.get("status") ?? undefined,
        after: url.searchParams.get("after") ?? undefined,
        limit: intParam(url, "limit", 100, 1000),
      };
      const p = await store.listEntities(q);
      sendJson(res, 200, {
        items: await rowsOf(p.items),
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
      if (denied(res, "read", type)) return;
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
        items: await rowsOf(items),
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
      if (denied(res, "read", e?.type)) return;
      if (!e || normalizeNs(e.ns) !== normalizeNs(ns)) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      const { asR, asRel, nameOf } = serializers();
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
        // Why it was retired, if anyone said. A deprecated record raises exactly one question and
        // could not answer it: the status was on the record and the reason nowhere. It comes from the
        // audit trail rather than the record because verify/deprecate change status, never knowledge
        // content — so this reads the governance act back instead of copying it onto the row.
        // `asR` already resolved the read-time status; reading it off the row keeps one answer to
        // "is this retired" rather than recomputing the rule here.
        ...(await (async () => {
          if ((await asR(e)).effectiveStatus !== "deprecated") return {};
          const retire = retirementOf(store, id, ns);
          if (!retire) return {};
          // The retiree resolved for reading, like entity.actorName above it — the same response
          // resolves the record's own actor and left this one a bare ULID in the "Retired by …"
          // sentence. The id stays on the row for hover/copy (no-raw-ids rule).
          const actorName = await nameOf(retire.actor);
          return {
            retirement: {
              ...retire,
              ...(actorName === undefined ? {} : { actorName }),
            },
          };
        })()),
        relations: {
          out: edges.filter((x) => x.dir === "out"),
          in: edges.filter((x) => x.dir === "in"),
        },
      });
      return;
    }

    if (method === "GET" && path === "/api/conflicts") {
      if (denied(res, "read")) return;
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
      if (denied(res, "read")) return;
      const query = url.searchParams.get("q") ?? "";
      const scope = url.searchParams.get("scope") ?? undefined;
      if (!query && !scope)
        throw new Error("q or scope is required (scope alone is a briefing)");
      const ts = now();
      const includeDraft = url.searchParams.get("includeDraft") === "true";
      // As-of: what this query would have injected then. Rejected here rather than passed through, so
      // a typo produces a 400 instead of Date.parse's NaN quietly excluding every record — a screen
      // showing "0 records" for a bad date reads as "we knew nothing then", which is a lie.
      const asOfParam = instantParam(url, "asOf");
      // Same default rule as the MCP tool and the CLI, verbatim: an anchored briefing is capped at
      // BRIEFING_LIMIT, a query is not (SPEC "the three front adapters apply the default to a
      // briefing … and never to a query"). Defaulting every call would show 50 where the agent gets
      // everything — the drift the byte-for-byte claim below forbids, on the one screen whose job is
      // to rule it out.
      const explicitLimit = url.searchParams.has("limit")
        ? intParam(url, "limit", BRIEFING_LIMIT, 500)
        : undefined;
      const briefing = scope !== undefined && !query;
      const { items, omitted, walk, withheld } = await inject(
        store,
        store.loadOntology(ns),
        query,
        ts,
        {
          includeDraft,
          limit: explicitLimit ?? (briefing ? BRIEFING_LIMIT : undefined),
          ns,
          scope,
          // Relation hops the anchor walk takes (SPEC "Multi-hop", default 1) — the MCP tool takes
          // this, so a preview without it could not reproduce a depth-2 agent call. Bounded like the
          // graph route's; core's WALK_BUDGET caps the blast radius regardless.
          depth: url.searchParams.has("depth")
            ? intParam(url, "depth", 1, 3)
            : undefined,
          asOf: asOfParam,
          // Hybrid retrieval (SPEC "Hybrid retrieval"). The preview's whole claim is that it shows
          // byte-for-byte what an agent receives, so retrieving by a different half would break it.
          embedder: deps.embedder,
        },
      );
      // Built here, written AFTER the response is sent (C7): before sendJson, a held write lock would
      // turn a preview the human already needed into a `database is locked` 500.
      const previewEvent: AuditEvent = {
        actor,
        action: "inject_preview",
        detail: injectDetail(
          items.map((it) => it.entity.id),
          { query, scope, asOf: asOfParam },
        ),
        at: ts,
        ns,
      };
      const { asR, prefetch, nameOf } = serializers();
      sendJson(res, 200, {
        query,
        scope: scope ?? null,
        asOf: asOfParam ?? null,
        includeDraft,
        omitted,
        // Present only when the walk went deeper than one hop — same shape core hands the MCP tool,
        // so the preview can state what a depth-2 answer walked (`{ depth, nodes, truncated }`).
        walk: walk ?? null,
        // Why an empty preview is empty. The preview's claim is that it shows what an agent receives,
        // and an agent now receives the reason too — without this the screen would be the one surface
        // still rendering a bare "no results" for knowledge that is merely awaiting review.
        withheld: withheld ?? null,
        items: await (async () => {
          const es = items.map((it) => it.entity);
          await prefetch(es);
          const rows = await Promise.all(es.map(asR));
          // The author-aware citation, the author id, and the contradiction marker travel with the row.
          // row() rebuilt `citation` from provenance alone, naming the PROMOTER as the author — on a
          // verified record that is whoever approved it, not whoever wrote it. Core already built the
          // right citation (item.citation) and knows the writer (item.author); both are handed over and
          // the author id is resolved for reading. Without the marker two records that disagree render
          // as two identical rows, the defect the conflicts screen was already showing one page over.
          return Promise.all(
            rows.map(async (r, i) => {
              const it = items[i];
              const authorName = it.author
                ? await nameOf(it.author)
                : undefined;
              return {
                ...r,
                citation: it.citation,
                ...(it.author ? { author: it.author } : {}),
                ...(authorName === undefined ? {} : { authorName }),
                ...(it.conflictsWith
                  ? { conflictsWith: it.conflictsWith }
                  : {}),
              };
            }),
          );
        })(),
      });
      bestEffortAudit(previewEvent);
      return;
    }

    // Graph: bounded, and explicit about it. Two modes — a whole-namespace page (each side carries
    // its own cursor), or an anchored neighbourhood for click-to-expand. `truncated` is reported so
    // the client can say "showing N of more" instead of silently drawing a partial graph.
    // When truncated, an edge may reference a node outside `nodes`; that is documented, and only
    // possible in the case the banner already flags.
    if (method === "GET" && path === "/api/graph") {
      if (denied(res, "read")) return;
      const limit = intParam(url, "limit", 300, 2000);
      const scope = url.searchParams.get("scope");
      const { asR, asRel, prefetch } = serializers();
      const inNs = (x: { ns?: string | null }) =>
        normalizeNs(x.ns) === normalizeNs(ns);

      if (scope) {
        const depth = intParam(url, "depth", 1, 3);
        const nodes = new Map<string, Entity>();
        const edges = new Map<string, Relation>();
        const anchor = await store.getEntity(scope);
        if (anchor && inNs(anchor)) nodes.set(scope, anchor);
        // One hop at a time, and each hop is TWO waits rather than two per node: the frontier's
        // `neighbors` calls go out together, then the entities the hop discovered are read in a single
        // batch. The fold order follows the frontier, so which nodes survive the `limit` cut does not
        // depend on which request finished first.
        let frontier = [scope];
        for (let d = 0; d < depth && nodes.size < limit; d++) {
          const perNode = await mapLimit(frontier, (id) => store.neighbors(id));
          const discovered: string[] = [];
          frontier.forEach((id, i) => {
            for (const r of perNode[i]) {
              if (!inNs(r) || edges.has(r.id)) continue;
              edges.set(r.id, r);
              const other = r.from === id ? r.to : r.from;
              if (nodes.has(other) || other === id) continue;
              // Not added to `nodes` yet: the ns check needs the row, and the row comes below. Pushing
              // it here would let a later relation in the same hop skip it as already-seen.
              discovered.push(other);
            }
          });
          const next: string[] = [];
          for (const e of await readEntities(store, discovered)) {
            if (!inNs(e) || nodes.has(e.id)) continue;
            nodes.set(e.id, e);
            next.push(e.id);
          }
          frontier = next;
        }
        const kept = [...nodes.values()].slice(0, limit);
        const keptIds = new Set(kept.map((e) => e.id));
        const keptEdges = [...edges.values()].filter(
          (r) => keptIds.has(r.from) && keptIds.has(r.to),
        );
        // Nodes AND edges in one prefetch: both carry an author, and a graph of 517 nodes has roughly
        // 517 distinct ones, so the memo alone bought nothing.
        await prefetch([...kept, ...keptEdges]);
        sendJson(res, 200, {
          anchor: scope,
          nodes: await Promise.all(kept.map(asR)),
          edges: await Promise.all(keptEdges.map(asRel)),
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
      await prefetch([...ents.items, ...rels.items]);
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
      if (denied(res, "read")) return;
      const limit = intParam(url, "limit", 200, 2000);
      const events = store.listAudit({
        // Through the same gate as every other instant this server accepts — these two went straight
        // into SQL string comparisons (see `instantParam` for what that answered).
        since: instantParam(url, "since"),
        until: instantParam(url, "until"),
        ns,
        limit,
      });
      // The trail records ids — that is the auditable fact — but an id tells a reader nothing about
      // WHAT was injected. So the actor and every id named in `detail` are resolved for reading,
      // alongside the untouched `detail` string. One batched pass over the whole page: ids repeat
      // heavily across events (the same knowledge injected again and again), so a shared memo turns
      // what would be limit×refs point reads into one per distinct id.
      const auditOnt = store.loadOntology(ns);
      // ns-scoped like every other resolver here — a foreign-ns actor id resolves to no name (W-SECURITY).
      const { nameOf } = makeActorNames(store, auditOnt, ns);
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
          // lifecycle transition (verify/deprecate). Reading only the post-arrow half would render a
          // verify row as raw ULIDs, on the screen that most needs to be legible.
          const after = e.detail.split(" -> ");
          const ids = (after[1] ?? after[0] ?? "")
            .split(" ")
            .filter(Boolean)
            .slice(0, AUDIT_REFS);
          // The subject is a TOKEN LIST, not one opaque string (SPEC "HTTP API"): a persona row's
          // subject is a person id, an anchored injection's is an anchor id followed by the query text.
          // Only ULID-shaped tokens are looked up, so query words never cost a point read and an
          // anchored injection's anchor is resolved rather than shown raw.
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
      if (denied(res, "read")) return;
      sendJson(res, 200, store.loadOntology(ns));
      return;
    }

    if (method === "GET" && path === "/api/tokens") {
      // `admin`, not `verify`: this is the credential surface, and every reviewer holds verify.
      if (denied(res, "admin")) return;
      if (refusedRemoteCredential(req, res)) return;
      // Only the rows this caller could have issued. A tenant admin listing every tenant's credentials
      // and their scopes is a map of the whole deployment's access.
      const visible = store
        .listTokens()
        .filter((t) => grantable(t.scopes).length === 0);
      sendJson(res, 200, visible);
      return;
    }

    if (method === "POST" && path === "/api/tokens") {
      if (denied(res, "admin")) return;
      if (refusedRemoteCredential(req, res)) return;
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
      // Shape is not enough: `["reed"]` would produce a credential that authenticates and then 403s on
      // everything, indistinguishable from a working one until used. The parser that decides what a
      // scope MEANS is the right thing to ask what one IS, and the CLI asks it too (`yoke token create`).
      const unparsed = cleanScopes.filter((raw) => parseScope(raw) === null);
      if (unparsed.length > 0 || cleanScopes.length === 0) {
        sendJson(res, 400, {
          error:
            cleanScopes.length === 0
              ? "scopes is empty: a credential with no scope can do nothing"
              : `not a scope: ${unparsed.join(", ")} — scope is action | namespace:action | namespace:type:action`,
          ...(unparsed.length > 0 ? { scopes: unparsed } : {}),
        });
        return;
      }
      // Every scope has to be one this caller could grant. Without it, `admin` on one namespace mints a
      // wildcard credential and the boundary the rest of this server enforces is gone in two steps
      // instead of one.
      const outOfReach = grantable(cleanScopes);
      if (outOfReach.length > 0) {
        sendJson(res, 403, {
          error:
            `forbidden: this credential cannot grant ${outOfReach.join(", ")}` +
            " — an admin scoped to a namespace grants only within it",
          required: "admin",
          scopes: outOfReach,
        });
        return;
      }
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
      if (denied(res, "admin")) return;
      if (refusedRemoteCredential(req, res)) return;
      const name = decodeURIComponent(path.slice("/api/tokens/".length));
      if (!name) {
        sendJson(res, 400, { error: "token name is required" });
        return;
      }
      // Out of reach reads as absent, for the same reason a foreign record does: "exists, but not
      // yours" lets one tenant enumerate another's credentials by name.
      const target = store.listTokens().find((t) => t.name === name);
      if (target && grantable(target.scopes).length > 0) {
        sendJson(res, 404, { error: `no such token: ${name}` });
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
      if (denied(res, "read")) return;
      const id = decodeURIComponent(path.slice("/api/persona/".length));
      const ts = now();
      // Core refuses an anchor that is not a person, so the screen 404s rather than rendering a persona
      // about a fact — an empty document is what an id typed into the URL would otherwise give.
      let result: PersonaResult;
      try {
        result = await personaQuery(store, store.loadOntology(ns), id, ts, {
          ns,
        });
      } catch (e) {
        if (e instanceof NotAPerson) {
          sendJson(res, 404, { error: e.message });
          return;
        }
        throw e;
      }
      // A persona read IS an injection — same knowledge, same citations — so it leaves the same
      // trail as its MCP twin. ENTERPRISE.md's audit target is "who got what knowledge injected",
      // and a read path that answers with attributes but writes no row makes that claim false.
      const injected = [...result.decisions, ...result.facts].map(
        (i) => i.entity,
      );
      // Best-effort (C7): the persona is already computed, so a locked trail drops the row to stderr
      // rather than 400 an answer — inline `logAudit` would let a held write lock turn a read into a
      // failure.
      bestEffortAudit({
        actor,
        action: "persona",
        detail: `${id} -> ${injected.map((e) => e.id).join(" ")}`,
        at: ts,
        ns,
      });
      const { asR, prefetch, nameOf } = serializers();
      // The author-aware citation, author id, and contradiction marker travel with the row, exactly as
      // on the inject preview. row() names the PROMOTER; on a persona — every row authored by the one
      // person on screen — that renders each of their records cited to whoever verified it, not to them.
      // Core built the right citation (i.citation) and knows the author (i.author); both are handed over.
      const rows = async (list: typeof result.decisions) =>
        Promise.all(
          list.map(async (i) => {
            const r = await asR(i.entity);
            const authorName = i.author ? await nameOf(i.author) : undefined;
            return {
              ...r,
              citation: i.citation,
              ...(i.author ? { author: i.author } : {}),
              ...(authorName === undefined ? {} : { authorName }),
              ...(i.conflictsWith ? { conflictsWith: i.conflictsWith } : {}),
            };
          }),
        );
      sendJson(res, 200, {
        // What matched this person and could NOT be injected, and the identities this persona unioned
        // — both carried like the inject preview and the SKILL.md do (W-PERSONA-ENVELOPE). Without
        // them "everything in review" and "nothing on record" are byte-identical here, and a same_as
        // identity merge is applied with no disclosure. Absent when there is nothing to say.
        ...(result.withheld ? { withheld: result.withheld } : {}),
        ...(result.identities ? { identities: result.identities } : {}),
        ...(await (async () => {
          await prefetch(injected);
          return {
            decisions: await rows(result.decisions),
            facts: await rows(result.facts),
          };
        })()),
      });
      return;
    }

    if (
      method === "POST" &&
      (path === "/api/verify" || path === "/api/deprecate")
    ) {
      const action = path === "/api/verify" ? "verify" : "deprecate";
      // Both verify and deprecate are governance actions → gated on the verify permission.
      if (denied(res, "verify")) return;
      const { ids, reason } = await readIds(req);
      const ts = now();
      const fn = action === "verify" ? verify : deprecate;
      // The caller's namespace, so a governance act cannot reach another tenant's record — every READ
      // route on this server filters ns, and this one must too (see core/lifecycle's transition).
      const done = await fn(store, ids, actor, ts, ns);
      // Governance action audit — who verified/deprecated what, when (same tier as CLI inject audit),
      // and for a deprecate, WHY: the record's own screen reads it back, because a retired record
      // otherwise raises a question it cannot answer.
      store.logAudit({
        actor,
        action,
        detail: done.map((e) => e.id).join(" "),
        at: ts,
        ns,
        note: action === "deprecate" ? reason : undefined,
      });
      if (action === "verify") {
        sendJson(res, 200, await rowsOf(done));
        return;
      }
      // Deprecating names what rests on it (v5.8) — the same answer `yoke deprecate` prints, because
      // this screen is the governance workbench and cannot be the weaker surface for its own job.
      // Rows, not ids: the notice is meant to be clicked through.
      sendJson(res, 200, {
        deprecated: await rowsOf(done),
        downstream: await rowsOf(
          await downstreamOf(
            store,
            done.map((e) => e.id),
            ns,
          ),
        ),
      });
      return;
    }

    // Creating a record, and linking two of them. WEB-UI.md test 3 permits it:
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
      if (denied(res, "write", type)) return;
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
          const { entity, existed } = await commit(
            store,
            ontology,
            { type, attributes, from, to },
            prov,
            ts,
            { ns },
          );
          // 200, not 201, when the edge was already there: nothing was created, and a screen that
          // said "linked" would be reporting a change it did not cause. The row is the same either
          // way, so `existed` is what tells the caller which of the two happened.
          sendJson(res, existed ? 200 : 201, {
            ...(await asRelRow()(entity as Relation)),
            existed: existed ?? false,
          });
          return;
        }
        const { entity, duplicates, duplicateDetection, unrecorded } =
          await commit(store, ontology, { type, attributes }, prov, ts, {
            embedder: deps.embedder,
            ns,
            // Capture-side linking, the same act `yoke add --scope` makes — so the browser path and
            // the CLI path attach knowledge to a collaboration identically, and a bad scope refuses
            // the whole write here too rather than leaving a record the caller was told was rejected.
            ...(typeof body.scope === "string" && body.scope
              ? { attachTo: body.scope }
              : {}),
          });
        // Duplicates travel with the response: the gate found them, and a form that discards them
        // is a form that helps someone create the thing they were warned about.
        //
        // So does WHY the list is empty. "no duplicates found" and "nobody looked" are different
        // facts, and only the gate knows which one happened (SPEC gate stage 3) — a form that shows
        // neither lets someone believe their record was checked when it was not.
        sendJson(res, 201, {
          ...(await asRow()(entity)),
          duplicates: await rowsOf(duplicates),
          duplicateDetection,
          // Durable record, partial commit — the screen must not render an unqualified success.
          ...(unrecorded ? { unrecorded } : {}),
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
      if (denied(res, "verify")) return;
      const def = (await readBody(req)).def;
      // attrs defaulted, not overridden: a type with no attributes is legitimate (the seed's `term`
      // and `resource` both are), and the CLI's JSON-file path allows omitting the key.
      const incoming = (def ?? {}) as TypeDef;
      const typeDef: TypeDef = { ...incoming, attrs: incoming.attrs ?? {} };
      // The same validator the CLI uses. Name and kind are not enough — `ttl_days: "soon"` would return
      // 201 and then withhold every record of that type from injection forever (see `validateTypeDef`
      // for the full list).
      const bad = validateTypeDef(typeDef);
      if (bad) {
        sendJson(res, 400, { error: bad });
        return;
      }
      // Same call as the CLI, not the same logic re-typed — see `refuseKindChange`, which counts both
      // tables so a relation type being flipped does not slip past.
      const kindRefusal = await refuseKindChange(store, typeDef, ns);
      if (kindRefusal) {
        sendJson(res, 409, { error: kindRefusal });
        return;
      }
      await store.saveOntology([typeDef], ns);
      sendJson(res, 201, typeDef);
      return;
    }

    // Repair: re-derive authorship edges for records committed before the gate made them. Gated on
    // `write` because that is what it produces — edges, through the same gate, attributed to each
    // record's recorded author rather than to whoever pressed the button.
    if (method === "POST" && path === "/api/backfill") {
      if (denied(res, "write")) return;
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
      if (denied(res, "verify")) return;
      const body = await readBody(req);
      const { from, to } = body;
      if (typeof from !== "string" || typeof to !== "string" || !from || !to) {
        sendJson(res, 400, { error: "from and to are required" });
        return;
      }
      // Kept as a 400 ahead of the refusals below: renaming a name to itself is a malformed request,
      // not a conflict with the database's state.
      if (from === to) {
        sendJson(res, 400, { error: "from and to are the same name" });
        return;
      }
      // The same refusals the CLI applies — literally the same call (`refuseRename`). Evidence
      // gathered per caller drifts per caller, so it is gathered in one place.
      const refusal = await refuseRename(store, from, to, ns);
      if (refusal) {
        sendJson(res, 409, { error: refusal });
        return;
      }
      // A typo'd source name is a 404, not a success with rows: 0 — "renamed nosuch to other — 0 rows
      // rewritten" is a success sentence for a no-op (the CLI refuses it too).
      if (!store.loadOntology(ns).some((t) => t.name === from)) {
        sendJson(res, 404, {
          error: `no type named ${from} in this namespace`,
        });
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
 * `0.0.0.0`, which would make an ungated workbench reachable by anyone on the same network. Widening
 * is an explicit `--host`. */
export const DEFAULT_HOST = "127.0.0.1";

/**
 * Whether a CONNECTED PEER is this machine. Separate from `isLoopback`, which asks about a bind
 * address, because the string arrives in a different shape: a dual-stack listener reports a loopback
 * peer as the IPv4-mapped `::ffff:127.0.0.1`, and treating that as remote would refuse the host its own
 * credential routes. An absent address (a socket already gone) counts as remote — the safe default.
 */
export function isLoopbackPeer(addr: string | undefined): boolean {
  if (!addr) return false;
  return isLoopback(addr.replace(/^::ffff:/, ""));
}

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
  // `yoke ui` has no authentication at all, so a non-loopback bind is a decision, not a detail. It is
  // allowed (a container cannot port-forward to a loopback-bound process) but never quiet: the same
  // routes read, create, retire and rename this database's knowledge and rewrite its history.
  // Credential issuing is the one thing refused outright to a remote caller here (see
  // `refusedRemoteCredential`), because a token minted this way works against a hardened `serve --auth`
  // process on the same database — an exposure that escapes the server the operator chose to expose.
  if (!isLoopback(host))
    process.stderr.write(
      `yoke ui: bound to ${host} with NO authentication — anyone who can reach this port can read,\n` +
        `  create, retire and rename this database's knowledge. Issuing credentials is refused to\n` +
        `  non-loopback callers; everything else is not. Use 'yoke serve --auth --host ${host}' to\n` +
        `  expose it safely.\n`,
    );
  console.log(`yoke ui listening: http://${host}:${bound}`);
  return server;
}
