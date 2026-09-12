// MCP E2E (PLAN 3.3) — two independent client connections see the same DB (cross-session persistence).
// Uses InMemoryTransport instead of spawn (allowed): server and client are connected as a linked pair,
// but each connection opens and closes the DB file afresh, preserving the "Client A commits → close → Client B reads" scenario.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../adapters/storage-sqlite/index.js";
import { commit } from "../../core/commit.js";
import { BRIEFING_LIMIT } from "../../core/inject.js";
import { downstreamOf } from "../../core/lifecycle.js";
import { seedOntology } from "../../core/ontology.js";
import type { Provenance } from "../../core/types.js";
import { runCli } from "../cli/index.js";
import { createYokeMcpServer, resolveScope } from "./index.js";

const dir = mkdtempSync(join(tmpdir(), "yoke-mcp-"));
const db = join(dir, "yoke.db");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Open a fresh server + client against the DB file and connect them (one independent session). */
async function openSession() {
  const store = new SqliteStorage(db);
  await store.init();
  const server = createYokeMcpServer({
    store,
    ontology: store.loadOntology(),
    defaultActor: "yoke:system",
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
      store.close();
    },
  };
}

function text(r: unknown): string {
  const content = (r as { content: Array<{ type: string; text: string }> })
    .content;
  return content.map((c) => c.text).join("\n");
}

beforeAll(async () => {
  expect(await runCli(["init", "--db", db])).toBe(0);
});

