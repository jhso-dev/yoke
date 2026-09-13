// yoke serve (ENTERPRISE "server mode") — ONE node:http server (NO express) combining, on a single port:
//   (a) the UI + JSON API — reuses createUiHandler verbatim (no route duplication);
//   (b) a remote MCP endpoint at POST /mcp — the SDK's StreamableHTTPServerTransport in stateless
//       mode, reusing createYokeMcpServer.
// stdio `yoke mcp` and local `yoke ui` are untouched and stay ungated (single-user mode).
//
// Auth (ENTERPRISE "auth") + RBAC (ENTERPRISE "RBAC") apply ONLY here, and only when enabled (YOKE_AUTH=on
// or --auth). Then every /api/* and /mcp request needs a Bearer credential: an API token or an
// OIDC RS256 JWT. Deny-by-default authorization is threaded into both the UI handler and the MCP
// server via their `authorize` hooks.

import { existsSync, rmSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Database from "better-sqlite3";
import { SqliteStorage } from "../../adapters/storage-sqlite/index.js";
import { commit } from "../../core/commit.js";
import { type Embedder, makeFetchEmbedder } from "../../core/embedding.js";
import { resolveNs } from "../../core/namespace.js";

/** A backend that lives somewhere other than this machine's filesystem. */
const remoteBackend = (env: Env): boolean =>
  !!(env.YOKE_OPENSEARCH_URL || env.YOKE_POSTGRES_URL);

import { createYokeMcpServer } from "../mcp/index.js";
import { openStore, type YokeStore } from "../store.js";
import {
  createUiHandler,
  DEFAULT_HOST,
  isLoopback,
  listen,
  readJsonBody,
} from "../ui/server.js";
import {
  type Credential,
  type Credentials,
  credentialSigner,
} from "./credential.js";
import {
  makeOidcVerifier,
  type OidcConfig,
  type OidcSubject,
  oidcFromEnv,
} from "./oidc.js";
import { type Action, allowed, ungrantable } from "./rbac.js";

type Env = Record<string, string | undefined>;

/**
 * How often a replica re-pulls the primary. A full `.backup()` disk copy per tick, so it is a fixed
 * constant rather than an operator knob: the interval is the replica's staleness AND its IO cost, and
 * nothing that reaches this file may make it small. Make it configurable only with a value someone
 * actually needs, and validate it where it enters.
 */
const REFRESH_MS = 30_000;

interface ServeDeps {
  store: YokeStore;
  /** The absolute path of the store this server holds, when it holds one file. A client that reached
   * a DEFAULT address states what it expected and gets a 409 when the two differ — see the check in
   * `handle`. Absent for a remote or sharded backend, where a caller has no local path to expect. */
  storePath?: string;
  /** Actor used when auth is off, and audit fallback. */
  defaultActor: string;
  ns?: string | null;
  now?: () => string;
  /** Gate /api/* and /mcp behind Bearer auth. Off = single-user (ungated), same UX as `yoke ui`. */
  auth: boolean;
  /** OIDC config (from env). Omitted = only yoke's own credentials can authenticate. */
  oidc?: OidcConfig;
  /** Signing key for yoke's own credentials (YOKE_TOKEN_SECRET). Absent = this server mints none,
   * and only OIDC can authenticate — there is no unsigned fallback, because a default key is a
   * credential anyone who read the source could mint. */
  tokenSecret?: string;
  embedder?: Embedder;
  /** Read-only replica mode (BACKENDS "read replicas"): deny every mutation regardless of scopes. Mutating
   * API endpoints answer 409; MCP write tools get a tool error via the authorize hook. */
  readOnly?: boolean;
  /** Interval-pull snapshot config (11.2). When set, the store is re-copied from the primary via
   * `.backup()` every REFRESH_MS and exposes refreshNow() on the returned server for manual pulls. */
  replica?: { primaryPath: string; snapshotPath: string };
  /** Built web bundle directory, passed through to the UI handler (injectable for tests). */
  webRoot?: string | null;
  /** GitHub credential exchange (SPEC "GitHub exchange"). Absent = the login route does not exist.
   * `org` membership IS the access decision — a member's minted token carries read,write, the whole
   * knowledge permission; `api` points at GHE or a test double. */
  github?: { org: string; api: string };
}

/** Server augmented with refreshNow() when running as a replica (11.2). */
interface ServeServer extends Server {
  refreshNow?(): Promise<void>;
}

interface Principal {
  actor: string;
  scopes: string[];
}

type Authorize = (action: Action, type?: string) => boolean;

const ALLOW_ALL: Authorize = () => true;

/** Extract the raw Bearer credential, or null. */
function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

export function createServeServer(deps: ServeDeps): ServeServer {
  // store is a `let`: replica mode swaps it out on each snapshot pull (see refreshNow). All the
  // closures below read the current `store` at call time, so the swap is transparent to them.
  let store = deps.store;
  const { defaultActor, auth, embedder, readOnly, storePath } = deps;
  // The server's own namespace. A request may narrow it only when nothing authenticates it.
  const serverNs = deps.ns ?? null;
  const now = deps.now ?? (() => new Date().toISOString());
  const oidcVerify = deps.oidc ? makeOidcVerifier(deps.oidc) : null;
  const signer = credentialSigner(deps.tokenSecret);

  // ceiling: interval-pull snapshot replica — refresh = close store, re-copy primary via .backup(),
  // reopen. A tiny swap window; move to WAL shipping if a staleness SLO ever demands it. better-sqlite3
  // has no "backup into an open connection", so close/reopen is the lazy WAL-safe path with no new dep.
  async function refreshNow(): Promise<void> {
    const rep = deps.replica;
    if (!rep) return;
    store.close();
    for (const suffix of ["-wal", "-shm"]) {
      try {
        rmSync(rep.snapshotPath + suffix);
      } catch {
        // no stale WAL sidecar — fine.
      }
    }
    const primary = new Database(rep.primaryPath, { readonly: true });
    try {
      await primary.backup(rep.snapshotPath);
    } finally {
      primary.close();
    }
    store = new SqliteStorage(rep.snapshotPath);
    await store.init();
  }

  // Auto-provision a person for an OIDC subject on first sight — through the commit gate, exactly
  // like `yoke init` seeds yoke:system. The id is a stable opaque string we own (`oidc:<sub>`).
  async function provisionPerson(id: string, name: string): Promise<void> {
    if (await store.getEntity(id)) return;
    const ts = now();
    await commit(
      store,
      store.loadOntology(serverNs),
      { type: "person", attributes: { name } },
      { actor: id, origin: "oidc", occurred_at: ts },
      ts,
      { existingId: id, ns: serverNs },
    );
  }

  async function authenticate(cred: string): Promise<Principal | null> {
    // yoke's own credential first, then an OIDC one. Both are verified against a key and neither
    // reads storage, which is what lets any number of instances answer the same token the same way.
    const own = await signer?.verifyAccess(cred);
    if (own) return { actor: `token:${own.name}`, scopes: own.scopes };
    if (oidcVerify) {
      const sub: OidcSubject | null = await oidcVerify(cred);
      if (sub) {
        const id = `oidc:${sub.subject}`;
        await provisionPerson(id, sub.subject);
        // A verified identity is a VIEWER by default. write is the knowledge permission — what
        // enters under it is live to every agent on the scope — so it comes only from an explicit
        // grant (an IdP claim, or the GitHub exchange, where org membership is that grant), never
        // from the mere fact of holding an SSO account.
        // The IdP already owns identity, so it owns role too: a `scope`/`scopes` claim carrying
        // yoke scopes is honoured (validated and confined to the ns claim, see claimedScopes).
        const scopes = sub.scopes.length
          ? sub.scopes
          : [sub.ns ? `${sub.ns}:read` : "read"];
        return { actor: id, scopes };
      }
    }
    return null;
  }

  async function handleMcp(
    req: IncomingMessage,
    res: ServerResponse,
    actor: string,
    authorize: Authorize,
    ns: string | null,
  ): Promise<void> {
    const body = await readJsonBody(req);
    const mcp = createYokeMcpServer({
      store,
      ontology: store.loadOntology(ns),
      defaultActor: actor,
      ns,
      embedder,
      authorize,
    });
    // Stateless: no session id, a fresh server+transport per request (StreamableHTTP spec).
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close();
      mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    // Read-only replica (11.2): mutating API endpoints are refused up front with a clear 409, no
    // credentials needed. MCP writes can't be told apart at the HTTP layer (one POST /mcp), so they
    // are denied via the authorize wrapper below (→ MCP tool error) instead.
    if (
      readOnly &&
      req.method === "POST" &&
      (path === "/api/verify" || path === "/api/deprecate")
    ) {
      res.writeHead(409, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({ error: "read-only replica; write to the primary" }),
      );
      return;
    }

    // The door (SPEC "GitHub exchange"): a GitHub identity, in for a yoke credential — so a machine
    // whose developer already runs `gh` needs no issuance ceremony at all. Reachable WITHOUT a yoke
    // credential (it is how you get one) but never open by default: it exists only under --auth AND
    // when an org is named, and membership in that org IS the access decision. The presented GitHub
    // token is spent on two lookups and discarded — never stored, never logged, never echoed; what
    // comes back is signed by this server and stored nowhere. Removing the person from the org — the
    // lever GitHub already owns — stops the NEXT exchange; a credential already minted stands until
    // it expires, which is what a signed credential costs (see credential.ts).
    if (req.method === "POST" && path === "/api/login/github") {
      const gh = deps.github;
      if (!auth || !gh) {
        // 404, not 403: a server that does not offer the exchange should not advertise it.
        res.writeHead(404, {
          "content-type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      if (readOnly) {
        res.writeHead(409, {
          "content-type": "application/json; charset=utf-8",
        });
        res.end(
          JSON.stringify({ error: "read-only replica; log in at the primary" }),
        );
        return;
      }
      const ghToken = bearer(req);
      const deny = (code: number, error: string) => {
        res.writeHead(code, {
          "content-type": "application/json; charset=utf-8",
          ...(code === 401 ? { "www-authenticate": "Bearer" } : {}),
        });
        res.end(JSON.stringify({ error }));
      };
      if (!ghToken)
        return deny(401, "send a GitHub token as the Bearer credential");
      const ask = async (p: string) => {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 5000);
        try {
          return await fetch(`${gh.api}${p}`, {
            headers: {
              authorization: `Bearer ${ghToken}`,
              accept: "application/vnd.github+json",
              "user-agent": "yoke",
            },
            signal: ac.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      };
      try {
        const user = await ask("/user");
        if (!user.ok)
          return deny(401, "GitHub did not recognize the credential");
        const login = ((await user.json()) as { login?: string }).login;
        if (!login) return deny(401, "GitHub did not recognize the credential");
        const member = await ask(
          `/user/memberships/orgs/${encodeURIComponent(gh.org)}`,
        );
        const state = member.ok
          ? ((await member.json()) as { state?: string }).state
          : null;
        if (state !== "active")
          return deny(403, `not an active member of ${gh.org}`);
        const scopes = ["read", "write"];
        const name = `github:${login}`;
        if (!signer)
          return deny(
            503,
            "this server mints no credentials of its own: set YOKE_TOKEN_SECRET",
          );
        // Both halves at once. The refresh token is what keeps a browser from being sent back to a
        // login form a week later; a client that can re-run this exchange on its own (the hooks call
        // it with `gh auth token`) can ignore it.
        const { token, refresh }: Credentials = await signer.mint({
          name,
          scopes,
          ns: serverNs,
        });
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify({ token, refresh, name, login, scopes }));
      } catch {
        // GitHub unreachable (or slow past the budget) — the caller's credential may be fine, so this
        // is the upstream's failure, not an authentication verdict.
        deny(502, "cannot reach GitHub to verify the credential");
      }
      return;
    }

    /**
     * A new access token, for a client that holds a refresh one.
     *
     * The browser's whole reason for existing: a pasted credential that expired a week ago would send
     * someone back to a login form, and there is nothing for them to paste again. A client that can
     * re-run the GitHub exchange by itself does not need this route at all.
     *
     * Not gated by `authenticate` — the refresh token IS the credential here, and an expired access
     * token is exactly the state this exists to repair. Nothing is rotated: the same refresh token
     * keeps working until it expires, which is the trade credential.ts states.
     */
    if (req.method === "POST" && path === "/api/refresh") {
      const send = (code: number, body: unknown) => {
        res.writeHead(code, {
          "content-type": "application/json; charset=utf-8",
          ...(code === 401 ? { "www-authenticate": "Bearer" } : {}),
        });
        res.end(JSON.stringify(body));
      };
      if (!auth || !signer)
        return send(404, { error: "this server mints no credentials" });
      const presented = bearer(req);
      const cred: Credential | null = presented
        ? await signer.verifyRefresh(presented)
        : null;
      if (!cred)
        return send(401, {
          error: "send a valid refresh token as the Bearer credential",
        });
      const minted = await signer.mint(cred);
      return send(200, {
        token: minted.token,
        refresh: minted.refresh,
        name: cred.name,
        scopes: cred.scopes,
      });
    }

    // /api/meta is the one API route that must answer without a credential: it is how the browser
    // learns a credential is needed, and a static export has no middleware to tell it. It is
    // authenticated OPTIONALLY — a valid Bearer gets the real principal, none gets deny-all — so it
    // still cannot be used to read actor or namespace anonymously.
    const optional = path === "/api/meta";
    const gated =
      auth && (path === "/mcp" || path.startsWith("/api/")) && !optional;

    // Who the caller is, and which tenant they are in.
    //
    // UNGATED (invariant 4): the client says. `yoke add --actor alice --ns team-a` has to mean what
    // it says against a loopback server, and there is no credential to contradict it — a single-user
    // deployment that could not record who wrote a record would have lost the point of recording it.
    // GATED: the credential says, and these headers are ignored entirely, which is what makes
    // `--actor` unable to forge authorship on a shared corpus.
    const header = (name: string): string | undefined => {
      const raw = req.headers[name];
      const one = Array.isArray(raw) ? raw[0] : raw;
      return one?.trim() ? one.trim() : undefined;
    };
    // The caller reached a DEFAULT address and named the store they meant. One port serves every
    // project on a machine, so "the server on 4800" and "the server for this store" are not the same
    // thing — and the difference, undetected, is a write filed in someone else's corpus. Refused
    // here, before the body is read, so nothing is written on the way to finding out.
    const expected = header("x-yoke-store");
    if (expected !== undefined && expected !== storePath) {
      res.writeHead(409, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          error:
            `this server holds ${storePath}, not ${expected} — it is another project's. ` +
            `Start one for yours ('yoke serve --db ${expected} --port <other>'), or set ` +
            "YOKE_SERVER to the address of the one you mean",
        }),
      );
      return;
    }

    let actor = (!auth && header("x-yoke-actor")) || defaultActor;
    const ns = auth ? serverNs : (header("x-yoke-ns") ?? serverNs);
    let authorize: Authorize = ALLOW_ALL;
    // What this caller may put INTO a credential. Empty on the ungated path: no principal, nothing out
    // of reach (invariant 4). Under auth it is the principal's admin reach — see `ungrantable`.
    let grantable: (wanted: string[]) => string[] = () => [];
    if (gated || (auth && optional)) {
      const cred = bearer(req);
      const principal = cred ? await authenticate(cred) : null;
      if (!principal && !optional) {
        res.writeHead(401, {
          "content-type": "application/json; charset=utf-8",
          "www-authenticate": "Bearer",
        });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (principal) {
        actor = principal.actor;
        authorize = (action, type) =>
          allowed(principal.scopes, ns, type, action);
        const scopes = principal.scopes;
        grantable = (wanted) => ungrantable(scopes, wanted);
      } else {
        authorize = () => false; // optional route, no credential — reveal nothing
        grantable = (wanted) => wanted; // and grant nothing
      }
    }
    // Replica: deny every mutation regardless of scopes (wraps whatever base authorize resolved above).
    // `admin` is a mutation too — issuing a credential on a replica writes to the replica's own token
    // table, and the primary would never see it.
    if (readOnly) {
      const base = authorize;
      authorize = (action, type) => action === "read" && base(action, type);
    }

    if (path === "/mcp") {
      await handleMcp(req, res, actor, authorize, ns);
      return;
    }
    // Everything else (UI shell + JSON API) goes through the exact same routes as `yoke ui`.
    await createUiHandler({
      store,
      actor,
      ns,
      now,
      // The same embedder the MCP path above gets. Without it every write through the JSON API skips
      // the gate's duplicate and contradiction stages, and every read is keyword-only — a team server
      // would be the one deployment where the vector half of retrieval silently does not exist.
      embedder,
      authorize,
      grantable,
      tokenSecret: deps.tokenSecret,
      webRoot: deps.webRoot,
      authRequired: auth,
      readOnly,
    })(req, res);
  }

  const server: ServeServer = createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) {
        res.writeHead(400, {
          "content-type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify({ error: (e as Error).message }));
      } else res.end();
    });
  });

  if (deps.replica) {
    server.refreshNow = refreshNow;
    const timer = setInterval(() => {
      refreshNow().catch(() => {
        // A failed pull keeps serving the last good snapshot; next tick retries.
      });
    }, REFRESH_MS);
    timer.unref(); // never keep the process alive for the refresh timer alone
    server.on("close", () => {
      clearInterval(timer);
      store.close();
    });
  }

  return server;
}

