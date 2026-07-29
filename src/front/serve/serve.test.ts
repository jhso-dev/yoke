// serve mode (PLAN-V2 10.2–10.4) — all in-process, port 0. Covers: API-token round-trip
// (incl. hash-not-plaintext), Bearer auth (401), RBAC over the HTTP surface (read-only GET ok /
// POST verify 403; verify token 200), the remote MCP endpoint (write-only token commits but
// yoke_inject is forbidden; unauthenticated 401), OIDC (local JWKS fixture: valid JWT passes +
// person auto-provisioned; expired / wrong-audience rejected), and a UI+MCP smoke.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Database from "better-sqlite3";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  SignJWT,
} from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../adapters/storage-sqlite/index.js";
import { commit } from "../../core/commit.js";
import { verify } from "../../core/lifecycle.js";
import { runCli } from "../cli/index.js";
import { isLoopback } from "../ui/server.js";
import { createServeServer, runServe } from "./index.js";
import { makeOidcVerifier, type OidcConfig } from "./oidc.js";

const dir = mkdtempSync(join(tmpdir(), "yoke-serve-"));
const now = () => "2026-07-13T00:00:00Z";
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Running {
  server: Server;
  base: string;
  close: () => void;
}
async function listen(server: Server): Promise<Running> {
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { server, base, close: () => server.close() };
}

/** A one-file stand-in for the built web bundle, so shell tests never depend on `npm run build`. */
function fixtureBundle(): string {
  const root = join(dir, "fixture-bundle");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "index.html"),
    "<!doctype html><p>fixture shell</p>",
  );
  return root;
}

async function freshDb(name: string): Promise<string> {
  const db = join(dir, `${name}.db`);
  expect(await runCli(["init", "--db", db])).toBe(0);
  return db;
}

describe("SqliteStorage tokens (PLAN-V2 10.3)", () => {
  it("create → verify → revoke round-trip; the plaintext is never stored", async () => {
    const db = await freshDb("tokens");
    const store = new SqliteStorage(db);
    await store.init();
    const { token } = store.createToken({
      name: "ci",
      scopes: ["read", "write"],
      created_at: now(),
    });
    expect(store.verifyToken(token)).toEqual({
      name: "ci",
      scopes: ["read", "write"],
    });
    expect(store.verifyToken("yk_wrong")).toBeNull();
    store.close();

    // Storage check: only a salted hash is persisted — the secret appears nowhere in the row.
    const raw = new Database(db, { readonly: true });
    const rowRaw = raw.prepare("SELECT * FROM tokens").get() as {
      hash: string;
      salt: string;
      scopes: string;
    };
    raw.close();
    expect(rowRaw.hash).not.toBe(token);
    expect(JSON.stringify(rowRaw)).not.toContain(token);

    const store2 = new SqliteStorage(db);
    await store2.init();
    expect(store2.listTokens().map((t) => t.name)).toEqual(["ci"]);
    expect(store2.revokeToken("ci")).toBe(true);
    expect(store2.verifyToken(token)).toBeNull();
    expect(store2.revokeToken("ci")).toBe(false);
    store2.close();
  });
});

