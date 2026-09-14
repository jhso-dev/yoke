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

import { existsSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { resolve } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { commit } from "../../core/commit.js";
import {
  type Embedder,
  makeFetchEmbedder,
  resolveEmbedConfig,
  suppressEmbedAnnounce,
} from "../../core/embedding.js";
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
  /** Built web bundle directory, passed through to the UI handler (injectable for tests). */
  webRoot?: string | null;
  /** GitHub credential exchange (SPEC "GitHub exchange"). Absent = the login route does not exist.
   * `org` membership IS the access decision — a member's minted token carries read,write, the whole
   * knowledge permission; `api` points at GHE or a test double. */
  github?: { org: string; api: string };
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

export function createServeServer(deps: ServeDeps): Server {
  const store = deps.store;
  const { defaultActor, auth, embedder, storePath } = deps;
  // The server's own namespace. A request may narrow it only when nothing authenticates it.
  const serverNs = deps.ns ?? null;
  const now = deps.now ?? (() => new Date().toISOString());
  const oidcVerify = deps.oidc ? makeOidcVerifier(deps.oidc) : null;
  const signer = credentialSigner(deps.tokenSecret);

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
    })(req, res);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) {
        res.writeHead(400, {
          "content-type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify({ error: (e as Error).message }));
      } else res.end();
    });
  });

  return server;
}

/** The recommended local model, and why it is this one: `bge-m3` covers 100+ languages in one
 * 1024-dimension model (MIT, 8192-token context) and lives in Ollama's shared cache — 0 bytes in
 * this package, which is why no model ships with yoke (SPEC "Tech stack"). An English-centric model
 * (e.g. `nomic-embed-text`) makes the vector half of retrieval useless on a corpus with substantial
 * non-English knowledge — indistinguishable from no embedder. */
const SUGGESTED_EMBED_MODEL = "bge-m3";

/** The state of retrieval on THIS server, said once at boot: a keyword-only deployment is otherwise
 * indistinguishable from a working one until someone notices the answers are worse. Resolved by the
 * same function every later read embeds through, so the two cannot disagree. Never blocks (the
 * resolver is bounded) and never fails the boot. */
async function announceEmbedder(env: Env): Promise<void> {
  const cfg = await resolveEmbedConfig(env);
  // Pinned by env: the operator already knows, and repeating their own configuration is noise.
  if (cfg && !cfg.auto) return;
  // Silence the one-shot runtime notice: this has just said the same thing, more fully.
  suppressEmbedAnnounce();
  console.log(
    cfg
      ? `embeddings on — using ${cfg.model} at ${cfg.url} (no configuration needed; ` +
          "set YOKE_EMBED_URL/MODEL to pin a different provider)"
      : "no embedding provider — retrieval will be keyword-only and duplicate/contradiction " +
          `detection is skipped. Run 'ollama pull ${SUGGESTED_EMBED_MODEL}' (it is then used ` +
          "automatically), or set YOKE_EMBED_URL and YOKE_EMBED_MODEL",
  );
}

/** Open the DB, resolve auth/OIDC/actor/ns from env, start listening. Returns the running server. */
export async function runServe(
  db: string,
  port: number,
  env: Env,
  opts: {
    auth?: boolean;
    ns?: string | null;
    /** Sharded composite storage (ENTERPRISE "sharding"). */
    shards?: string;
    /** Bind address. Defaults to loopback — widening is explicit, and requires auth. */
    host?: string;
    /** Print one admin credential at boot. The chicken-and-egg of a gated server with no external
     * issuer: minting goes through POST /api/tokens, which needs an admin credential that nothing
     * has yet. The operator who holds the signing key runs this once and mints the rest through the
     * route. Printed to stdout, so it is the operator's to capture — not written anywhere. */
    bootstrapAdmin?: boolean;
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

  // A fresh store is created and seeded here, not by a command a person runs first. `serve --db
  // ./yok.db` on a typo therefore starts on a new empty corpus — which is why it says so.
  const fresh =
    !opts.shards && !env.YOKE_SHARDS && !remoteBackend(env) && !existsSync(db);
  const store = await openStore({ db, shards: opts.shards }, env);
  if (fresh) console.log(`store created: ${resolve(db)}`);

  const server = createServeServer({ ...common, store });
  server.on("close", () => store.close());
  await listen(server, port, host);
  const addr = server.address();
  const bound = typeof addr === "object" && addr ? addr.port : port;
  console.log(
    `yoke serve listening: http://${host}:${bound}  (auth ${auth ? "on" : "off"}, MCP at POST /mcp)`,
  );
  await announceEmbedder(env);
  if (opts.bootstrapAdmin) {
    const signer = credentialSigner(env.YOKE_TOKEN_SECRET);
    if (!signer)
      throw new Error(
        "--bootstrap-admin needs YOKE_TOKEN_SECRET: the credential it prints is signed with it",
      );
    const { token } = await signer.mint({
      name: "bootstrap",
      scopes: ["admin", "read", "write"],
      ns: common.ns,
    });
    console.log(
      `bootstrap admin credential (expires in 7 days — mint the rest with 'yoke token create'):\n${token}`,
    );
  }
  return server;
}
