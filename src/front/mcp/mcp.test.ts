// MCP E2E (PLAN 3.3) — two independent client connections see the same DB (cross-session persistence).
// Uses InMemoryTransport instead of spawn (allowed): server and client are connected as a linked pair,
// but each connection opens and closes the DB file afresh, preserving the "Client A commits → close → Client B reads" scenario.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    // ...and the tool says WHY: an agent that reads "no verified knowledge" as "there is none"
    // answers from nothing and says so confidently. Same clause the CLI and the web print.
    expect(text(def)).toContain("no verified knowledge");
    expect(text(def)).toContain("1 awaiting review");

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

  it("never names a tool it does not register", async () => {
    // An instruction is only as good as the tool it names: "file it again with yoke_link" sent agents
    // after a tool that has never existed, and a model cannot tell a wrong name from a missing
    // permission. Scanned over the whole adapter, because the names appear in tool DESCRIPTIONS and in
    // the text tools return, and both are read by the same reader.
    const s = await openSession();
    const registered = new Set(
      (await s.client.listTools()).tools.map((t) => t.name),
    );
    await s.close();
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const named = new Set(source.match(/yoke_[a-z_]+/g) ?? []);
    expect([...named].filter((n) => !registered.has(n))).toEqual([]);
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

    // query filter: no match. The answer names the query it found nothing for — it used to say "no
    // recorded knowledge (no record)", which is a statement of fact about the person and was false
    // whenever their records were merely awaiting review.
    const filtered = await s.client.callTool({
      name: "yoke_persona",
      arguments: { person: "yoke:system", query: "nonexistent-topic-xyz" },
    });
    expect(text(filtered)).toContain("no verified knowledge for yoke:system");
    expect(text(filtered)).toContain("nonexistent-topic-xyz");

    // absent person → tool error
    const missing = await s.client.callTool({
      name: "yoke_persona",
      arguments: { person: "nobody" },
    });
    expect(missing.isError).toBe(true);
    // The refusal comes from core now, which distinguishes "no such record" from "that record is not
    // a person" — the second is what let a fact id produce a persona about nobody.
    expect(text(missing)).toContain("not found");
    await s.close();
  });

  // yoke_persona is the SPEC-designated PRIMARY consumption path, and it was the poorest of the three:
  // it rebuilt the citation without the author, dropped what a decision rejected, said "no recorded
  // knowledge" about a review backlog, and handed both sides of a live contradiction over as equals.
  it("yoke_persona attributes to the author, carries the rejected alternatives, and marks a contradiction", async () => {
    // A person record to anchor on, and a decision authored BY them but promoted by someone else —
    // the ordinary shape of a governed corpus, and the one where the two names differ.
    const port = new SqliteStorage(db);
    await port.init();
    const at = "2026-08-01T00:00:00Z";
    const prov = (actor: string): Provenance => ({
      actor,
      origin: "cli",
      occurred_at: at,
    });
    const author = (
      await commit(
        port,
        seedOntology(),
        { type: "person", attributes: { name: "Rin" } },
        prov("mcp:seed"),
        at,
      )
    ).entity.id;
    const mk = async (attributes: Record<string, unknown>) =>
      (
        await commit(
          port,
          seedOntology(),
          { type: "decision", attributes },
          prov(author),
          at,
        )
      ).entity.id;
    const kept = await mk({
      conclusion: "settle payouts nightly",
      rationale: "the batch window is quiet",
      rejected_alternatives: ["real-time settlement", "weekly batches"],
    });
    const other = await mk({
      conclusion: "settle payouts hourly",
      rationale: "money should move sooner",
    });
    await commit(
      port,
      seedOntology(),
      { type: "conflicts_with", attributes: {}, from: other, to: kept },
      prov("mcp:seed"),
      at,
    );
    // A draft of theirs, so the withheld line has something true to say.
    await mk({ conclusion: "unreviewed", rationale: "still in the queue" });
    port.close();
    // Promoted by the REVIEWER, which is what puts a different name in provenance.actor.
    expect(
      await runCli(["verify", kept, other, "--db", db, "--actor", "reviewer"]),
    ).toBe(0);

    const s = await openSession();
    const out = text(
      await s.client.callTool({
        name: "yoke_persona",
        arguments: { person: author },
      }),
    );
    await s.close();

    // Attribution: the author off the `authored_by` edge, RESOLVED TO THE PERSON'S NAME, with the
    // promoter kept as who vouched for it (docs/SPEC.md:682). The author id is Rin's; a raw id here
    // would be the opaque-id defect this surface exists to avoid, and naming `reviewer` would put the
    // one name a document titled "Rin persona" must not carry.
    expect(out).toContain("Rin (confirmed by reviewer)");
    // The author's id must NOT be rendered raw where the name belongs.
    expect(out).not.toContain(`${author} (confirmed by reviewer)`);
    // What lost is half the judgment — the SKILL.md export has always carried it.
    expect(out).toContain(
      "Rejected alternatives: real-time settlement, weekly batches",
    );
    // Both sides of the contradiction, both marked, neither withheld.
    expect(out).toContain("settle payouts nightly");
    expect(out).toContain("settle payouts hourly");
    expect(out).toContain(`CONTRADICTED by ${other}`);
    expect(out).toContain(`CONTRADICTED by ${kept}`);
    // ...and the answer admits to the record it is not showing.
    expect(out).toContain("1 awaiting review");
  });

  it("yoke_persona does not call a review backlog 'no recorded knowledge'", async () => {
    // The empty answer was a statement of FACT, and false whenever the person's records were merely
    // awaiting review — the normal state, since everything an agent commits is a draft. An agent told
    // that answers from nothing and says so confidently.
    const port = new SqliteStorage(db);
    await port.init();
    const at = "2026-08-01T00:00:00Z";
    const person = (
      await commit(
        port,
        seedOntology(),
        { type: "person", attributes: { name: "Only drafts" } },
        { actor: "mcp:seed", origin: "cli", occurred_at: at },
        at,
      )
    ).entity.id;
    await commit(
      port,
      seedOntology(),
      {
        type: "fact",
        attributes: { statement: "this one is still in the queue" },
      },
      { actor: person, origin: "cli", occurred_at: at },
      at,
    );
    port.close();

    const s = await openSession();
    const out = text(
      await s.client.callTool({
        name: "yoke_persona",
        arguments: { person },
      }),
    );
    await s.close();
    expect(out).not.toContain("no recorded knowledge");
    expect(out).toContain("1 awaiting review");
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

// MCP is the real product path (invariant 3) and the CLI is a thin human adapter, so MCP being the
// weaker surface is a defect rather than a CLI bonus. These four were measured with a real client.
describe("what the agent-facing surface would not tell an agent", () => {
  it("records a relation, instead of demanding arguments its schema dropped", async () => {
    // `from`/`to` were absent from the commit schema, so a relation attempt was answered "supersedes is
    // a relation type: it needs a from and a to" — about arguments the caller HAD passed and the schema
    // had silently discarded. An agent reading that retries it forever. Relations matter more now that
    // injection reads them: a superseded record stops being served and contradicting ones are marked.
    const s = await openSession();
    const idOf = async (statement: string) =>
      JSON.parse(
        text(
          await s.client.callTool({
            name: "yoke_commit",
            arguments: { type: "fact", attributes: { statement } },
          }),
        ),
      ).id as string;
    const older = await idOf("internal calls use gRPC");
    const newer = await idOf("internal calls use HTTP/JSON with OpenAPI");
    const res = await s.client.callTool({
      name: "yoke_commit",
      arguments: {
        type: "supersedes",
        attributes: {},
        from: newer,
        to: older,
      },
    });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(text(res)).id).toBeTruthy();
    await s.close();
  });

  it("lists the valid types when the one asked for is not among them", async () => {
    // The commit tool's own description says "rejected if the type is not in the ontology" and named no
    // way to read the ontology, so a typo left the agent guessing. `yoke ontology list` answers this for
    // a person; MCP had no equivalent.
    const s = await openSession();
    const res = await s.client.callTool({
      name: "yoke_commit",
      arguments: { type: "factt", attributes: { statement: "x" } },
    });
    expect(res.isError).toBeTruthy();
    expect(text(res)).toContain("entity types:");
    expect(text(res)).toContain("fact");
    expect(text(res)).toContain("relation types:");
    expect(text(res)).toContain("supersedes");
    await s.close();
  });

  it("says whether the duplicate check actually ran", async () => {
    // `duplicates: []` reads as "checked, nothing similar". With no embedder configured nothing was
    // compared at all — and conflict detection consumes the same candidates, so an agent recording a
    // contradiction was told nothing about either. The CLI has said so since the gate started reporting it.
    const s = await openSession();
    const res = await s.client.callTool({
      name: "yoke_commit",
      arguments: {
        type: "fact",
        attributes: { statement: "the freeze moved to Thursday" },
      },
    });
    expect(JSON.parse(text(res)).duplicate_check).toMatch(/not run/);
    await s.close();
  });

  it("names the people on record when a persona anchor does not resolve", async () => {
    // The only route to a person id was `yoke_overview`'s author list, which counts VERIFIED knowledge —
    // so on a corpus with a review backlog, which is the normal state since everything an agent records is
    // a draft, it is empty. A dead end unless the agent already held a ULID.
    const s = await openSession();
    const res = await s.client.callTool({
      name: "yoke_persona",
      arguments: { person: "Alex" },
    });
    expect(res.isError).toBeTruthy();
    expect(text(res)).toContain("not found: Alex");
    expect(text(res)).toMatch(/people on record|no person records/);
    await s.close();
  });
});