describe("serve auth + RBAC (PLAN-V2 10.3/10.4)", () => {
  let store: SqliteStorage;
  let run: Running;
  let draftId: string;
  let readToken: string;
  let verifyToken: string;

  beforeAll(async () => {
    const db = await freshDb("auth");
    store = new SqliteStorage(db);
    await store.init();
    const ont = store.loadOntology();
    const draft = await commit(
      store,
      ont,
      { type: "fact", attributes: { title: "sky is blue" } },
      { actor: "yoke:system", origin: "cli", occurred_at: now() },
      now(),
    );
    draftId = draft.entity.id;
    readToken = store.createToken({
      name: "reader",
      scopes: ["read"],
      created_at: now(),
    }).token;
    verifyToken = store.createToken({
      name: "gov",
      scopes: ["read", "verify"],
      created_at: now(),
    }).token;
    run = await listen(
      createServeServer({
        store,
        defaultActor: "yoke:system",
        auth: true,
        now,
        webRoot: fixtureBundle(),
      }),
    );
  });
  afterAll(() => {
    run.close();
    store.close();
  });

  const authGet = (p: string, tok?: string) =>
    fetch(run.base + p, {
      headers: tok ? { authorization: `Bearer ${tok}` } : {},
    });
  const authPost = (p: string, body: unknown, tok?: string) =>
    fetch(run.base + p, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(tok ? { authorization: `Bearer ${tok}` } : {}),
      },
      body: JSON.stringify(body),
    });

  it("unauthenticated /api request → 401", async () => {
    expect((await authGet("/api/review")).status).toBe(401);
  });

  it("read-only token: GET ok, POST /api/verify → 403", async () => {
    expect((await authGet("/api/review", readToken)).status).toBe(200);
    const verifyRes = await authPost(
      "/api/verify",
      { ids: [draftId] },
      readToken,
    );
    expect(verifyRes.status).toBe(403);
  });

  it("verify-scoped token: POST /api/verify → 200 and promotes", async () => {
    const res = await authPost("/api/verify", { ids: [draftId] }, verifyToken);
    expect(res.status).toBe(200);
    const done = (await res.json()) as Array<{ id: string; status: string }>;
    expect(done[0].id).toBe(draftId);
    expect(done[0].status).toBe("verified");
  });

  it("UI shell (GET /) stays ungated even under auth", async () => {
    const res = await fetch(run.base + "/");
    expect(res.status).toBe(200);
    // Asserted against a fixture bundle: this test is about the shell staying UNGATED, and must not
    // also depend on whether dist/ happens to hold a real build.
    expect(await res.text()).toContain("fixture shell");
  });

  it("MCP endpoint: write-only token can commit, but yoke_inject is forbidden", async () => {
    const writeToken = store.createToken({
      name: "agent",
      scopes: ["write"],
      created_at: now(),
    }).token;
    const client = new Client({ name: "t", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(run.base + "/mcp"), {
        requestInit: { headers: { authorization: `Bearer ${writeToken}` } },
      }),
    );
    const commitRes = await client.callTool({
      name: "yoke_commit",
      arguments: { type: "fact", attributes: { title: "from agent" } },
    });
    expect(commitRes.isError).toBeFalsy();

    const injectRes = await client.callTool({
      name: "yoke_inject",
      arguments: { query: "anything" },
    });
    expect(injectRes.isError).toBe(true);
    expect((injectRes.content as Array<{ text: string }>)[0].text).toContain(
      "forbidden",
    );
    await client.close();
  });

  it("MCP endpoint without a Bearer → 401", async () => {
    const res = await authPost("/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    expect(res.status).toBe(401);
  });
});