/** Open the DB, resolve auth/OIDC/actor/ns from env, start listening. Returns the running server.
 * With `replicaOf` (11.2): serve a read-only local snapshot pulled from the primary on an interval. */
export async function runServe(
  db: string,
  port: number,
  env: Env,
  opts: {
    auth?: boolean;
    ns?: string | null;
    replicaOf?: string;
    /** Sharded composite storage (ENTERPRISE "sharding"). Ignored in replica mode (per-file snapshot). */
    shards?: string;
    /** Bind address. Defaults to loopback — widening is explicit, and requires auth. */
    host?: string;
  } = {},
): Promise<Server> {
  const auth = opts.auth || env.YOKE_AUTH === "on";
  const host = opts.host ?? DEFAULT_HOST;
  // serve CAN authenticate, so there is no reason to ever expose it unauthenticated. Refuse rather
  // than warn: the whole point of binding wide is that other people can reach it.
  if (!isLoopback(host) && !auth)
    throw new Error(
      // The remedy has to RUN and has to be safe: name a --name, and scope to a namespace rather than
      // the wildcard-ns `read` that would read every tenant.
      `refusing to bind ${host} without authentication — add --auth (or YOKE_AUTH=on). ` +
        `People then log in with the GitHub identity they already have (set YOKE_GITHUB_ORG; ` +
        `SPEC "GitHub exchange"); a machine actor gets ` +
        `'yoke token create --name <who> --scopes "${opts.ns ?? resolveNs(undefined, env) ?? "<namespace>"}:read"'`,
    );
  // A store that was never `yoke init`ed is almost always a typo'd path: `serve --db ./yok.db` would
  // otherwise start happily on an empty corpus and every client would read "nothing" from a database
  // nobody meant to make. The check runs BEFORE openStore, which CREATES the sqlite file — refusing
  // after opening leaves the stray database behind, which is half the defect. Only the local
  // single-file path is judged by file existence; a sharded or remote store initializes elsewhere.
  if (
    !opts.shards &&
    !env.YOKE_SHARDS &&
    !remoteBackend(env) &&
    !existsSync(db)
  )
    throw new Error(
      `not initialized: ${db} — run 'yoke init --db ${db}' first`,
    );

  // A gated server has to be able to recognise somebody. Without a signing key it mints nothing, so
  // unless an external issuer is configured every request would 401 and the cause would be invisible.
  if (auth && !env.YOKE_TOKEN_SECRET && !oidcFromEnv(env))
    throw new Error(
      "--auth needs a way to recognise a credential: set YOKE_TOKEN_SECRET (any high-entropy " +
        "string, the same one on every instance) so this server can sign its own, or configure " +
        "YOKE_OIDC_ISSUER/YOKE_OIDC_AUDIENCE to accept your identity provider's.",
    );
  const common = {
    // Only a single local file has a path a caller can expect; a remote or sharded backend does not,
    // and a client pointed at one of those set YOKE_SERVER and is not guessing.
    storePath:
      opts.shards || env.YOKE_SHARDS || remoteBackend(env)
        ? undefined
        : resolve(db),
    defaultActor: env.YOKE_ACTOR ?? "yoke:system",
    ns: opts.ns ?? resolveNs(undefined, env),
    auth,
    oidc: oidcFromEnv(env) ?? undefined,
    tokenSecret: env.YOKE_TOKEN_SECRET,
    // YOKE_GITHUB_ORG turns the exchange on; a GHE api base rides along.
    github: env.YOKE_GITHUB_ORG
      ? {
          org: env.YOKE_GITHUB_ORG,
          api: env.YOKE_GITHUB_API ?? "https://api.github.com",
        }
      : undefined,
    embedder: makeFetchEmbedder(env),
  };

  let store: YokeStore;
  let replica: ServeDeps["replica"];
  let readOnly = false;
  if (opts.replicaOf) {
    // Initial pull: copy the primary into a local snapshot, then serve reads from it.
    const snapshotPath = join(tmpdir(), `yoke-replica-${process.pid}.db`);
    const primary = new Database(opts.replicaOf, { readonly: true });
    try {
      await primary.backup(snapshotPath);
    } finally {
      primary.close();
    }
    store = new SqliteStorage(snapshotPath);
    await store.init();
    replica = { primaryPath: opts.replicaOf, snapshotPath };
    readOnly = true;
  } else {
    store = await openStore({ db, shards: opts.shards }, env);
    await store.init();
  }

  const server = createServeServer({ ...common, store, readOnly, replica });
  // Replica owns its own store lifecycle (it swaps stores on refresh) — see createServeServer.
  if (!replica) server.on("close", () => store.close());
  await listen(server, port, host);
  const addr = server.address();
  const bound = typeof addr === "object" && addr ? addr.port : port;
  console.log(
    `yoke serve listening: http://${host}:${bound}  (auth ${auth ? "on" : "off"}, MCP at POST /mcp${replica ? `, read-only replica of ${opts.replicaOf}` : ""})`,
  );
  return server;
}
