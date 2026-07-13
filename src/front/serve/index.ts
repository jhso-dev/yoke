// yoke serve (PLAN-V2 10.2) — ONE node:http server (NO express) combining, on a single port:
//   (a) the UI + JSON API — reuses createUiHandler verbatim (no route duplication);
//   (b) a remote MCP endpoint at POST /mcp — the SDK's StreamableHTTPServerTransport in stateless
//       mode, reusing createYokeMcpServer.
// stdio `yoke mcp` and local `yoke ui` are untouched and stay ungated (single-user mode).
//
// Auth (PLAN-V2 10.3) + RBAC (PLAN-V2 10.4) apply ONLY here, and only when enabled (YOKE_AUTH=on
// or --auth). Then every /api/* and /mcp request needs a Bearer credential: an API token or an
// OIDC RS256 JWT. Deny-by-default authorization is threaded into both the UI handler and the MCP
// server via their `authorize` hooks.

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SqliteStorage } from "../../adapters/storage-sqlite/index.js";
import { commit } from "../../core/commit.js";
import { type Embedder, makeFetchEmbedder } from "../../core/embedding.js";
import { verify } from "../../core/lifecycle.js";
import { resolveNs } from "../../core/namespace.js";
import { createYokeMcpServer } from "../mcp/index.js";
import { createUiHandler } from "../ui/server.js";
import {
  makeOidcVerifier,
  type OidcConfig,
  type OidcSubject,
  oidcFromEnv,
} from "./oidc.js";
import { type Action, allowed } from "./rbac.js";

type Env = Record<string, string | undefined>;

export interface ServeDeps {
  store: SqliteStorage;
  /** Actor used when auth is off, and audit fallback. */
  defaultActor: string;
  ns?: string | null;
  now?: () => string;
  /** Gate /api/* and /mcp behind Bearer auth. Off = single-user (ungated), same UX as `yoke ui`. */
  auth: boolean;
  /** OIDC config (from env). Omitted = only API tokens can authenticate. */
  oidc?: OidcConfig;
  embedder?: Embedder;
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

/** Read and JSON-parse the request body (undefined when empty) — MCP handleRequest wants it pre-parsed. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

export function createServeServer(deps: ServeDeps): Server {
  const { store, defaultActor, auth, embedder } = deps;
  const ns = deps.ns ?? null;
  const now = deps.now ?? (() => new Date().toISOString());
  const oidcVerify = deps.oidc ? makeOidcVerifier(deps.oidc) : null;

  // Auto-provision a person for an OIDC subject on first sight — through the commit gate + verify,
  // exactly like `yoke init` seeds yoke:system. The id is a stable opaque string we own (`oidc:<sub>`).
  async function provisionPerson(id: string, name: string): Promise<void> {
    if (await store.getEntity(id)) return;
    const ts = now();
    await commit(
      store,
      store.loadOntology(ns),
      { type: "person", attributes: { name } },
      { actor: id, origin: "oidc", occurred_at: ts },
      ts,
      { existingId: id, ns },
    );
    await verify(store, [id], id, ts);
  }

  async function authenticate(cred: string): Promise<Principal | null> {
    // API token first (a plain secret, no dots). Then OIDC JWT.
    const tok = store.verifyToken(cred);
    if (tok) return { actor: `token:${tok.name}`, scopes: tok.scopes };
    if (oidcVerify) {
      const sub: OidcSubject | null = await oidcVerify(cred);
      if (sub) {
        const id = `oidc:${sub.subject}`;
        await provisionPerson(id, sub.subject);
        // OIDC humans get read+write+verify on their ns claim (or all-ns when unclaimed).
        // ponytail: coarse — the JWT grants the full governance triple, not per-type scopes.
        // Upgrade to claim-driven fine-grained scopes when an IdP actually carries them.
        const scopes = sub.ns
          ? [`${sub.ns}:read`, `${sub.ns}:write`, `${sub.ns}:verify`]
          : ["read", "write", "verify"];
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
    const gated = auth && (path === "/mcp" || path.startsWith("/api/"));

    let actor = defaultActor;
    let authorize: Authorize = ALLOW_ALL;
    if (gated) {
      const cred = bearer(req);
      const principal = cred ? await authenticate(cred) : null;
      if (!principal) {
        res.writeHead(401, {
          "content-type": "application/json; charset=utf-8",
          "www-authenticate": "Bearer",
        });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      actor = principal.actor;
      authorize = (action, type) => allowed(principal.scopes, ns, type, action);
    }

    if (path === "/mcp") {
      await handleMcp(req, res, actor, authorize);
      return;
    }
    // Everything else (UI shell + JSON API) goes through the exact same routes as `yoke ui`.
    await createUiHandler({ store, actor, ns, now, authorize })(req, res);
  }

  return createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) {
        res.writeHead(400, {
          "content-type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify({ error: (e as Error).message }));
      } else res.end();
    });
  });
}

/** Open the DB, resolve auth/OIDC/actor/ns from env, start listening. Returns the running server. */
export async function runServe(
  db: string,
  port: number,
  env: Env,
  opts: { auth?: boolean; ns?: string | null } = {},
): Promise<Server> {
  const store = new SqliteStorage(db);
  await store.init();
  const auth = opts.auth || env.YOKE_AUTH === "on";
  const server = createServeServer({
    store,
    defaultActor: env.YOKE_ACTOR ?? "yoke:system",
    ns: opts.ns ?? resolveNs(undefined, env),
    auth,
    oidc: oidcFromEnv(env) ?? undefined,
    embedder: makeFetchEmbedder(env),
  });
  server.on("close", () => store.close());
  await new Promise<void>((resolve) => server.listen(port, resolve));
  const addr = server.address();
  const bound = typeof addr === "object" && addr ? addr.port : port;
  console.log(
    `yoke serve listening: http://localhost:${bound}  (auth ${auth ? "on" : "off"}, MCP at POST /mcp)`,
  );
  return server;
}