describe("OIDC (PLAN-V2 10.3, local JWKS fixture)", () => {
  let store: SqliteStorage;
  let run: Running;
  let sign: (claims: Record<string, unknown>, exp: string) => Promise<string>;
  let oidc: OidcConfig;
  const issuer = "https://idp.test/";
  const audience = "yoke";

  beforeAll(async () => {
    const db = await freshDb("oidc");
    store = new SqliteStorage(db);
    await store.init();
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = (await exportJWK(publicKey)) as JWK;
    jwk.kid = "test-key";
    jwk.alg = "RS256";
    const jwks = createLocalJWKSet({ keys: [jwk] });
    oidc = { issuer, audience, jwks };
    sign = (claims, exp) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime(exp)
        .sign(privateKey);
    run = await listen(
      createServeServer({
        store,
        defaultActor: "yoke:system",
        auth: true,
        oidc,
        now,
      }),
    );
  });
  afterAll(() => {
    run.close();
    store.close();
  });

  const get = (tok: string) =>
    fetch(run.base + "/api/review", {
      headers: { authorization: `Bearer ${tok}` },
    });

  it("valid JWT passes and auto-provisions a verified person", async () => {
    const jwt = await sign({ sub: "user-1", email: "alice@test" }, "2h");
    expect((await get(jwt)).status).toBe(200);
    // person auto-provisioned via the commit gate + verify, id derived from the subject (email).
    const person = await store.getEntity("oidc:alice@test");
    expect(person?.type).toBe("person");
    expect(person?.status).toBe("verified");
  });

  it("a bare login can read but cannot verify — an SSO account is not a governance grant", async () => {
    const jwt = await sign({ sub: "user-viewer", email: "viewer@test" }, "2h");
    expect((await get(jwt)).status).toBe(200);
    const res = await fetch(`${run.base}/api/verify`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ids: ["oidc:viewer@test"] }),
    });
    expect(res.status).toBe(403);
  });

  it("honours a verify grant carried by the token's scope claim", async () => {
    const jwt = await sign(
      { sub: "user-gov", email: "gov@test", scope: "read verify" },
      "2h",
    );
    expect((await get(jwt)).status).toBe(200);
    const res = await fetch(`${run.base}/api/verify`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ids: ["oidc:gov@test"] }),
    });
    expect(res.status).toBe(200);
  });

  // Asserted on the verifier rather than over HTTP: the grant confinement rules are what matter,
  // and a 403 through the API would also pass for the wrong reason (the server's own ns not
  // matching), so it would not isolate the cross-tenant drop.
  it("confines granted scopes to the ns claim and ignores non-yoke scopes", async () => {
    const verify = makeOidcVerifier(oidc);
    // A real IdP sends openid/profile/email — none of it is a grant. `read` is unqualified so it is
    // narrowed to the token's tenant. `globex:verify` names another tenant and is dropped outright.
    const scoped = await sign(
      {
        sub: "cross",
        ns: "acme",
        scope: "openid profile email read acme:decision:verify globex:verify",
      },
      "2h",
    );
    expect((await verify(scoped))?.scopes).toEqual([
      "acme:read",
      "acme:decision:verify",
    ]);
    // No ns claim = an all-namespace identity (pre-existing design), so grants pass through as-is.
    const global = await sign({ sub: "glob", scope: "read verify" }, "2h");
    expect((await verify(global))?.scopes).toEqual(["read", "verify"]);
    // A `scopes` array works too, and a token carrying nothing grants nothing.
    const arr = await sign({ sub: "arr", scopes: ["write"] }, "2h");
    expect((await verify(arr))?.scopes).toEqual(["write"]);
    const bare = await sign({ sub: "bare" }, "2h");
    expect((await verify(bare))?.scopes).toEqual([]);
  });

  it("expired JWT is rejected (401)", async () => {
    const jwt = await sign({ sub: "user-2" }, "-1h");
    expect((await get(jwt)).status).toBe(401);
  });

  it("wrong-audience JWT is rejected (401)", async () => {
    const jwt = await new SignJWT({ sub: "user-3" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience("some-other-app")
      .setIssuedAt()
      .setExpirationTime("2h")
      .sign((await generateKeyPair("RS256")).privateKey);
    expect((await get(jwt)).status).toBe(401);
  });
});

describe("read replica (PLAN-V2 11.2)", () => {
  it("serves reads; writes rejected (409 API / MCP tool error); refreshNow pulls new data", async () => {
    const primary = await freshDb("replica-primary");
    // Seed a verified fact on the primary.
    const p = new SqliteStorage(primary);
    await p.init();
    const d = await commit(
      p,
      p.loadOntology(),
      { type: "fact", attributes: { title: "replicated" } },
      { actor: "yoke:system", origin: "cli", occurred_at: now() },
      now(),
    );
    await verify(p, [d.entity.id], "yoke:system", now());
    p.close();

    // Build the replica snapshot + read-only server directly (mirrors runServe's replica branch).
    const snapshotPath = join(dir, "replica-snap.db");
    const seed = new Database(primary, { readonly: true });
    await seed.backup(snapshotPath);
    seed.close();
    const store = new SqliteStorage(snapshotPath);
    await store.init();
    const server = createServeServer({
      store,
      defaultActor: "yoke:system",
      auth: false,
      now,
      readOnly: true,
      replica: { primaryPath: primary, snapshotPath, refreshSec: 3600 },
    });
    const run = await listen(server);

    // GET read works.
    expect((await fetch(run.base + "/api/ontology")).status).toBe(200);

    // POST /api/verify → 409 with the read-only message.
    const vres = await fetch(run.base + "/api/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [d.entity.id] }),
    });
    expect(vres.status).toBe(409);
    expect(((await vres.json()) as { error: string }).error).toContain(
      "read-only replica",
    );

    // MCP: commit tool rejected (write denied), inject still works (read).
    const client = new Client({ name: "rep", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(run.base + "/mcp")),
    );
    const commitRes = await client.callTool({
      name: "yoke_commit",
      arguments: { type: "fact", attributes: { title: "blocked" } },
    });
    expect(commitRes.isError).toBe(true);
    expect((commitRes.content as Array<{ text: string }>)[0].text).toContain(
      "forbidden",
    );
    const injectRes = await client.callTool({
      name: "yoke_inject",
      arguments: { query: "replicated" },
    });
    expect(injectRes.isError).toBeFalsy();
    expect((injectRes.content as Array<{ text: string }>)[0].text).toContain(
      "replicated",
    );
    await client.close();

    // refreshNow: new verified data on the primary becomes visible after a manual pull.
    const p2 = new SqliteStorage(primary);
    await p2.init();
    const d2 = await commit(
      p2,
      p2.loadOntology(),
      { type: "fact", attributes: { title: "afterrefresh" } },
      { actor: "yoke:system", origin: "cli", occurred_at: now() },
      now(),
    );
    await verify(p2, [d2.entity.id], "yoke:system", now());
    p2.close();

    // biome-ignore lint/style/noNonNullAssertion: refreshNow is present in replica mode.
    await server.refreshNow!();

    const client2 = new Client({ name: "rep2", version: "0" });
    await client2.connect(
      new StreamableHTTPClientTransport(new URL(run.base + "/mcp")),
    );
    const injectRes2 = await client2.callTool({
      name: "yoke_inject",
      arguments: { query: "afterrefresh" },
    });
    expect((injectRes2.content as Array<{ text: string }>)[0].text).toContain(
      "afterrefresh",
    );
    await client2.close();

    run.close();
  });
});

