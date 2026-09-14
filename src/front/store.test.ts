// Where the knowledge goes and where the trail goes are two questions with two answers, and the rule
// that answers the second is the same wherever yoke runs — that is what these pin.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openStore } from "./store.js";

const dir = mkdtempSync(join(tmpdir(), "yoke-store-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const event = (detail: string) => ({
  actor: "a",
  action: "inject",
  detail,
  at: "2026-01-01T00:00:00Z",
});

describe("YOKE_AUDIT_URL", () => {
  it("unset: the trail goes to the knowledge store", async () => {
    const db = join(dir, "together.db");
    const store = await openStore({ db }, {});
    await store.logAudit(event("x"));
    expect(await store.listAudit()).toHaveLength(1);
    store.close();
  });

  it("set: the trail goes there and the knowledge store keeps none of it", async () => {
    const db = join(dir, "knowledge.db");
    const ledger = join(dir, "ledger.db");
    const store = await openStore({ db }, { YOKE_AUDIT_URL: ledger });
    await store.logAudit(event("moved"));
    expect((await store.listAudit()).map((r) => r.detail)).toEqual(["moved"]);
    store.close();

    // Read each file on its own: the trail is in one and the corpus in the other, which is the whole
    // claim. Opening the knowledge store alone must not surface the row.
    const knowledgeOnly = await openStore({ db }, {});
    expect(await knowledgeOnly.listAudit()).toEqual([]);
    expect(await knowledgeOnly.getEntity("yoke:system")).not.toBeNull();
    knowledgeOnly.close();

    const ledgerOnly = await openStore({ db: ledger }, {});
    expect((await ledgerOnly.listAudit()).map((r) => r.detail)).toEqual([
      "moved",
    ]);
    ledgerOnly.close();
  });

  it("names the scheme it has no adapter for, rather than treating it as a path", async () => {
    await expect(
      openStore({ db: join(dir, "x.db") }, { YOKE_AUDIT_URL: "dynamodb://t" }),
    ).rejects.toThrow(/no ledger adapter for dynamodb/);
  });

  // OpenSearch is used as a search engine: a ledger appends a document per read, which is the write
  // pattern a segment-merging index is worst at. The refusal is the point — the alternative is a
  // trail that silently follows the process instead of the corpus.
  it("a knowledge backend that cannot hold a ledger refuses at boot and names the variable", async () => {
    await expect(
      openStore(
        { db: join(dir, "os.db") },
        { YOKE_OPENSEARCH_URL: "http://localhost:9200" },
      ),
    ).rejects.toThrow(/cannot hold the audit trail.*YOKE_AUDIT_URL/s);
  });
});
