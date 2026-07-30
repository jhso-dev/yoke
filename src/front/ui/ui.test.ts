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
let workstreamId: string;
let scopedFactId: string;

beforeAll(async () => {
  const ont = seedOntology();
  store = new SqliteStorage(join(dir, "ui.sqlite"));
  await store.init();
  store.saveOntology(ont);

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

  // A workstream with one fact attached to it. The scope-anchored inject route had no test at all —
  // v4.0's shared working context reached the web tier as an untested query parameter.
  const ws = await commit(
    store,
    ont,
    { type: "workstream", attributes: { title: "auth revamp", key: "AUTH-1" } },
    prov,
    now,
  );
  workstreamId = ws.entity.id;
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
      to: workstreamId,
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
    const res = await fetch(base + "/api/nope");
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
    const res = await fetch(base + "/api/entity/nope");
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
    const bad = await fetch(base + "/api/inject");
    expect(bad.status).toBe(400);
  });

  it("graph is bounded and says so, and an anchor walks outward from one node", async () => {
    const whole = await get("/api/graph");
    expect(whole.anchor).toBeNull();
    expect(whole.nodes.length).toBeGreaterThan(1);
    expect(whole.edges.length).toBeGreaterThan(0);
    expect(whole.truncated).toBe(false);
    expect(whole.edges[0].from).toBeTruthy();

    // A limit smaller than the graph reports truncation rather than drawing a partial graph
    // silently, and hands back cursors to continue with.
    const cut = await get("/api/graph?limit=1");
    expect(cut.nodes).toHaveLength(1);
    expect(cut.truncated).toBe(true);
    expect(cut.next.nodes).toBe(cut.nodes[0].id);
    // Over-max is an error, like every other limit.
    expect((await fetch(base + "/api/graph?limit=5000")).status).toBe(400);

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
    const big = await fetch(base + "/api/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [`${"x".repeat(300 * 1024)}`] }),
    });
    expect(big.status).toBe(400);
    expect((await big.json()).error).toContain("too large");
    const wrongType = await fetch(base + "/api/verify", {
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
      s.saveOntology(ont, ns);
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
});

// v4.0's shared working context, over HTTP. The route shipped in v5.0 with no test — `scope` was a
// query parameter nobody exercised, which is how the workstream screen came to be missing too.
describe("scope-anchored injection over HTTP", () => {
  it("anchors a briefing on a workstream and reports the anchor back", async () => {
    const out = await get(
      `/api/inject?scope=${encodeURIComponent(workstreamId)}`,
    );
    expect(out.scope).toBe(workstreamId);
    // The attached, verified fact is in the briefing; the anchor itself never is.
    expect(out.items.map((i: { id: string }) => i.id)).toContain(scopedFactId);
    expect(out.items.map((i: { id: string }) => i.id)).not.toContain(
      workstreamId,
    );
  });

  it("injects only verified knowledge, anchored or not", async () => {
    const out = await get(
      `/api/inject?scope=${encodeURIComponent(workstreamId)}`,
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
    await get(`/api/inject?scope=${encodeURIComponent(workstreamId)}&q=tokens`);
    const entry = store
      .listAudit()
      .filter((a) => a.action === "inject_preview")
      .at(-1);
    expect(entry?.detail).toContain(scopedFactId);
  });
});
