// serve mode (ENTERPRISE "server mode"–10.4) — all in-process, port 0. Covers: signed-credential
// round-trip (minted, verified, stored nowhere), Bearer auth (401), RBAC over the HTTP surface
// (read-only GET ok / POST verify 403; write token 200), the remote MCP endpoint (write-only token
// commits but yoke_inject is forbidden; unauthenticated 401), OIDC (local JWKS fixture: valid JWT
// passes + person auto-provisioned; expired / wrong-audience rejected), and a UI+MCP smoke.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SqliteStorage } from "../../adapters/storage-sqlite/index.js";
import { commit } from "../../core/commit.js";
import { seedOntology } from "../../core/ontology.js";
import { openStore } from "../store.js";
import { isLoopback } from "../ui/server.js";
import { credentialSigner } from "./credential.js";
import { createServeServer, runServe } from "./index.js";

/** The key these tests sign and verify with — the same one every instance would share in a real
 *  deployment, which is the whole reason a credential needs no storage. */
const SECRET = "test-signing-key-not-a-real-one";
// biome-ignore lint/style/noNonNullAssertion: SECRET is a literal, so the signer is never null.
const sign = credentialSigner(SECRET)!;
const mint = async (name: string, scopes: string[]): Promise<string> =>
  (await sign.mint({ name, scopes, ns: null })).token;

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
  (await openStore({ db }, {})).close();
  return db;
}

describe("signed credentials", () => {
  it("mints an access/refresh pair that verifies without touching storage", async () => {
    const cred = { name: "ci", scopes: ["read", "write"], ns: null };
    const { token, refresh } = await sign.mint(cred);
    expect(await sign.verifyAccess(token)).toEqual(cred);
    expect(await sign.verifyRefresh(refresh)).toEqual(cred);
  });

  it("refuses a refresh token presented as an access one, and the reverse", async () => {
    // The substitution the `typ` claim exists to stop: a refresh token is long-lived and travels to
    // one route, so accepting it as an access credential would hand a year's access to every route.
    const { token, refresh } = await sign.mint({
      name: "ci",
      scopes: ["read"],
      ns: null,
    });
    expect(await sign.verifyAccess(refresh)).toBeNull();
    expect(await sign.verifyRefresh(token)).toBeNull();
  });

  it("refuses a credential signed with another key", async () => {
    // The multi-instance contract in reverse: instances agree because they share the key, so one
    // that does not share it must agree about nothing.
    // biome-ignore lint/style/noNonNullAssertion: a literal secret, so never null.
    const other = credentialSigner("a-different-key")!;
    const { token } = await other.mint({
      name: "ci",
      scopes: ["read"],
      ns: null,
    });
    expect(await sign.verifyAccess(token)).toBeNull();
  });

  it("carries the namespace, so a tenant credential stays one", async () => {
    const { token } = await sign.mint({
      name: "t",
      scopes: ["tenant-a:read"],
      ns: "tenant-a",
    });
    expect((await sign.verifyAccess(token))?.ns).toBe("tenant-a");
  });

  it("mints nothing without a key", () => {
    expect(credentialSigner(undefined)).toBeNull();
    expect(credentialSigner("")).toBeNull();
  });
});