describe("yoke MCP server", () => {
  it("a decision recorded by Client A is seen (as a draft) by a separate Client B", async () => {
    // (A) record a decision → close the connection
    const a = await openSession();
    const rec = await a.client.callTool({
      name: "yoke_record_decision",
      arguments: {
        conclusion: "use sqlitembed for storage",
        rationale: "single-file embeddable store keeps the CLI zero-config",
        rejected_alternatives: ["postgres"],
      },
    });
    expect(rec.isError).toBeFalsy();
    expect(text(rec)).toMatch(/"status":"draft"/);
    await a.close();

    // (B) read from a separate connection — as a draft it does not show in the default inject
    const b = await openSession();
    const def = await b.client.callTool({
      name: "yoke_inject",
      arguments: { query: "sqlitembed" },
    });
    expect(text(def)).toContain("no verified knowledge found");

    // with includeDraft it does show (status label + attributes)
    const withDraft = await b.client.callTool({
      name: "yoke_inject",
      arguments: { query: "sqlitembed", includeDraft: true },
    });
    const out = text(withDraft);
    expect(out).toContain("[draft]");
    expect(out).toContain("use sqlitembed for storage");
    await b.close();
  });

  it("yoke_commit: an unregistered type is rejected as a tool error", async () => {
    const s = await openSession();
    const bad = await s.client.callTool({
      name: "yoke_commit",
      arguments: { type: "nonesuch", attributes: { x: 1 } },
    });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("rejected (ontology)");

    const good = await s.client.callTool({
      name: "yoke_commit",
      arguments: { type: "fact", attributes: { statement: "hello" } },
    });
    expect(good.isError).toBeFalsy();
    expect(text(good)).toMatch(/"status":"draft"/);
    await s.close();
  });

  it("does not expose verify/deprecate tools (governance: agents may only ingest drafts)", async () => {
    const s = await openSession();
    const { tools } = await s.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "yoke_commit",
      "yoke_inject",
      "yoke_overview",
      "yoke_persona",
      "yoke_record_decision",
      "yoke_use_scope",
    ]);
    await s.close();
  });

  it("yoke_persona: returns a person's verified decisions with citations; an absent person is a tool error", async () => {
    // yoke:system records a decision and verifies it (with the same actor) → it is picked up by persona.
    const seed = await openSession();
    const rec = await seed.client.callTool({
      name: "yoke_record_decision",
      arguments: {
        conclusion: "adopt append-only storage",
        rationale: "audit trail requires immutable history",
      },
    });
    const id = JSON.parse(text(rec)).id as string;
    await seed.close();
    // verify is the CLI's job — keep actor as yoke:system so the provenance.actor match stays alive.
    expect(
      await runCli(["verify", id, "--db", db, "--actor", "yoke:system"]),
    ).toBe(0);

    const s = await openSession();
    const res = await s.client.callTool({
      name: "yoke_persona",
      arguments: { person: "yoke:system" },
    });
    expect(res.isError).toBeFalsy();
    const out = text(res);
    expect(out).toContain("adopt append-only storage");
    expect(out).toContain(id); // citation

    // query filter: no match → "no record"
    const filtered = await s.client.callTool({
      name: "yoke_persona",
      arguments: { person: "yoke:system", query: "nonexistent-topic-xyz" },
    });
    expect(text(filtered)).toContain("no record");

    // absent person → tool error
    const missing = await s.client.callTool({
      name: "yoke_persona",
      arguments: { person: "nobody" },
    });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain("person not found");
    await s.close();
  });

  it("scope links captured knowledge and scopes injection (v4.0)", async () => {
    const s = await openSession();
    const ws = JSON.parse(
      text(
        await s.client.callTool({
          name: "yoke_commit",
          arguments: {
            type: "collaboration",
            attributes: { title: "scope ws" },
          },
        }),
      ),
    );
    const dec = JSON.parse(
      text(
        await s.client.callTool({
          name: "yoke_record_decision",
          arguments: {
            conclusion: "scopedecision use widgets",
            rationale: "widgets are simplest",
            scope: ws.id,
          },
        }),
      ),
    );
    await s.close();
    // Verify both so scoped injection (verified-only) can see the decision.
    expect(
      await runCli([
        "verify",
        ws.id,
        dec.id,
        "--db",
        db,
        "--actor",
        "yoke:system",
      ]),
    ).toBe(0);

    const s2 = await openSession();
    // Scoped inject returns the linked decision (the relates_to link was created capture-side).
    const scoped = await s2.client.callTool({
      name: "yoke_inject",
      arguments: { query: "widgets", scope: ws.id },
    });
    expect(text(scoped)).toContain("scopedecision use widgets");
    await s2.close();
  });

  it("yoke_use_scope pins the session scope by key; a later record_decision links to it without an explicit scope (v4.0)", async () => {
    const s = await openSession();
    const ws = JSON.parse(
      text(
        await s.client.callTool({
          name: "yoke_commit",
          arguments: {
            type: "collaboration",
            attributes: { title: "pin ws", key: "PIN-1" },
          },
        }),
      ),
    );
    // Pin by key — resolves to the collaboration and returns its id/title.
    const use = await s.client.callTool({
      name: "yoke_use_scope",
      arguments: { key: "PIN-1" },
    });
    expect(use.isError).toBeFalsy();
    expect(JSON.parse(text(use)).id).toBe(ws.id);
    // Record a decision with NO scope arg → it should link to the pinned session scope.
    const dec = JSON.parse(
      text(
        await s.client.callTool({
          name: "yoke_record_decision",
          arguments: {
            conclusion: "pinnedscopedecision use gadgets",
            rationale: "gadgets fit",
          },
        }),
      ),
    );
    await s.close();
    expect(
      await runCli([
        "verify",
        ws.id,
        dec.id,
        "--db",
        db,
        "--actor",
        "yoke:system",
      ]),
    ).toBe(0);
    const s2 = await openSession();
    const scoped = await s2.client.callTool({
      name: "yoke_inject",
      arguments: { query: "gadgets", scope: ws.id },
    });
    expect(text(scoped)).toContain("pinnedscopedecision use gadgets");
    await s2.close();
  });

  it("yoke_use_scope with an unknown key returns a non-error create hint (v4.0)", async () => {
    const s = await openSession();
    const res = await s.client.callTool({
      name: "yoke_use_scope",
      arguments: { key: "NOPE-404" },
    });
    expect(res.isError).toBeFalsy();
    const out = text(res);
    expect(out).toContain("no collaboration matches");
    expect(out).toContain("yoke_commit");
    await s.close();
  });

  it("an explicit per-call scope overrides the pinned session scope (v4.0)", async () => {
    const s = await openSession();
    const wsA = JSON.parse(
      text(
        await s.client.callTool({
          name: "yoke_commit",
          arguments: {
            type: "collaboration",
            attributes: { title: "override A", key: "OVR-A" },
          },
        }),
      ),
    );
    const wsB = JSON.parse(
      text(
        await s.client.callTool({
          name: "yoke_commit",
          arguments: {
            type: "collaboration",
            attributes: { title: "override B", key: "OVR-B" },
          },
        }),
      ),
    );
    await s.client.callTool({
      name: "yoke_use_scope",
      arguments: { key: "OVR-A" },
    });
    // Explicit scope wsB on the call must win over the pinned wsA.
    const dec = JSON.parse(
      text(
        await s.client.callTool({
          name: "yoke_record_decision",
          arguments: {
            conclusion: "overridescopedecision use levers",
            rationale: "levers win",
            scope: wsB.id,
          },
        }),
      ),
    );
    await s.close();
    expect(
      await runCli([
        "verify",
        wsA.id,
        wsB.id,
        dec.id,
        "--db",
        db,
        "--actor",
        "yoke:system",
      ]),
    ).toBe(0);
    const s2 = await openSession();
    const onB = await s2.client.callTool({
      name: "yoke_inject",
      arguments: { query: "levers", scope: wsB.id },
    });
    expect(text(onB)).toContain("overridescopedecision use levers");
    // Briefing mode (no query) proves the link landed on wsB, not the pinned wsA:
    // scope prioritizes rather than imprisons, so a query would still surface
    // org-wide hits — only the no-query briefing isolates the hop set.
    const briefA = await s2.client.callTool({
      name: "yoke_inject",
      arguments: { query: "", scope: wsA.id },
    });
    expect(text(briefA)).not.toContain("overridescopedecision");
    const briefB = await s2.client.callTool({
      name: "yoke_inject",
      arguments: { query: "", scope: wsB.id },
    });
    expect(text(briefB)).toContain("overridescopedecision");
    await s2.close();
  });
  it("caps an unbounded briefing and tells the agent where the rest is (v5.1)", async () => {
    const s = await openSession();
    const ws = JSON.parse(
      text(
        await s.client.callTool({
          name: "yoke_commit",
          arguments: {
            type: "collaboration",
            attributes: { title: "capped work", key: "CAP-1" },
          },
        }),
      ),
    );
    // More attached records than the briefing cap, all verified so they pass the injection filter.
    const ids: string[] = [];
    for (let i = 0; i < BRIEFING_LIMIT + 4; i++) {
      const f = JSON.parse(
        text(
          await s.client.callTool({
            name: "yoke_commit",
            arguments: {
              type: "fact",
              attributes: { statement: `capfact ${i} about gizmo${i}` },
              scope: ws.id,
            },
          }),
        ),
      );
      ids.push(f.id);
    }
    await s.close();
    expect(await runCli(["verify", ...ids, "--db", db], {})).toBe(0);

    const s2 = await openSession();
    // A briefing: scope set, empty query. Uncapped this returned all 54 records in full.
    const brief = text(
      await s2.client.callTool({
        name: "yoke_inject",
        arguments: { query: "", scope: ws.id },
      }),
    );
    const shown = brief.split("\n\n").filter((b) => b.startsWith("[fact:"));
    expect(shown).toHaveLength(BRIEFING_LIMIT);
    // The notice must be an instruction, not a flag: an agent that reads a truncated briefing as
    // complete answers from part of the knowledge without knowing it.
    expect(brief).toContain(`${BRIEFING_LIMIT} of ${BRIEFING_LIMIT + 4}`);
    expect(brief).toContain("NOT lost");
    expect(brief).toContain("ask yoke_inject a specific question");

    // And the claim the notice makes is true: a query reaches a record the briefing dropped.
    const dropped = ids.find((id) => !brief.includes(id));
    expect(dropped).toBeDefined();
    const idx = ids.indexOf(dropped as string);
    const q = text(
      await s2.client.callTool({
        name: "yoke_inject",
        arguments: { query: `gizmo${idx}`, scope: ws.id },
      }),
    );
    expect(q).toContain(dropped as string);

    // An explicit limit still overrides the default in both directions.
    const all = text(
      await s2.client.callTool({
        name: "yoke_inject",
        arguments: { query: "", scope: ws.id, limit: 100 },
      }),
    );
    expect(all).not.toContain("NOT lost");
    await s2.close();
  });
});