describe("meta under auth", () => {
  it("answers without a credential but reveals nothing, and identifies a real one", async () => {
    const db = await freshDb("meta");
    const store = new SqliteStorage(db);
    await store.init();
    const { token } = store.createToken({
      name: "reader",
      scopes: ["read"],
      created_at: now(),
    });
    const run = await listen(
      createServeServer({
        store,
        defaultActor: "yoke:system",
        auth: true,
        ns: "acme",
        now,
      }),
    );

    // Unauthenticated: says a credential is required, and withholds actor and ns — otherwise this
    // route would be an anonymous way to enumerate tenants.
    const anon = await fetch(`${run.base}/api/meta`);
    expect(anon.status).toBe(200);
    expect(await anon.json()).toEqual({
      auth: true,
      readOnly: false,
      ns: null,
      actor: null,
    });

    // With a credential it identifies the principal.
    const known = await fetch(`${run.base}/api/meta`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(await known.json()).toEqual({
      auth: true,
      readOnly: false,
      ns: "acme",
      actor: "token:reader",
    });

    // Every OTHER api route still requires one.
    expect((await fetch(`${run.base}/api/review`)).status).toBe(401);

    run.close();
    store.close();
  });
});

describe("bind address", () => {
  it("classifies loopback addresses", () => {
    for (const h of ["127.0.0.1", "127.0.1.5", "::1", "localhost"])
      expect(isLoopback(h)).toBe(true);
    for (const h of ["0.0.0.0", "::", "192.168.1.10", "example.test"])
      expect(isLoopback(h)).toBe(false);
  });

  it("refuses to bind a non-loopback address without auth", async () => {
    const db = await freshDb("bind");
    await expect(
      runServe(db, 0, {}, { host: "0.0.0.0", auth: false }),
    ).rejects.toThrow(/refusing to bind 0\.0\.0\.0 without authentication/);
  });

  it("binds loopback by default — not every interface", async () => {
    const db = await freshDb("bind-default");
    const server = await runServe(db, 0, {}, {});
    const addr = server.address();
    expect(typeof addr === "object" && addr?.address).toBe("127.0.0.1");
    await new Promise<void>((r) => server.close(() => r()));
  });
});

describe("serve smoke (auth off)", () => {
  it("UI HTML served + MCP initialize round-trip over HTTP", async () => {
    const db = await freshDb("smoke");
    const store = new SqliteStorage(db);
    await store.init();
    const run = await listen(
      createServeServer({
        store,
        defaultActor: "yoke:system",
        auth: false,
        now,
        webRoot: fixtureBundle(),
      }),
    );

    const htmlRes = await fetch(run.base + "/");
    expect(await htmlRes.text()).toContain("fixture shell");

    const client = new Client({ name: "smoke", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(run.base + "/mcp")),
    );
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "yoke_commit",
      "yoke_inject",
      "yoke_persona",
      "yoke_record_decision",
      "yoke_use_scope",
    ]);
    await client.close();
    run.close();
    store.close();
  });
});
