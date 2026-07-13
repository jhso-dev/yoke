// UI API tests (PLAN 9.2 DoD) — in-process: start createUiServer on port 0, hit the JSON API with
// fetch. No browser automation. Exercises review→verify→review-empty, conflicts/ontology/persona
// shapes, the verify audit row, and GET / serving the four-tab HTML.

import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../adapters/storage-sqlite/index.js";
import { commit } from "../../core/commit.js";
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

  server = createUiServer({ store, actor: "reviewer", now: () => now });
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
  });

  it("GET / serves the HTML with all four tab markers", async () => {
    const res = await fetch(base + "/");
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    for (const tab of ["review", "conflicts", "ontology", "persona"]) {
      expect(body).toContain(`data-tab="${tab}"`);
    }
  });

  it("unknown route → 404", async () => {
    const res = await fetch(base + "/api/nope");
    expect(res.status).toBe(404);
  });
});