describe("resolveScope (key/id → collaboration lookup)", () => {
  const now = "2026-07-14T00:00:00Z";
  const prov: Provenance = { actor: "t", origin: "cli", occurred_at: now };

  it("resolves an exact entity id, a matching key attribute, or a matching title; null otherwise", async () => {
    const port = new SqliteStorage(":memory:");
    await port.init();
    const { entity } = await commit(
      port,
      seedOntology(),
      { type: "collaboration", attributes: { title: "auth", key: "ABC-123" } },
      prov,
      now,
    );
    const want = { id: entity.id, title: "auth" };
    expect(await resolveScope(port, null, entity.id)).toEqual(want); // exact id
    expect(await resolveScope(port, null, "ABC-123")).toEqual(want); // by key
    expect(await resolveScope(port, null, "auth")).toEqual(want); // by title
    expect(await resolveScope(port, null, "ZZZ-999")).toBeNull(); // no match
    port.close();
  });
});

// derived_from (v5.8) — an agent declaring what its record rests on. SPEC "Derivation": caller-asserted,
// filed at this tier as an ordinary gate-passing commit (like the scope's relates_to), never inferred.
describe("yoke_commit / yoke_record_decision derived_from", () => {
  /** A session whose ontology is `seedOntology()` minus some types — an un-migrated DB. */
  async function sessionWithout(...omit: string[]) {
    const store = new SqliteStorage(db);
    await store.init();
    const server = createYokeMcpServer({
      store,
      ontology: seedOntology().filter((t) => !omit.includes(t.name)),
      defaultActor: "yoke:system",
    });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0" });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    return {
      client,
      async close() {
        await client.close();
        await server.close();
        store.close();
      },
    };
  }

  /** Reads the graph back through a fresh connection, the way a separate CLI run would. */
  async function downstream(id: string) {
    const store = new SqliteStorage(db);
    await store.init();
    try {
      return (await downstreamOf(store, [id])).map((e) => e.id);
    } finally {
      store.close();
    }
  }

  async function commitFact(
    client: Client,
    statement: string,
  ): Promise<string> {
    const r = await client.callTool({
      name: "yoke_commit",
      arguments: { type: "fact", attributes: { statement } },
    });
    return JSON.parse(text(r)).id;
  }

  it("files one edge per cited id, reports how many, and makes the decision findable from its basis", async () => {
    const s = await openSession();
    const basis = await commitFact(s.client, "derived-from basis A");
    const other = await commitFact(s.client, "derived-from basis B");
    const rec = await s.client.callTool({
      name: "yoke_record_decision",
      arguments: {
        conclusion: "adopt A over B",
        rationale: "A is already in production",
        // Repeated on purpose: a duplicate citation is one edge, not two.
        derived_from: [basis, other, basis],
      },
    });
    const out = JSON.parse(text(rec));
    await s.close();

    expect(out.derived_from).toBe(2);
    expect(await downstream(basis)).toEqual([out.id]);
    expect(await downstream(other)).toEqual([out.id]);
  });

  it("a DB predating the type still commits, and says 0 rather than letting the agent assume", async () => {
    const s = await sessionWithout("derived_from");
    const basis = await commitFact(s.client, "basis on an un-migrated db");
    const rec = await s.client.callTool({
      name: "yoke_commit",
      arguments: {
        type: "fact",
        attributes: { statement: "rests on the above" },
        derived_from: [basis],
      },
    });
    const out = JSON.parse(text(rec));
    await s.close();

    // The knowledge is in — a derived edge must never fail the caller's own commit (gate stage 4b's rule).
    expect(out.status).toBe("draft");
    expect(out.derived_from).toBe(0);
    expect(await downstream(basis)).toEqual([]);
  });

  // Measured, not imagined: three agents were handed these tools and a realistic task, all three
  // cited a basis unprompted, and two of the three passed the CITATION rather than the id — because
  // `[fact:01K…@v2]` is the only form any surface ever shows them. Each string below is one of the
  // three shapes that came back.
  it.each([
    ["bare id (as documented)", (id: string) => id],
    ["type-prefixed", (id: string) => `fact:${id}`],
    ["type-prefixed with version", (id: string) => `fact:${id}@v1`],
    [
      "the whole citation",
      (id: string) => `[fact:${id}@v1] yoke:system, 2026-08-07T00:00:00Z`,
    ],
  ])("resolves a basis given as %s", async (_name, shape) => {
    const s = await openSession();
    const basis = await commitFact(s.client, `citation shape ${_name}`);
    const rec = await s.client.callTool({
      name: "yoke_record_decision",
      arguments: {
        conclusion: `on ${_name}`,
        rationale: "r",
        derived_from: [shape(basis)],
      },
    });
    const out = JSON.parse(text(rec));
    await s.close();

    expect(out.derived_from).toBe(1);
    expect(out.derived_from_ignored).toBeUndefined();
    // The edge has to be findable from the basis — a filed-but-unresolvable edge is the exact
    // silent failure this normalization exists to prevent.
    expect(await downstream(basis)).toEqual([out.id]);
  });

  it("names an id it could not resolve instead of filing an edge to nothing", async () => {
    const s = await openSession();
    const basis = await commitFact(s.client, "a real basis");
    const rec = await s.client.callTool({
      name: "yoke_record_decision",
      arguments: {
        conclusion: "half-cited",
        rationale: "r",
        derived_from: [basis, "01NOTAREALIDATALL", "fact:also-not-real@v3"],
      },
    });
    const out = JSON.parse(text(rec));
    await s.close();

    expect(out.derived_from).toBe(1);
    // Verbatim, so the caller can see that what it sent was not an id.
    expect(out.derived_from_ignored).toEqual([
      "01NOTAREALIDATALL",
      "fact:also-not-real@v3",
    ]);
    expect(await downstream(basis)).toEqual([out.id]);
  });

  it("omitting it files nothing and does not mention it", async () => {
    const s = await openSession();
    const r = await s.client.callTool({
      name: "yoke_commit",
      arguments: {
        type: "fact",
        attributes: { statement: "no declared basis" },
      },
    });
    const out = JSON.parse(text(r));
    await s.close();
    expect(out.derived_from).toBeUndefined();
    expect(await downstream(out.id)).toEqual([]);
  });
});
