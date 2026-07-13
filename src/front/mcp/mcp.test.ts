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
import { runCli } from "../cli/index.js";
import { createYokeMcpServer } from "./index.js";

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
      arguments: { type: "fact", attributes: { title: "hello" } },
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
      "yoke_persona",
      "yoke_record_decision",
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
});