describe("serve auth + RBAC", () => {
  let store: SqliteStorage;
  let run: Running;
  let factId: string;
  let readToken: string;
  let writeToken: string;

  beforeAll(async () => {
    const db = await freshDb("auth");
    store = new SqliteStorage(db);
    await store.init();
    const ont = store.loadOntology();
    const fact = await commit(
      store,
      ont,
      { type: "fact", attributes: { statement: "sky is blue" } },
      { actor: "yoke:system", origin: "cli", occurred_at: now() },
      now(),
    );
    factId = fact.entity.id;
    readToken = await mint("reader", ["read"]);
    writeToken = await mint("writer", ["read", "write"]);
    run = await listen(
      createServeServer({
        store,
        defaultActor: "yoke:system",
        auth: true,
        tokenSecret: SECRET,
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

  it("read-only token: GET ok, POST /api/verify → 403 naming the scope", async () => {
    expect((await authGet("/api/review", readToken)).status).toBe(200);
    const verifyRes = await authPost(
      "/api/verify",
      { ids: [factId] },
      readToken,
    );
    expect(verifyRes.status).toBe(403);
    // A bare `{"error":"forbidden"}` tells the holder of a read-only token that something was
    // refused and not which permission to go and ask for. The 403 names the required scope.
    const body = (await verifyRes.json()) as {
      error: string;
      required?: string;
    };
    expect(body.error).toContain("'write' scope");
    expect(body.required).toBe("write");
  });

  it("read-only token: POST /api/entity and /api/link → 403", async () => {
    // The web tier may create records. That does not let a READER create one —
    // creation is gated on `write`, per type, exactly like the read routes are gated on `read`.
    expect(
      (await authPost("/api/entity", { type: "fact" }, readToken)).status,
    ).toBe(403);
    expect(
      (
        await authPost(
          "/api/link",
          { from: factId, type: "relates_to", to: factId },
          readToken,
        )
      ).status,
    ).toBe(403);
  });

  it("write-scoped token: POST /api/verify → 200 and re-confirms (a new version)", async () => {
    const res = await authPost("/api/verify", { ids: [factId] }, writeToken);
    expect(res.status).toBe(200);
    const done = (await res.json()) as Array<{
      id: string;
      status: string;
      version: number;
    }>;
    expect(done[0].id).toBe(factId);
    // Born verified (v1); the re-confirmation is its own version, so the freshness refresh is on
    // the record's timeline rather than an in-place overwrite.
    expect(done[0].status).toBe("verified");
    expect(done[0].version).toBe(2);
  });

  it("GET /api/inject?unseen=1 is one ledger per token: what FE was handed is not what PO was", async () => {
    // Two tokens = two readers of one server. The server's trail holds both, and each hook must be
    // bounded by ITS OWN deliveries — otherwise PO reading a decision would silence FE's hook.
    const ont = store.loadOntology();
    const prov = { actor: "po", origin: "cli", occurred_at: now() };
    const scope = (
      await commit(
        store,
        ont,
        { type: "collaboration", attributes: { title: "PROJ-1" } },
        prov,
        now(),
      )
    ).entity.id;
    const d1 = (
      await commit(
        store,
        ont,
        { type: "fact", attributes: { statement: "PG is Toss" } },
        prov,
        now(),
        {
          attachTo: scope,
        },
      )
    ).entity.id;
    const feToken = await mint("fe", ["read"]);
    const unseen = (tok: string) =>
      authGet(`/api/inject?scope=${scope}&unseen=1`, tok);

    // FE's first call: the briefing, as text.
    const first = await unseen(feToken);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toContain("text/plain");
    const body = await first.text();
    expect(body).toContain("-- new in PROJ-1:");
    expect(body).toContain(d1);
    // FE again: nothing new → 204, no body.
    expect((await unseen(feToken)).status).toBe(204);
    // PO's hook, same server, same scope: PO was handed nothing yet, so PO still gets the briefing.
    const po = await unseen(writeToken);
    expect(po.status).toBe(200);
    expect(await po.text()).toContain(d1);
    // The rows are `inject` (a model received knowledge), one per delivery, under each token's actor.
    const rows = (await store.listAudit()).filter(
      (r) => r.action === "inject" && r.detail.startsWith(scope),
    );
    expect(rows.map((r) => r.actor).sort()).toEqual([
      "token:fe",
      "token:writer",
    ]);
    // Guards: a briefing of one context.
    expect((await authGet(`/api/inject?q=x&unseen=1`, feToken)).status).toBe(
      400,
    );
    expect(
      (await authGet(`/api/inject?scope=${scope}&q=x&unseen=1`, feToken))
        .status,
    ).toBe(400);
    expect(
      (await authGet(`/api/inject?scope=nope&unseen=1`, feToken)).status,
    ).toBe(400);
  });

  it("a retirement reaches the record's AUTHOR, who was never handed it (S5)", async () => {
    // The ledger counts inject rows, and an author never pulled what they wrote — yet theirs is the
    // session most likely to still be building on it. The recall must chase authorship, not only
    // deliveries.
    const ont = store.loadOntology();
    const scope = (
      await commit(
        store,
        ont,
        { type: "collaboration", attributes: { title: "PROJ-2" } },
        { actor: "po", origin: "cli", occurred_at: now() },
        now(),
      )
    ).entity.id;
    const beToken = await mint("be", ["read", "write"]);
    // BE files a fact through the server (signed token:be — the same handle the authored_by edge
    // carries), and never reads the scope.
    const created = await authPost(
      "/api/entity",
      {
        type: "fact",
        attributes: { statement: "settlement API allows 100 rps" },
        scope,
      },
      beToken,
    );
    expect(created.status).toBe(201);
    const badId = ((await created.json()) as { id: string }).id;
    // Someone else retires it with a reason.
    const dep = await authPost(
      "/api/deprecate",
      { ids: [badId], reason: "measured 429 at 30 rps" },
      writeToken,
    );
    expect(dep.status).toBe(200);
    // BE's next hook: the recall, with the reason — via authorship, since BE holds no delivery.
    const be = await authGet(`/api/inject?scope=${scope}&unseen=1`, beToken);
    expect(be.status).toBe(200);
    const body = await be.text();
    expect(body).toContain("changed since handed to you");
    expect(body).toContain("measured 429 at 30 rps");
    // Delivered once: the recall rode an inject row, so the next call is silent.
    const again = await authGet(`/api/inject?scope=${scope}&unseen=1`, beToken);
    expect(again.status).toBe(204);
    // The retirer's own session needs no recall of what it retired.
    const po = await authGet(`/api/inject?scope=${scope}&unseen=1`, writeToken);
    if (po.status === 200)
      expect(await po.text()).not.toContain("measured 429 at 30 rps");
  });

  it("UI shell (GET /) stays ungated even under auth", async () => {
    const res = await fetch(run.base + "/");
    expect(res.status).toBe(200);
    // Asserted against a fixture bundle: this test is about the shell staying UNGATED, and must not
    // also depend on whether dist/ happens to hold a real build.
    expect(await res.text()).toContain("fixture shell");
  });

  it("MCP endpoint: write-only token can commit, but yoke_inject is forbidden", async () => {
    const writeToken = await mint("agent", ["write"]);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(run.base + "/mcp"), {
        requestInit: { headers: { authorization: `Bearer ${writeToken}` } },
      }),
    );
    const commitRes = await client.callTool({
      name: "yoke_commit",
      arguments: { type: "fact", attributes: { statement: "from agent" } },
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

  // SPEC "Bounded input" holds for every route on this server, and /mcp is the one route that never
  // reaches the UI handler's readBody — so it needs its own cap, on the only surface that can face a
  // non-loopback interface.
  it("MCP endpoint caps the request body and validates content-type", async () => {
    const big = await fetch(run.base + "/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${readToken}`,
      },
      body: `{"pad":"${"x".repeat(257 * 1024)}"}`,
    });
    expect(big.status).toBe(400);
    expect((await big.json()).error).toContain("too large");

    const wrongType = await fetch(run.base + "/mcp", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        authorization: `Bearer ${readToken}`,
      },
      body: "{}",
    });
    expect(wrongType.status).toBe(400);
    expect((await wrongType.json()).error).toContain("content-type");
  });
});

describe("OIDC (local JWKS fixture)", () => {
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
        tokenSecret: SECRET,
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
    // person auto-provisioned via the commit gate (born verified), id derived from the subject (email).
    const person = await store.getEntity("oidc:alice@test");
    expect(person?.type).toBe("person");
    expect(person?.status).toBe("verified");
  });

  it("a bare login can read but cannot write — an SSO account is not a knowledge grant", async () => {
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

  it("honours a write grant carried by the token's scope claim", async () => {
    const jwt = await sign(
      { sub: "user-gov", email: "gov@test", scope: "read write" },
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
    // narrowed to the token's tenant. `globex:write` names another tenant and is dropped outright.
    const scoped = await sign(
      {
        sub: "cross",
        ns: "acme",
        scope: "openid profile email read acme:decision:write globex:write",
      },
      "2h",
    );
    expect((await verify(scoped))?.scopes).toEqual([
      "acme:read",
      "acme:decision:write",
    ]);
    // No ns claim = an all-namespace identity (pre-existing design), so grants pass through as-is.
    const global = await sign({ sub: "glob", scope: "read write" }, "2h");
    expect((await verify(global))?.scopes).toEqual(["read", "write"]);
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

describe("meta under auth", () => {
  it("answers without a credential but reveals nothing, and identifies a real one", async () => {
    const db = await freshDb("meta");
    const store = new SqliteStorage(db);
    await store.init();
    const token = await mint("reader", ["read"]);
    const run = await listen(
      createServeServer({
        store,
        defaultActor: "yoke:system",
        auth: true,
        tokenSecret: SECRET,
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
      ns: null,
      actor: null,
    });

    // With a credential it identifies the principal.
    const known = await fetch(`${run.base}/api/meta`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(await known.json()).toEqual({
      auth: true,
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

  // The chicken-and-egg: minting goes through POST /api/tokens, which needs an admin credential.
  // Without this flag a gated deployment with no external issuer could never mint its first one.
  it("--bootstrap-admin prints a credential that can mint the next one", async () => {
    const db = await freshDb("bootstrap");
    const logged: string[] = [];
    const warned: string[] = [];
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((m?: unknown) => void logged.push(String(m)));
    const warn = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((m: unknown) => {
        warned.push(String(m));
        return true;
      });
    let server: Server;
    try {
      server = await runServe(
        db,
        0,
        { YOKE_TOKEN_SECRET: SECRET },
        { auth: true, bootstrapAdmin: true },
      );
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
    const token = logged
      .join("\n")
      .split("\n")
      .find((l) => l.startsWith("eyJ"));
    expect(token).toBeTruthy();
    // The credential on stdout, the one-time warning on stderr — an operator who pipes stdout into a
    // secret store still sees why the flag must come back out of the unit file.
    expect(warned.join("")).toMatch(/ONE-TIME.*restart/s);
    // And it dies in an hour, not the usual week: a copy scraped out of a boot log is already dead.
    const exp = JSON.parse(
      Buffer.from((token as string).split(".")[1], "base64url").toString(),
    ).exp as number;
    expect(exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(3600);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const minted = await fetch(`${base}/api/tokens`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: "ci", scopes: ["read", "write"] }),
      });
      expect(minted.status).toBe(201);
      // And what it minted cannot mint again — admin does not propagate by being asked for.
      const next = (await minted.json()).token;
      const denied = await fetch(`${base}/api/tokens`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${next}`,
        },
        body: JSON.stringify({ name: "sneaky", scopes: ["admin"] }),
      });
      expect(denied.status).toBe(403);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("--bootstrap-admin without a signing key refuses rather than printing something nothing accepts", async () => {
    const db = await freshDb("bootstrap-nokey");
    await expect(
      runServe(db, 0, {}, { auth: true, bootstrapAdmin: true }),
    ).rejects.toThrow(/YOKE_TOKEN_SECRET/);
  });

  // Ungated, the credential is not merely useless — it is a lie about what the server does. Refusing
  // beats printing something that would be accepted nowhere, and it happens before the store exists.
  it("--bootstrap-admin without --auth refuses, and creates nothing on the way", async () => {
    const db = join(dir, "bootstrap-noauth.db");
    await expect(
      runServe(db, 0, { YOKE_TOKEN_SECRET: SECRET }, { bootstrapAdmin: true }),
    ).rejects.toThrow(/--bootstrap-admin.*--auth/s);
    expect(existsSync(db)).toBe(false);
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
      "yoke_overview",
      "yoke_persona",
      "yoke_record_decision",
      "yoke_use_scope",
    ]);
    await client.close();
    run.close();
    store.close();
  });
});

describe("GitHub exchange (POST /api/login/github)", () => {
  let store: SqliteStorage;
  let run: Running;
  let gh: Running;

  /** A stand-in for api.github.com: the token IS the fixture key. */
  const people: Record<string, { login: string; member: boolean }> = {
    gh_alice: { login: "alice", member: true },
    gh_stranger: { login: "stranger", member: false },
  };

  beforeAll(async () => {
    const { createServer } = await import("node:http");
    gh = await listen(
      createServer((req, res) => {
        const tok = (req.headers.authorization ?? "").replace("Bearer ", "");
        const who = people[tok];
        const send = (code: number, body: unknown) => {
          res.writeHead(code, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        };
        if (!who) return send(401, { message: "Bad credentials" });
        if (req.url === "/user") return send(200, { login: who.login });
        if (req.url?.startsWith("/user/memberships/orgs/acme"))
          return who.member
            ? send(200, { state: "active" })
            : send(404, { message: "Not Found" });
        return send(404, { message: "Not Found" });
      }),
    );
    store = new SqliteStorage(await freshDb("ghlogin"));
    await store.init();
    run = await listen(
      createServeServer({
        store,
        defaultActor: "yoke:system",
        auth: true,
        tokenSecret: SECRET,
        now,
        webRoot: fixtureBundle(),
        github: { org: "acme", api: gh.base },
      }),
    );
  });
  afterAll(() => {
    run.close();
    gh.close();
    store.close();
  });

  const login = (tok?: string) =>
    fetch(`${run.base}/api/login/github`, {
      method: "POST",
      headers: tok ? { authorization: `Bearer ${tok}` } : {},
    });

  it("an org member gets read+write — the whole knowledge permission", async () => {
    const alice = await login("gh_alice");
    expect(alice.status).toBe(200);
    const a = (await alice.json()) as {
      token: string;
      name: string;
      login: string;
      scopes: string[];
    };
    expect(a).toMatchObject({
      name: "github:alice",
      login: "alice",
      scopes: ["read", "write"],
    });
    // The minted token is a working yoke credential whose actor is the GitHub identity.
    const read = await fetch(`${run.base}/api/review`, {
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(read.status).toBe(200);
  });

  it("re-exchange does NOT invalidate the credential already issued", async () => {
    // The cost of a signed credential, pinned so nobody assumes otherwise: there is no list to remove
    // a token from, so one already in someone's hands stands until it expires. Removing the person
    // from the org stops the NEXT exchange, which is the durable lever (credential.ts).
    const first = (await (await login("gh_alice")).json()) as { token: string };
    const second = (await (await login("gh_alice")).json()) as {
      token: string;
    };
    for (const token of [first.token, second.token]) {
      const res = await fetch(`${run.base}/api/review`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
    }
  });

  it("hands back a refresh token that buys a new access token", async () => {
    // The browser's seamless path: a pasted credential expires, and there is nothing for a person to
    // paste again — so the client spends the refresh token instead of showing a login form.
    const issued = (await (await login("gh_alice")).json()) as {
      token: string;
      refresh: string;
    };
    expect(issued.refresh).toBeTruthy();
    // The refresh token is not an access credential, whatever a client does with it.
    expect(
      (
        await fetch(`${run.base}/api/review`, {
          headers: { authorization: `Bearer ${issued.refresh}` },
        })
      ).status,
    ).toBe(401);

    const refreshed = await fetch(`${run.base}/api/refresh`, {
      method: "POST",
      headers: { authorization: `Bearer ${issued.refresh}` },
    });
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { token: string; name: string };
    expect(next.name).toBe("github:alice");
    expect(
      (
        await fetch(`${run.base}/api/review`, {
          headers: { authorization: `Bearer ${next.token}` },
        })
      ).status,
    ).toBe(200);
  });

  it("refuses a refresh call with no credential, or with an access token", async () => {
    const issued = (await (await login("gh_alice")).json()) as {
      token: string;
    };
    const cases: Record<string, string>[] = [
      {},
      { authorization: `Bearer ${issued.token}` },
    ];
    for (const headers of cases) {
      const res = await fetch(`${run.base}/api/refresh`, {
        method: "POST",
        headers,
      });
      expect(res.status).toBe(401);
    }
  });

  it("refuses a non-member (403 naming the org), a bad credential (401), and a bare call (401)", async () => {
    const outsider = await login("gh_stranger");
    expect(outsider.status).toBe(403);
    expect(((await outsider.json()) as { error: string }).error).toContain(
      "acme",
    );
    expect((await login("gh_bogus")).status).toBe(401);
    expect((await login()).status).toBe(401);
    // And the GitHub token itself never becomes a yoke credential.
    expect(
      (
        await fetch(`${run.base}/api/review`, {
          headers: { authorization: "Bearer gh_alice" },
        })
      ).status,
    ).toBe(401);
  });

  it("does not exist on a server that has not named an org — 404, not 403", async () => {
    const bare = await listen(
      createServeServer({
        store,
        defaultActor: "yoke:system",
        auth: true,
        tokenSecret: SECRET,
        now,
        webRoot: fixtureBundle(),
      }),
    );
    try {
      expect(
        (
          await fetch(`${bare.base}/api/login/github`, {
            method: "POST",
            headers: { authorization: "Bearer gh_alice" },
          })
        ).status,
      ).toBe(404);
    } finally {
      bare.close();
    }
  });

  it("answers 502, not 401, when GitHub is unreachable — an upstream failure is not a verdict on the caller", async () => {
    const dead = await listen(
      createServeServer({
        store,
        defaultActor: "yoke:system",
        auth: true,
        tokenSecret: SECRET,
        now,
        webRoot: fixtureBundle(),
        github: { org: "acme", api: "http://127.0.0.1:1" },
      }),
    );
    try {
      const res = await fetch(`${dead.base}/api/login/github`, {
        method: "POST",
        headers: { authorization: "Bearer gh_alice" },
      });
      expect(res.status).toBe(502);
    } finally {
      dead.close();
    }
  });
});

// The company-DB deployment: the knowledge lives in the company's OpenSearch, the read trail at the
// address `YOKE_AUDIT_URL` names, and the credential in NEITHER — it is signed, so there is nothing
// to store (credential.ts). The store is built by `openStore` from those variables rather than by
// hand, because the composition they produce is as much under test as the routes are: a knowledge
// backend that cannot hold a ledger must be given an address for one (store.test.ts pins that
// refusal). Skips without a live cluster; CI's opensearch-adapter job runs it for real. Scoped to
// `yoketest_*` indices like every OpenSearch suite — never widen the prefix.
describe.skipIf(!process.env.YOKE_TEST_OPENSEARCH_URL)(
  "serve --auth over a company OpenSearch: knowledge remote, trail at YOKE_AUDIT_URL, credential nowhere",
  () => {
    const OS_URL = process.env.YOKE_TEST_OPENSEARCH_URL as string;
    const PREFIX = "yoketest_serveauth_";

    it("commits to OpenSearch, trails to the ledger, and writes the credential down in neither", async () => {
      await fetch(`${OS_URL}/${PREFIX}*`, { method: "DELETE" }).catch(() => {});
      const { createServer } = await import("node:http");
      const gh = await listen(
        createServer((req, res) => {
          const ok = (req.headers.authorization ?? "") === "Bearer gh_alice";
          res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
          res.end(
            JSON.stringify(
              ok
                ? req.url === "/user"
                  ? { login: "alice" }
                  : { state: "active" }
                : {},
            ),
          );
        }),
      );
      // Two local paths, neither seeded first: the ledger the trail is addressed to, and a `--db`
      // that a remote knowledge store leaves with nothing to name.
      const ledger = join(dir, "os-serveauth-ledger.db");
      const unusedDb = join(dir, "os-serveauth-unused.db");
      const store = await openStore(
        { db: unusedDb },
        {
          YOKE_OPENSEARCH_URL: OS_URL,
          YOKE_OPENSEARCH_PREFIX: PREFIX,
          YOKE_AUDIT_URL: ledger,
        },
      );
      const run = await listen(
        createServeServer({
          store,
          defaultActor: "yoke:system",
          auth: true,
          tokenSecret: SECRET,
          now,
          webRoot: fixtureBundle(),
          github: { org: "acme", api: gh.base },
        }),
      );
      try {
        const { token } = (await (
          await fetch(`${run.base}/api/login/github`, {
            method: "POST",
            headers: { authorization: "Bearer gh_alice" },
          })
        ).json()) as { token: string };
        // The credential carries who it speaks for, which is why no store had to be asked.
        const claims = JSON.parse(
          Buffer.from(token.split(".")[1], "base64url").toString(),
        ) as { sub?: string };
        expect(claims.sub).toBe("github:alice");
        const created = (await (
          await fetch(`${run.base}/api/entity`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              type: "fact",
              attributes: { statement: "credentials stay home" },
            }),
          })
        ).json()) as { id: string };
        // The knowledge is in the remote half (a point read is realtime on OpenSearch)…
        expect((await store.getEntity(created.id))?.attributes.statement).toBe(
          "credentials stay home",
        );
        // …and one authenticated read hands it to an agent, which is what leaves a trail.
        expect(
          (
            await fetch(
              `${run.base}/api/inject?q=${encodeURIComponent("credentials stay home")}`,
              { headers: { authorization: `Bearer ${token}` } },
            )
          ).status,
        ).toBe(200);

        const raw = new Database(ledger, { readonly: true });
        const tables = (
          raw
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all() as Array<{ name: string }>
        ).map((r) => r.name);
        const entities = (
          raw.prepare("SELECT count(*) c FROM entities").get() as { c: number }
        ).c;
        const injects = (
          raw
            .prepare("SELECT detail FROM audit_log WHERE action = 'inject'")
            .all() as Array<{ detail: string }>
        ).map((r) => r.detail);
        const delivery = raw
          .prepare("SELECT n FROM delivery WHERE entity_id = ?")
          .get(created.id) as { n: number } | undefined;
        raw.close();
        // The ledger holds the trail and only the trail: no corpus — not even the bootstrap person,
        // which was seeded into OpenSearch — and no table for credentials, because a signed one is
        // never written down.
        expect(tables).toContain("audit_log");
        expect(tables).not.toContain("tokens");
        expect(entities).toBe(0);
        expect(injects).toHaveLength(1);
        expect(injects[0]).toContain(created.id);
        expect(delivery).toMatchObject({ n: 1 });
        // The same delivery read back through the store, which is how the stale queue asks.
        expect(
          (await store.consumption({ ids: [created.id] })).get(created.id),
        ).toBe(1);
        // Nothing went to the file `--db` named: a remote knowledge store leaves it meaningless, and
        // the trail had an address of its own.
        expect(existsSync(unusedDb)).toBe(false);

        // The remote half read as documents rather than through the adapter. The two positive checks
        // are what stop the two negative ones from passing over an empty dump.
        await fetch(`${OS_URL}/${PREFIX}*/_refresh`, { method: "POST" });
        const docs = JSON.stringify(
          await (await fetch(`${OS_URL}/${PREFIX}*/_search?size=1000`)).json(),
        );
        expect(docs).toContain(created.id);
        expect(docs).toContain("yoke:system");
        expect(docs).not.toContain(token);
        expect(docs).not.toContain(injects[0]);
      } finally {
        run.close();
        gh.close();
        store.close();
        await fetch(`${OS_URL}/${PREFIX}*`, { method: "DELETE" }).catch(
          () => {},
        );
      }
    }, 60_000);
  },
);

describe("a narrow credential can still use the capture path", () => {
  // A connector credential is narrow by design — `ns:fact:write` for a Slack sync — and the bulk
  // routes checked a bare `write`, which a type-scoped token does not hold. Measured: such a token
  // could `add` a fact and could not `ingest` one, so the whole automatic path was closed to exactly
  // the credentials the RBAC model exists to hand out.
  it("ingests the types it holds, refuses the ones it does not, and writes nothing in between", async () => {
    const store = new SqliteStorage(":memory:");
    await store.init();
    await store.saveOntology(seedOntology());
    const SECRET = "narrow-credential-key";
    // biome-ignore lint/style/noNonNullAssertion: SECRET is a literal.
    const signer = credentialSigner(SECRET)!;
    const token = (
      await signer.mint({
        name: "slack-sync",
        scopes: ["*:fact:write", "*:*:read"],
        ns: null,
      })
    ).token;
    const run = await listen(
      createServeServer({
        store,
        defaultActor: "yoke:system",
        auth: true,
        tokenSecret: SECRET,
      }),
    );
    const post = (items: unknown[]) =>
      fetch(`${run.base}/api/ingest`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ items, origin: "connector:slack" }),
      });
    try {
      const ok = await post([
        { type: "fact", externalId: "s:1", attributes: { statement: "a" } },
      ]);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ added: 1 });

      const no = await post([
        {
          type: "decision",
          externalId: "s:2",
          attributes: { conclusion: "c", rationale: "r" },
        },
      ]);
      expect(no.status).toBe(403);
      expect((await no.json()).error).toContain("type 'decision'");

      // A mixed batch is refused whole: a partial import is not how a caller should discover the
      // limit of their credential.
      const mixed = await post([
        { type: "fact", externalId: "s:3", attributes: { statement: "b" } },
        {
          type: "decision",
          externalId: "s:4",
          attributes: { conclusion: "c", rationale: "r" },
        },
      ]);
      expect(mixed.status).toBe(403);
      expect(
        (await store.listEntities({ type: "fact", limit: 10 })).items,
      ).toHaveLength(1);
    } finally {
      run.close();
      store.close();
    }
  });
});
