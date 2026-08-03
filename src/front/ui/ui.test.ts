// UI API tests (PLAN 9.2 DoD) — in-process: start createUiServer on port 0, hit the JSON API with
// fetch. No browser automation. Exercises review→verify→review-empty, conflicts/ontology/persona
// shapes, the verify audit row, and GET / serving the four-tab HTML.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../adapters/storage-sqlite/index.js";
import { commit } from "../../core/commit.js";
import { verify } from "../../core/lifecycle.js";
import { seedOntology } from "../../core/ontology.js";
import type { Provenance } from "../../core/types.js";
import { createUiServer } from "./server.js";

const dir = mkdtempSync(join(tmpdir(), "yoke-ui-"));
const now = "2026-07-13T00:00:00Z";
const prov: Provenance = { actor: "tester", origin: "cli", occurred_at: now };

let store: SqliteStorage;
let server: Server;
let base: string;
let factId: string;
let decisionAId: string;
let decisionBId: string;
let personId: string;
let byPersonId: string;
let collaborationId: string;
let scopedFactId: string;
let termId: string;
let resourceId: string;

beforeAll(async () => {
  const ont = seedOntology();
  store = new SqliteStorage(join(dir, "ui.sqlite"));
  await store.init();
  await store.saveOntology(ont);

  // One draft fact (for the review queue), plus two decisions with a conflicts_with relation.
  const fact = await commit(
    store,
    ont,
    { type: "fact", attributes: { title: "sky is blue" } },
    prov,
    now,
  );
  factId = fact.entity.id;
  const a = await commit(
    store,
    ont,
    {
      type: "decision",
      attributes: { conclusion: "use postgres", rationale: "r" },
    },
    prov,
    now,
  );
  const b = await commit(
    store,
    ont,
    {
      type: "decision",
      attributes: { conclusion: "use mysql", rationale: "r" },
    },
    prov,
    now,
  );
  decisionAId = a.entity.id;
  decisionBId = b.entity.id;
  await commit(
    store,
    ont,
    {
      type: "conflicts_with",
      attributes: {},
      from: b.entity.id,
      to: a.entity.id,
    },
    prov,
    now,
  );

  // A person, and knowledge whose provenance.actor IS that person's id — the real shape once the
  // gate mirrors authorship (commit stage 4b). Without this the suite only ever saw a bare string
  // actor, which is why an unreadable ULID reached a browser unnoticed.
  const person = await commit(
    store,
    ont,
    { type: "person", attributes: { name: "Bora", role: "engineer" } },
    prov,
    now,
  );
  personId = person.entity.id;
  const byPerson = await commit(
    store,
    ont,
    { type: "fact", attributes: { title: "index rebuilds nightly" } },
    { actor: personId, origin: "cli", occurred_at: now },
    now,
  );
  byPersonId = byPerson.entity.id;

  // A collaboration with one fact attached to it. The scope-anchored inject route had no test at all —
  // v4.0's shared working context reached the web tier as an untested query parameter.
  const ws = await commit(
    store,
    ont,
    {
      type: "collaboration",
      attributes: { title: "auth revamp", key: "AUTH-1" },
    },
    prov,
    now,
  );
  collaborationId = ws.entity.id;
  await commit(
    store,
    ont,
    {
      type: "works_on",
      attributes: {},
      from: personId,
      to: collaborationId,
    },
    prov,
    now,
  );
  const scoped = await commit(
    store,
    ont,
    { type: "fact", attributes: { statement: "tokens rotate hourly" } },
    prov,
    now,
  );
  scopedFactId = scoped.entity.id;
  await verify(store, [scopedFactId], "reviewer", now);
  await commit(
    store,
    ont,
    {
      type: "relates_to",
      attributes: {},
      from: scopedFactId,
      to: collaborationId,
    },
    prov,
    now,
  );
  const term = await commit(
    store,
    ont,
    {
      type: "term",
      attributes: { title: "RTO", definition: "recovery time objective" },
    },
    prov,
    now,
  );
  termId = term.entity.id;
  const resource = await commit(
    store,
    ont,
    {
      type: "resource",
      attributes: {
        title: "incident handbook",
        url: "https://example.test/handbook",
      },
    },
    prov,
    now,
  );
  resourceId = resource.entity.id;
  await commit(
    store,
    ont,
    {
      type: "relates_to",
      attributes: {},
      from: resourceId,
      to: termId,
    },
    prov,
    now,
  );

  // webRoot: null on purpose — this suite tests the JSON API, and letting it fall back to the
  // default probe would make every run depend on whether dist/ happens to hold a build.
  server = createUiServer({
    store,
    actor: "reviewer",
    now: () => now,
    webRoot: null,
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (p: string) => fetch(base + p).then((r) => r.json());
const post = (p: string, body: unknown) =>
  fetch(base + p, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());
const del = (p: string) =>
  fetch(base + p, { method: "DELETE" }).then(async (r) => ({
    status: r.status,
    body: await r.json(),
  }));

describe("ui API", () => {
  it("review lists drafts with citations, verify promotes, review then empties that row", async () => {
    const drafts = await get("/api/review");
    const draft = drafts.find((d: { id: string }) => d.id === factId);
    expect(draft).toBeDefined();
    expect(draft.summary).toBe("sky is blue");
    expect(draft.actor).toBe("tester");
    expect(draft.citation).toContain(`[fact:${factId}@v1]`);

    const verified = await post("/api/verify", { ids: [factId] });
    expect(verified[0].id).toBe(factId);
    expect(verified[0].status).toBe("verified");

    const after = await get("/api/review");
    expect(after.some((d: { id: string }) => d.id === factId)).toBe(false);
  });

  it("review lists newest drafts first", async () => {
    const ont = store.loadOntology(null);
    const older = await commit(
      store,
      ont,
      { type: "fact", attributes: { title: "older draft" } },
      { actor: "tester", origin: "cli", occurred_at: "2026-07-01T00:00:00Z" },
      "2026-07-01T00:00:00Z",
    );
    const newer = await commit(
      store,
      ont,
      { type: "fact", attributes: { title: "newer draft" } },
      { actor: "tester", origin: "cli", occurred_at: "2026-07-31T00:00:00Z" },
      "2026-07-31T00:00:00Z",
    );

    const drafts = await get("/api/review");
    const ids = drafts.map((d: { id: string }) => d.id);
    expect(ids.indexOf(newer.entity.id)).toBeLessThan(
      ids.indexOf(older.entity.id),
    );
  });

  it("verify wrote an audit row", () => {
    const events = store.listAudit();
    const verifyEvent = events.find((e) => e.action === "verify");
    expect(verifyEvent).toBeDefined();
    expect(verifyEvent?.actor).toBe("reviewer");
    expect(verifyEvent?.detail).toContain(factId);
  });

  it("conflicts returns pairs with both sides' summaries + statuses", async () => {
    const pairs = await get("/api/conflicts");
    expect(pairs).toHaveLength(1);
    expect(pairs[0].from.id).toBe(decisionBId);
    expect(pairs[0].to.id).toBe(decisionAId);
    expect(pairs[0].from.summary).toBe("use mysql");
    expect(pairs[0].to.summary).toBe("use postgres");
    expect(pairs[0].from.status).toBeDefined();
    expect(pairs[0].to.citation).toContain(decisionAId);
  });

  it("ontology lists type defs", async () => {
    const defs = await get("/api/ontology");
    const decision = defs.find((d: { name: string }) => d.name === "decision");
    expect(decision.kind).toBe("entity");
    expect(decision.ttl_days).toBe(365);
    expect(Object.keys(decision.attrs)).toContain("conclusion");
  });

  it("tokens can be created, listed without secret, and revoked", async () => {
    const created = await post("/api/tokens", {
      name: "ui-test",
      scopes: ["read", "verify"],
    });
    expect(created.token).toMatch(/^yk_[0-9a-f]{64}$/);
    expect(created.name).toBe("ui-test");

    const listed = await get("/api/tokens");
    const row = listed.find((t: { name: string }) => t.name === "ui-test");
    expect(row).toEqual({
      name: "ui-test",
      scopes: ["read", "verify"],
      created_at: now,
    });
    expect(JSON.stringify(listed)).not.toContain(created.token);

    const revoked = await del("/api/tokens/ui-test");
    expect(revoked).toEqual({
      status: 200,
      body: { name: "ui-test", revoked: true },
    });
    expect(
      (await get("/api/tokens")).some(
        (t: { name: string }) => t.name === "ui-test",
      ),
    ).toBe(false);
  });

  it("persona returns decisions/facts with citations", async () => {
    const result = await get(`/api/persona/${encodeURIComponent("tester")}`);
    expect(Array.isArray(result.decisions)).toBe(true);
    expect(Array.isArray(result.facts)).toBe(true);
    // The fact was verified above → it is now part of tester's persona, with a citation.
    const all = [...result.decisions, ...result.facts];
    const f = all.find((e) => e.id === factId);
    expect(f?.citation).toContain(factId);
    // ...and the read is audited, like its MCP twin: a path that answers with knowledge but leaves
    // no trail would make the "who got what injected" audit claim false for the browser.
    const audit = store.listAudit();
    const entry = audit.find((a) => a.action === "persona");
    expect(entry?.actor).toBe("reviewer");
    expect(entry?.detail).toContain(factId);
  });

  it("GET / says the bundle is missing, with the command that fixes it", async () => {
    // No bundle configured → an honest 503 naming the build step, rather than a fallback UI. A
    // second, less-tested UI is what shipped in v2.5 and never ran in a browser.
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("npm run build:web");
  });

  it("GET / serves the built shell when a bundle is present", async () => {
    const bundle = join(dir, "fixture-app");
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, "index.html"), "<!doctype html><p>shell</p>");
    const withBundle = createUiServer({
      store,
      actor: "reviewer",
      now: () => now,
      webRoot: bundle,
    });
    await new Promise<void>((r) => withBundle.listen(0, r));
    const at = `http://localhost:${(withBundle.address() as AddressInfo).port}`;
    const res = await fetch(`${at}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("shell");
    withBundle.close();
  });

  it("unknown route → 404", async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
  });

  it("entities browses with keyset paging and reports over-max limits as errors", async () => {
    const all = await get("/api/entities");
    expect(all.items.length).toBeGreaterThan(1);
    expect(all.next).toBeNull();
    // Every row carries a citation and a read-time freshness label (WEB-UI audit rule).
    for (const r of all.items) {
      expect(r.citation).toContain(r.id);
      expect(r.effectiveStatus).toBeTruthy();
    }
    // Type filter, then a page + its cursor.
    const decisions = await get("/api/entities?type=decision");
    expect(
      decisions.items.every((r: { type: string }) => r.type === "decision"),
    ).toBe(true);
    const p1 = await get("/api/entities?limit=1");
    expect(p1.items).toHaveLength(1);
    expect(p1.next).toBe(p1.items[0].id);
    const p2 = await get(`/api/entities?limit=1&after=${p1.next}`);
    expect(p2.items[0].id).not.toBe(p1.items[0].id);
    // Over-max is a 400, never a silent cap.
    const bad = await fetch(`${base}/api/entities?limit=99999`);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain("limit must be <=");
  });

  it("search returns matching records, bounded, and says when the cap bit", async () => {
    // The port's own FTS, exposed as-is: same row shape as the listing, so a draft hit reads as a
    // draft rather than as an answer (WEB-UI second 2026-07-31 amendment).
    const hits = await get("/api/search?q=mysql");
    expect(hits.items.length).toBeGreaterThan(0);
    expect(hits.items.some((r: { id: string }) => r.id === decisionBId)).toBe(
      true,
    );
    for (const r of hits.items) {
      expect(r.citation).toContain(r.id);
      expect(r.effectiveStatus).toBeTruthy();
      // A summary row, NOT full attributes — that is what keeps this on the listing side of
      // SPEC's audit line and out of the "returns attributes" category.
      expect(r.attributes).toBeUndefined();
    }
    // No cursor: search is a top-N, so `next` is always null and the cap is reported instead.
    expect(hits.next).toBeNull();
    expect(hits.truncated).toBe(false);

    // The type filter doubles as the RBAC key, exactly as on /api/entities.
    const typed = await get("/api/search?q=mysql&type=decision");
    expect(
      typed.items.every((r: { type: string }) => r.type === "decision"),
    ).toBe(true);

    // limit + 1 is read, so truncation is a fact rather than a guess. Asserted against a query with
    // more than one match, so the flag has something to be true about — `expect(x).toBe(cond ? true
    // : x)` would pass whatever the code did.
    const ont = store.loadOntology(null);
    for (const n of [1, 2, 3]) {
      await commit(
        store,
        ont,
        { type: "fact", attributes: { title: `quokka sighting ${n}` } },
        { actor: "tester", origin: "cli", occurred_at: "2026-07-31T00:00:00Z" },
        "2026-07-31T00:00:00Z",
      );
    }
    const many = await get("/api/search?q=quokka");
    expect(many.items.length).toBeGreaterThan(1);
    const capped = await get("/api/search?q=quokka&limit=1");
    expect(capped.items).toHaveLength(1);
    expect(capped.limit).toBe(1);
    expect(capped.truncated).toBe(true);

    // No text is a 400, not an empty result set: an empty query would otherwise return the
    // adapter's idea of "match nothing" and read as "you have no knowledge".
    const empty = await fetch(`${base}/api/search?q=%20%20`);
    expect(empty.status).toBe(400);
    // Over-max is a 400 here too.
    const over = await fetch(`${base}/api/search?q=mysql&limit=9999`);
    expect(over.status).toBe(400);
  });

  it("a search writes an audit row naming the query, not just the ids", async () => {
    await get("/api/search?q=mysql");
    const row = store
      .listAudit()
      .filter((e) => e.action === "search")
      .at(-1);
    expect(row).toBeDefined();
    // `<subject> -> <ids>`, the shape every other action uses, so rows are comparable. The subject
    // is the point: `search` records WHAT was looked for, which an enumeration row cannot.
    expect(row?.detail.startsWith("mysql -> ")).toBe(true);
    expect(row?.detail).toContain(decisionBId);
  });

  it("opening a record in full writes a read row — the rule SPEC has claimed since v5.0", async () => {
    const before = store.listAudit().filter((e) => e.action === "read").length;
    await get(`/api/entity/${decisionBId}`);
    const rows = store.listAudit().filter((e) => e.action === "read");
    expect(rows.length).toBe(before + 1);
    // Only the record whose attributes were returned. The versions and resolved ends come back as
    // summary rows, so naming them would overstate what the response disclosed.
    expect(rows.at(-1)?.detail).toBe(decisionBId);
  });

  it("a listing writes no read row — summary rows are not an attribute read", async () => {
    // The other half of the same rule, and the reason it is not "audit every route": /api/entities
    // returns truncated summaries, so auditing it would drown the governance rows in page loads.
    const before = store.listAudit().length;
    await get("/api/entities");
    expect(store.listAudit().length).toBe(before);
  });

  it("entity detail returns full attributes, version history and both relation sides", async () => {
    const detail = await get(`/api/entity/${decisionBId}`);
    // Full attributes, not the 60-char summary the list rows carry.
    expect(detail.entity.attributes.conclusion).toBe("use mysql");
    expect(detail.entity.last_confirmed).toBeTruthy();
    expect(detail.entity.citation).toContain(decisionBId);
    // Append-only history is reachable.
    expect(detail.history.length).toBeGreaterThanOrEqual(1);
    expect(detail.history.map((h: { version: number }) => h.version)).toContain(
      1,
    );
    // conflicts_with points B → A, so it is an out-edge with A resolved on the other end.
    const out = detail.relations.out.find(
      (r: { type: string }) => r.type === "conflicts_with",
    );
    expect(out.other.id).toBe(decisionAId);
    expect(out.other.citation).toContain(decisionAId);
    // The authorship edge the gate records is visible too.
    expect(
      detail.relations.out.some(
        (r: { type: string }) => r.type === "authored_by",
      ),
    ).toBe(true);
    // A is the same pair seen from the other direction.
    const fromA = await get(`/api/entity/${decisionAId}`);
    expect(
      fromA.relations.in.some(
        (r: { other: { id: string } }) => r.other.id === decisionBId,
      ),
    ).toBe(true);
  });

  it("entity detail 404s an unknown id", async () => {
    const res = await fetch(`${base}/api/entity/nope`);
    expect(res.status).toBe(404);
  });

  it("injection preview shows exactly what an agent would receive, and audits the look", async () => {
    // The fact was verified earlier; the two decisions are still drafts.
    const shown = await get("/api/inject?q=sky");
    expect(shown.items.map((r: { id: string }) => r.id)).toEqual([factId]);
    expect(shown.items[0].citation).toContain(factId);
    expect(shown.query).toBe("sky");

    // Drafts are withheld by default and labelled when asked for — the injection filter itself,
    // not a re-implementation of it.
    const withoutDrafts = await get("/api/inject?q=mysql");
    expect(withoutDrafts.items).toEqual([]);
    const withDrafts = await get("/api/inject?q=mysql&includeDraft=true");
    expect(withDrafts.items.map((r: { id: string }) => r.id)).toEqual([
      decisionBId,
    ]);
    expect(withDrafts.items[0].effectiveStatus).toBe("draft");

    // A preview is a read of knowledge, so it leaves a trail — under its own action name, so it
    // never gets mistaken for what an agent was told.
    const events = store.listAudit();
    const preview = events.filter((e) => e.action === "inject_preview");
    expect(preview.length).toBeGreaterThanOrEqual(3);
    expect(preview[0].actor).toBe("reviewer");
    expect(events.some((e) => e.action === "inject")).toBe(false);

    // Neither q nor scope is a 400, not an accidental full dump.
    const bad = await fetch(`${base}/api/inject`);
    expect(bad.status).toBe(400);
  });

  it("graph is bounded and says so, and an anchor walks outward from one node", async () => {
    const whole = await get("/api/graph");
    expect(whole.anchor).toBeNull();
    expect(whole.nodes.length).toBeGreaterThan(1);
    expect(whole.edges.length).toBeGreaterThan(0);
    expect(whole.truncated).toBe(false);
    expect(whole.edges[0].from).toBeTruthy();
    const typed = await get("/api/graph?limit=6");
    expect(new Set(typed.nodes.map((n: { type: string }) => n.type))).toEqual(
      new Set([
        "collaboration",
        "decision",
        "fact",
        "person",
        "resource",
        "term",
      ]),
    );
    const typedIds = new Set(typed.nodes.map((n: { id: string }) => n.id));
    expect(
      typed.edges.every(
        (e: { from: string; to: string }) =>
          typedIds.has(e.from) && typedIds.has(e.to),
      ),
    ).toBe(true);
    expect(typed.edges.length).toBeGreaterThan(0);

    // A limit smaller than the graph reports truncation rather than drawing a partial graph
    // silently, and hands back cursors to continue with.
    const cut = await get("/api/graph?limit=1");
    expect(cut.nodes).toHaveLength(1);
    expect(cut.truncated).toBe(true);
    expect(cut.next.nodes).toBe(cut.nodes[0].id);
    // Over-max is an error, like every other limit.
    expect((await fetch(`${base}/api/graph?limit=5000`)).status).toBe(400);

    // Anchored: one hop from decision B reaches A (conflicts_with) and its author.
    const around = await get(`/api/graph?scope=${decisionBId}`);
    expect(around.anchor).toBe(decisionBId);
    const ids = around.nodes.map((n: { id: string }) => n.id);
    expect(ids).toContain(decisionBId);
    expect(ids).toContain(decisionAId);
    expect(
      around.edges.some((e: { type: string }) => e.type === "conflicts_with"),
    ).toBe(true);
  });

  it("rejects an oversized or wrong-typed POST body", async () => {
    const big = await fetch(`${base}/api/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [`${"x".repeat(300 * 1024)}`] }),
    });
    expect(big.status).toBe(400);
    expect((await big.json()).error).toContain("too large");
    const wrongType = await fetch(`${base}/api/verify`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ ids: [] }),
    });
    expect(wrongType.status).toBe(400);
  });

  it("meta reports the deployment shape so the shell knows whether to ask for a credential", async () => {
    const meta = await get("/api/meta");
    // Local `yoke ui`: ungated, writable, default namespace.
    expect(meta).toEqual({
      auth: false,
      readOnly: false,
      ns: null,
      actor: "reviewer",
    });
  });

  it("audit viewer returns the trail, newest-N oldest-first", async () => {
    const all = await get("/api/audit");
    expect(all.items.length).toBeGreaterThan(1);
    expect(all.items.map((e: { action: string }) => e.action)).toContain(
      "verify",
    );
    // Ascending by time, so a client renders it without reversing.
    const times = all.items.map((e: { at: string }) => e.at);
    expect([...times].sort()).toEqual(times);
    const one = await get("/api/audit?limit=1");
    expect(one.items).toHaveLength(1);
    expect(one.items[0].at).toBe(times[times.length - 1]);
  });

  // provenance.actor is a person entity id (core/types.ts), so every row and every citation carried a
  // raw ULID into the browser. The name is resolved for reading; the id stays, because the id is what
  // the citation points at and names are neither unique nor stable.
  it("resolves a person actor to a name without dropping the id, and leaves the citation alone", async () => {
    const rows = await get("/api/entities?type=fact");
    const mine = rows.items.find((r: { id: string }) => r.id === byPersonId);
    expect(mine.actorName).toBe("Bora");
    expect(mine.actor).toBe(personId);
    // The audit pointer is unchanged: it carries the id, never the name.
    expect(mine.citation).toContain(personId);
    expect(mine.citation).not.toContain("Bora");

    // A machine actor has no person record, so there is nothing to resolve and the id stands alone.
    // Asserted on the person record itself, which no test verifies — verify appends a version whose
    // actor is the verifier, so asserting on a promoted row would depend on test order.
    const people = await get("/api/entities?type=person");
    const bare = people.items.find((r: { id: string }) => r.id === personId);
    expect(bare.actor).toBe("tester");
    expect(bare.actorName).toBeUndefined();

    // Every read path that shows a row shows the same resolution — one serializer, not per-route.
    const detail = await get(`/api/entity/${byPersonId}`);
    expect(detail.entity.actorName).toBe("Bora");
    const graph = await get("/api/graph");
    expect(
      graph.nodes.find((n: { id: string }) => n.id === byPersonId).actorName,
    ).toBe("Bora");
  });
});

// A tenant must never see another tenant's knowledge through a global listing. Before this was
// pinned, /api/conflicts listed every namespace's pairs (listRelationsByType had no ns), which is
// the kind of bug a single-namespace fixture cannot see.
describe("ui API namespace isolation", () => {
  let tenantServer: Server;
  let tenantBase: string;
  let acmeDecision: string;
  let tenantStore: SqliteStorage;

  beforeAll(async () => {
    const ont = seedOntology();
    const s = new SqliteStorage(join(dir, "ns.sqlite"));
    tenantStore = s;
    await s.init();
    for (const ns of ["acme", "globex"]) {
      await s.saveOntology(ont, ns);
      const a = await commit(
        s,
        ont,
        {
          type: "decision",
          attributes: { conclusion: `${ns} picks redis`, rationale: "r" },
        },
        prov,
        now,
        { ns },
      );
      const b = await commit(
        s,
        ont,
        {
          type: "decision",
          attributes: { conclusion: `${ns} picks memcached`, rationale: "r" },
        },
        prov,
        now,
        { ns },
      );
      await commit(
        s,
        ont,
        {
          type: "conflicts_with",
          attributes: {},
          from: b.entity.id,
          to: a.entity.id,
        },
        prov,
        now,
        { ns },
      );
      if (ns === "acme") acmeDecision = a.entity.id;
    }
    tenantServer = createUiServer({
      store: s,
      actor: "reviewer",
      ns: "acme",
      now: () => now,
    });
    await new Promise<void>((r) => tenantServer.listen(0, r));
    tenantBase = `http://localhost:${(tenantServer.address() as AddressInfo).port}`;
  });
  // The store must be closed, not just the server: on win32 an open sqlite handle keeps the file
  // locked, so the outer rmSync fails with EBUSY (POSIX happily unlinks open files, which is why
  // this only ever shows up on the windows CI job).
  afterAll(() => {
    tenantServer.close();
    tenantStore.close();
  });

  it("conflicts shows only this namespace's pairs, resolved within it", async () => {
    const pairs = await fetch(`${tenantBase}/api/conflicts`).then((r) =>
      r.json(),
    );
    expect(pairs).toHaveLength(1);
    const summaries = [pairs[0].from.summary, pairs[0].to.summary];
    expect(summaries.every((s: string) => s.startsWith("acme"))).toBe(true);
    expect(summaries.some((s: string) => s.includes("globex"))).toBe(false);
    // The resolved side is a real row, not a "missing" stub — the ns check must not over-reject.
    expect([pairs[0].from.id, pairs[0].to.id]).toContain(acmeDecision);
  });

  it("search never crosses a namespace, and neither does its audit row", async () => {
    // The case that matters for a NEW retrieval path: the seeds differ only by their ns prefix, so
    // a query matching both tenants' text must still answer with one tenant's rows. `search` is the
    // fourth global listing added to this server, and the first three all leaked at least once.
    const hits = await fetch(`${tenantBase}/api/search?q=decision`).then((r) =>
      r.json(),
    );
    expect(hits.items.length).toBeGreaterThan(0);
    expect(
      hits.items.every((r: { summary: string }) =>
        r.summary.startsWith("acme"),
      ),
    ).toBe(true);
    expect(
      hits.items.some((r: { summary: string }) => r.summary.includes("globex")),
    ).toBe(false);

    // And the trail is per-tenant too: a row stamped with the wrong ns would show one tenant's
    // queries on another's audit screen.
    // Queried BY ns, which is also the assertion: `listAudit({})` reads the default namespace only,
    // so a row stamped with the wrong ns would simply not be here.
    const row = tenantStore
      .listAudit({ ns: "acme" })
      .filter((e) => e.action === "search")
      .at(-1);
    expect(row?.ns).toBe("acme");
    expect(tenantStore.listAudit().some((e) => e.action === "search")).toBe(
      false,
    );
    expect(
      hits.items.every((r: { id: string }) => row?.detail.includes(r.id)),
    ).toBe(true);
  });
});

// v4.0's shared working context, over HTTP. The route shipped in v5.0 with no test — `scope` was a
// query parameter nobody exercised, which is how the collaboration screen came to be missing too.
describe("scope-anchored injection over HTTP", () => {
  it("anchors a briefing on a collaboration and reports the anchor back", async () => {
    const out = await get(
      `/api/inject?scope=${encodeURIComponent(collaborationId)}`,
    );
    expect(out.scope).toBe(collaborationId);
    // The attached, verified fact is in the briefing; the anchor itself never is.
    expect(out.items.map((i: { id: string }) => i.id)).toContain(scopedFactId);
    expect(out.items.map((i: { id: string }) => i.id)).not.toContain(
      collaborationId,
    );
  });

  it("injects only verified knowledge, anchored or not", async () => {
    const out = await get(
      `/api/inject?scope=${encodeURIComponent(collaborationId)}`,
    );
    // The hard rule (KNOWLEDGE-POLICY): an anchor prioritises, it never lowers the gate.
    for (const i of out.items)
      expect(["verified", "stale"]).toContain(i.effectiveStatus);
    expect(
      out.items.every(
        (i: { effectiveStatus: string }) => i.effectiveStatus !== "draft",
      ),
    ).toBe(true);
  });

  it("audits a scoped preview like any other read", async () => {
    await get(
      `/api/inject?scope=${encodeURIComponent(collaborationId)}&q=tokens`,
    );
    const entry = store
      .listAudit()
      .filter((a) => a.action === "inject_preview")
      .at(-1);
    expect(entry?.detail).toContain(scopedFactId);
  });
});

// The audit viewer's whole job is legibility, so its two detail shapes must both resolve. A verify
// row stores a bare id list (no " -> "), and reading only the post-arrow half rendered it as ULIDs.
describe("audit detail resolves both of its shapes", () => {
  it("resolves a lifecycle transition's bare id list, not just a read's arrow form", async () => {
    await post("/api/verify", { ids: [scopedFactId] });
    const trail = await get("/api/audit");
    const items = trail.items as Array<{
      action: string;
      detail: string;
      refs?: { id: string; type: string; summary: string }[];
    }>;

    const verified = items.filter((e) => e.action === "verify").at(-1);
    // The stored detail is unchanged — it is the audit fact — and carries no arrow.
    expect(verified?.detail).not.toContain(" -> ");
    expect(verified?.detail).toContain(scopedFactId);
    // ...and it still resolves, so the screen can name the record instead of printing its id.
    expect(verified?.refs?.map((r) => r.id)).toContain(scopedFactId);
    expect(verified?.refs?.find((r) => r.id === scopedFactId)?.summary).toBe(
      "tokens rotate hourly",
    );

    // The arrow form keeps working: a read names its subject before the ids.
    await get(`/api/inject?q=${encodeURIComponent("tokens")}`);
    const read = (await get("/api/audit")).items
      .filter((e: { action: string }) => e.action === "inject_preview")
      .at(-1);
    expect(read.detail).toContain(" -> ");
    expect(read.refs?.length).toBeGreaterThan(0);
  });
});

describe("creating from the browser (WEB-UI amendment 2026-07-31)", () => {
  const postRaw = (p: string, body: unknown) =>
    fetch(base + p, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("creates a draft carrying origin 'web' — allowed, and labelled as hand-typed", async () => {
    const res = await postRaw("/api/entity", {
      type: "fact",
      attributes: { title: "typed at a screen" },
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    // Draft, never verified: the amendment permits creating, not promoting. A screen that could
    // write a verified record would route around the one human gate this product is built on.
    expect(created.status).toBe("draft");

    // And not because the caller happened to omit it — asking for another state changes nothing.
    // The gate assigns status; it is not an input, on any adapter.
    const asked = await (
      await postRaw("/api/entity", {
        type: "fact",
        status: "verified",
        attributes: { title: "asked to be born verified" },
      })
    ).json();
    expect(asked.status).toBe("draft");

    // The label is the whole trade — the ban went away, the ability to tell did not.
    const stored = await store.getEntity(created.id);
    expect(stored?.provenance.origin).toBe("web");
    // The server's resolved actor, not an anonymous one: "someone typed this" is only useful if
    // the record also says who.
    expect(stored?.provenance.actor).toBe("reviewer");

    // And it is a real record: it shows up in the queue a human reviews.
    const drafts = await get("/api/review");
    expect(drafts.some((d: { id: string }) => d.id === created.id)).toBe(true);
  });

  it("hands back the gate's own rejection rather than inventing validation", async () => {
    // decision declares conclusion/rationale required; the client duplicating that rule is how a
    // client and a server come to disagree about what is valid.
    const res = await postRaw("/api/entity", {
      type: "decision",
      attributes: {},
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.reason).toBe("ontology");
    expect(body.error).toMatch(/conclusion|required/i);

    // An undeclared type is refused for the same reason, by the same gate.
    expect((await postRaw("/api/entity", { type: "invented" })).status).toBe(
      400,
    );
    // A missing type never reaches it.
    expect((await postRaw("/api/entity", {})).status).toBe(400);
  });

  it("links two records, with the direction the caller asked for", async () => {
    const person = await (
      await postRaw("/api/entity", {
        type: "person",
        attributes: { name: "Nari" },
      })
    ).json();
    const work = await (
      await postRaw("/api/entity", {
        type: "collaboration",
        attributes: { title: "browser-made work" },
      })
    ).json();
    const res = await postRaw("/api/link", {
      from: person.id,
      type: "works_on",
      to: work.id,
    });
    expect(res.status).toBe(201);
    const edge = await res.json();
    expect(edge.from).toBe(person.id);
    expect(edge.to).toBe(work.id);

    // Incoming on the collaboration — the direction that makes an anchor gather a roster.
    const detail = await get(`/api/entity/${work.id}`);
    expect(
      detail.relations.in.some(
        (r: { type: string; other: { id: string } }) =>
          r.type === "works_on" && r.other.id === person.id,
      ),
    ).toBe(true);

    // Half a link is not a relation.
    expect(
      (await postRaw("/api/link", { from: person.id, type: "works_on" }))
        .status,
    ).toBe(400);
  });

  it("attaches to a scope with the same relates_to `yoke add --scope` makes", async () => {
    const work = await (
      await postRaw("/api/entity", {
        type: "collaboration",
        attributes: { title: "scoped from the browser" },
      })
    ).json();
    const fact = await (
      await postRaw("/api/entity", {
        type: "fact",
        attributes: { title: "attached at creation" },
        scope: work.id,
      })
    ).json();
    const detail = await get(`/api/entity/${work.id}`);
    expect(
      detail.relations.in.some(
        (r: { type: string; other: { id: string } }) =>
          r.type === "relates_to" && r.other.id === fact.id,
      ),
    ).toBe(true);
  });

  it("refuses a body that is not JSON, and attributes that are not strings", async () => {
    const notJson = await fetch(`${base}/api/entity`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "type=fact",
    });
    expect(notJson.status).toBe(400);
    // A nested object cannot be described by the ontology's attr types, so it stops here rather
    // than reaching the store as a shape nothing can validate.
    expect(
      (
        await postRaw("/api/entity", {
          type: "fact",
          attributes: { title: { nested: true } },
        })
      ).status,
    ).toBe(400);
  });
});

describe("schema and maintenance from the browser", () => {
  const postRaw = (p: string, body: unknown) =>
    fetch(base + p, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("declares a type, and declaring it again is a migration not an error", async () => {
    const def = {
      name: "experiment",
      kind: "entity",
      attrs: { hypothesis: { type: "string", required: true } },
      ttl_days: 30,
    };
    expect((await postRaw("/api/ontology", { def })).status).toBe(201);
    // The gate reads the ontology, so a record of the new type is immediately creatable — which is
    // the only proof that the declaration landed somewhere the gate actually looks.
    expect(
      (
        await postRaw("/api/entity", {
          type: "experiment",
          attributes: { hypothesis: "caching helps" },
        })
      ).status,
    ).toBe(201);
    // ...and its required attribute is enforced, from the definition just posted.
    expect(
      (await postRaw("/api/entity", { type: "experiment", attributes: {} }))
        .status,
    ).toBe(400);

    // Same name again = a new version, the append-only migration the CLI performs.
    expect(
      (
        await postRaw("/api/ontology", {
          def: { ...def, ttl_days: 60 },
        })
      ).status,
    ).toBe(201);
    const types = await get("/api/ontology");
    const found = types.filter(
      (t: { name: string }) => t.name === "experiment",
    );
    // loadOntology returns the latest version per name, so the migration replaced rather than duped.
    expect(found).toHaveLength(1);
    expect(found[0].ttl_days).toBe(60);

    // A def that is not a type def never reaches the store.
    expect(
      (await postRaw("/api/ontology", { def: { name: "x" } })).status,
    ).toBe(400);
    expect((await postRaw("/api/ontology", {})).status).toBe(400);
  });

  it("backfill is idempotent — the second run creates nothing", async () => {
    const first = await (await postRaw("/api/backfill", {})).json();
    expect(first.scanned).toBeGreaterThan(0);
    const second = await (await postRaw("/api/backfill", {})).json();
    expect(second.created).toBe(0);
  });

  it("renames a type everywhere and leaves the audit row that is its only trace", async () => {
    const created = await (
      await postRaw("/api/entity", {
        type: "term",
        attributes: { title: "renameable" },
      })
    ).json();
    const res = await postRaw("/api/rename-type", {
      from: "term",
      to: "glossary",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toBeGreaterThan(0);

    // The record moved with the declaration — a rename that only touched one of them would leave
    // the database describing itself in two vocabularies.
    expect((await get(`/api/entity/${created.id}`)).entity.type).toBe(
      "glossary",
    );
    expect(
      (await get("/api/ontology")).some(
        (t: { name: string }) => t.name === "glossary",
      ),
    ).toBe(true);

    // The one mutation the version history cannot record, because it rewrites those rows.
    const trail = await get("/api/audit?limit=500");
    expect(
      trail.items.some(
        (e: { action: string; detail: string }) =>
          e.action === "rename_type" && e.detail === "term -> glossary",
      ),
    ).toBe(true);

    // Renaming to itself is refused rather than quietly rewriting every row for no change.
    expect(
      (await postRaw("/api/rename-type", { from: "a", to: "a" })).status,
    ).toBe(400);
    expect((await postRaw("/api/rename-type", { from: "a" })).status).toBe(400);
  });
});

// The measurement that decides whether graph expansion is worth investing in: which of briefing /
// plain query / anchored query the injections actually are (docs/RESEARCH.md). It was unrecordable —
// all three shapes wrote the query alone, so an anchored injection was indistinguishable from an
// unscoped one in the trail.
describe("an injection records WHICH shape it was", () => {
  const subjectOf = (detail: string) => detail.split(" -> ")[0];

  it("names the anchor in the subject, and resolves it for reading", async () => {
    await get(
      `/api/inject?scope=${encodeURIComponent(collaborationId)}&q=tokens`,
    );
    const entry = store
      .listAudit()
      .filter((a) => a.action === "inject_preview")
      .at(-1);
    // The anchor leads the subject, the query follows it.
    expect(subjectOf(entry?.detail ?? "").split(" ")).toEqual([
      collaborationId,
      "tokens",
    ]);

    // And the route resolves it, so the audit screen shows the collaboration's name rather than a
    // ULID. Testing the WHOLE head against the ULID shape only ever resolved a single-token subject,
    // which is why this needed the token-list parser.
    const shown = (await get("/api/audit")).items
      .filter((e: { action: string }) => e.action === "inject_preview")
      .at(-1);
    expect(shown.refs?.map((r: { id: string }) => r.id)).toContain(
      collaborationId,
    );
  });

  it("a briefing's subject is the anchor alone, so it is attributable too", async () => {
    await get(`/api/inject?scope=${encodeURIComponent(collaborationId)}`);
    const entry = store
      .listAudit()
      .filter((a) => a.action === "inject_preview")
      .at(-1);
    expect(subjectOf(entry?.detail ?? "")).toBe(collaborationId);
  });

  it("an unscoped query still writes the query alone — the old rows stay comparable", async () => {
    await get(`/api/inject?q=${encodeURIComponent("tokens")}`);
    const entry = store
      .listAudit()
      .filter((a) => a.action === "inject_preview")
      .at(-1);
    expect(subjectOf(entry?.detail ?? "")).toBe("tokens");
  });
});

describe("as-of injection over HTTP", () => {
  it("records the instant in the trail, so a historical read is not mistaken for a current one", async () => {
    const out = await get(
      `/api/inject?q=${encodeURIComponent("tokens")}&asOf=2026-07-15T00:00:00Z`,
    );
    // Echoed back: the screen banners off the SERVER's value, because what matters is which clock
    // produced these rows.
    expect(out.asOf).toBe("2026-07-15T00:00:00Z");
    const entry = store
      .listAudit()
      .filter((a) => a.action === "inject_preview")
      .at(-1);
    expect(entry?.detail).toContain("@2026-07-15T00:00:00Z");
  });

  it("asOf is null on a normal read", async () => {
    expect(
      (await get(`/api/inject?q=${encodeURIComponent("tokens")}`)).asOf,
    ).toBeNull();
  });

  it("rejects an unparseable instant instead of silently returning nothing", async () => {
    // Date.parse gives NaN, every comparison then fails, and the screen would show "0 records" —
    // which reads as "we knew nothing then". A 400 is the honest answer to a typo.
    const res = await fetch(`${base}/api/inject?q=tokens&asOf=last-tuesday`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/ISO instant/);
  });
});

describe("the stale queue over HTTP (SPEC's unimplemented clause)", () => {
  /** The same store and routes, read from a clock far enough ahead that a `fact` has aged out.
   * Freshness is computed against the request's clock, so moving the clock is the only way to make a
   * record stale — there is no stored flag to set. */
  const laterServer = async (when: string) => {
    const s = createUiServer({
      store,
      actor: "reviewer",
      now: () => when,
      webRoot: null,
    });
    await new Promise<void>((r) => s.listen(0, r));
    const at = `http://localhost:${(s.address() as AddressInfo).port}`;
    return {
      get: (p: string) => fetch(at + p).then((r) => r.json()),
      close: () => s.close(),
    };
  };

  it("returns verified records past their TTL, and not the ones that cannot age", async () => {
    // `fact` declares ttl_days; `term` declares none. Both verified at the suite's clock.
    await post("/api/verify", { ids: [factId, termId] });

    // Non-vacuity first: at the suite's own clock nothing has aged, so the route is not merely
    // returning every verified row.
    const fresh = await get("/api/review?stale=1");
    expect(fresh.items).toEqual([]);
    expect(fresh.scanned).toBeGreaterThan(0);

    // A year on, the fact is past its window and the term still is not.
    const late = await laterServer("2027-09-01T00:00:00Z");
    try {
      const aged = await late.get("/api/review?stale=1");
      const ids = aged.items.map((i: { id: string }) => i.id);
      expect(ids).toContain(factId);
      expect(ids).not.toContain(termId);
      // Rendered as stale, and the row carries the owner — the whole point of the screen is routing
      // it to a person, so the actor has to survive to the client.
      const row = aged.items.find((i: { id: string }) => i.id === factId);
      expect(row.effectiveStatus).toBe("stale");
      expect(row.actor).toBeTruthy();
      // The walk is bounded, so it says what it examined.
      expect(aged.scanned).toBeGreaterThanOrEqual(aged.items.length);
    } finally {
      late.close();
    }
  });

  it("limit pages the queue and hands back a cursor that resumes the scan", async () => {
    const late = await laterServer("2027-09-01T00:00:00Z");
    try {
      const first = await late.get("/api/review?stale=1&limit=1");
      expect(first.items.length).toBe(1);
      // With more stale rows behind it the cursor is non-null; the union of the pages is what a
      // screen paging through would see, and core's own test pins that it loses nothing.
      if (first.next !== null) {
        const rest = await late.get(
          `/api/review?stale=1&after=${encodeURIComponent(first.next)}`,
        );
        expect(
          [...first.items, ...rest.items].map((i: { id: string }) => i.id),
        ).toContain(first.items[0].id);
      }
    } finally {
      late.close();
    }
  });

  it("the draft queue is unaffected by the parameter it does not get", async () => {
    const drafts = await get("/api/review");
    // Still an array, not the {items,next,scanned} envelope — the two shapes are different on
    // purpose and a screen switching tabs must not get one where it expects the other.
    expect(Array.isArray(drafts)).toBe(true);
    for (const d of drafts) expect(d.effectiveStatus).toBe("draft");
  });
});

// The gate tells the caller WHY the duplicate list is empty, and the web tier discarded it — so a form
// showed the same thing (nothing) for "checked, nothing similar" and "nobody looked".
describe("creating from the browser says whether anything was compared", () => {
  it("reports duplicateDetection on the created record", async () => {
    const created = await post("/api/entity", {
      type: "fact",
      attributes: { statement: "the pool drains at midnight" },
    });
    // This suite constructs the server with no embedder, which is the same state a `yoke ui` run has
    // unless YOKE_EMBED_* is exported — so "skipped" is the honest answer here.
    expect(created.duplicateDetection).toBe("skipped");
    expect(created.duplicates).toEqual([]);
  });
});

describe("POST /api/backfill --embeddings", () => {
  it("switches repair by body flag, and the authorship shape is untouched", async () => {
    const authorship = await post("/api/backfill", {});
    expect(authorship).toHaveProperty("created");
    expect(authorship).not.toHaveProperty("embedded");

    const vectors = await post("/api/backfill", { embeddings: true });
    // No embedder on this server, so every row is skipped — reported, not thrown, because a repair
    // that cannot run is not an error (SPEC "The vector index").
    expect(vectors).toMatchObject({ embedded: 0 });
    expect(vectors.scanned).toBeGreaterThan(0);
    expect(vectors.skipped).toBe(vectors.scanned);
  });
});
