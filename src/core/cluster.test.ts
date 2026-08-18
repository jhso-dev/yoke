// clusterDrafts tests (v7.1.3) — through the real SqliteStorage and the real gate, with a stub embedder
// so the grouping is deterministic and does not need a provider.

import { beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../adapters/storage-sqlite/index.js";
import { clusterDrafts } from "./cluster.js";
import { commit } from "./commit.js";
import type { Embedder } from "./embedding.js";
import { verify } from "./lifecycle.js";
import { seedOntology } from "./ontology.js";

const ont = seedOntology();
const now = "2026-08-17T00:00:00Z";
const prov = { actor: "person:ann", origin: "cli" as const, occurred_at: now };

/** One-hot on the topic word: same topic → cosine 1.0, different topic → 0. */
const TOPICS = ["deploy", "oncall", "pooling"];
const stub: Embedder = async (text) => {
  const v = new Float32Array(TOPICS.length);
  TOPICS.forEach((t, i) => {
    if (text.includes(t)) v[i] = 1;
  });
  // All-zero vectors would make cosine 0 against everything, which is the "no signal" case rather than
  // the "no vector" case — return null so the test exercises the uncompared path deliberately.
  return v.some((x) => x > 0) ? v : null;
};

let port: SqliteStorage;
beforeEach(async () => {
  port = new SqliteStorage(":memory:");
  await port.init();
});

const draft = async (statement: string) =>
  (
    await commit(
      port,
      ont,
      { type: "fact", attributes: { statement } },
      prov,
      now,
      { embedder: stub },
    )
  ).entity;

describe("clusterDrafts", () => {
  it("groups records the duplicate threshold would call alike, and leaves the rest alone", async () => {
    const a = await draft("deploy window is Tuesday morning");
    const b = await draft("deploy only on Tuesday, before 11am");
    const c = await draft("oncall handover is Monday");

    const groups = await clusterDrafts(ont, stub, [a, b, c] as never);
    expect(groups.map((g) => g.members.length)).toEqual([2, 1]);
    expect(groups[0].members.map((m) => m.id).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    expect(groups[1].members[0].id).toBe(c.id);
  });

  it("reports a record nobody could compare instead of grouping it by accident", async () => {
    // No topic word → the stub returns null, the same shape a store with no vector for a row produces.
    const orphan = await draft("something with no indexable topic");
    const groups = await clusterDrafts(ont, stub, [orphan] as never);
    expect(groups).toHaveLength(1);
    expect(groups[0].compared).toBe(0);
  });

  it("never groups a draft with a record outside the queue it was handed", async () => {
    const inQueue = await draft("deploy window is Tuesday morning");
    // Same topic, but not in the list — a group whose members cannot all be promoted is a group the
    // reviewer has to un-pick. Structural now: only the queue is compared at all.
    await draft("deploy freeze during the deploy holiday");
    const groups = await clusterDrafts(ont, stub, [inQueue] as never);
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toHaveLength(1);
  });

  it("groups the queue even when the store holds records strictly closer to each member", async () => {
    // The regression this rewrite exists for. Asking the port for the k nearest records returns the store's
    // neighbours, and the queue's own pairs get pushed out of that list — measured before the fix: two
    // drafts at cosine 0.9992 did not group with 30 closer verified records present, and no k fixes it.
    const angled: Embedder = async (text) => {
      const m = text.match(/@([0-9.]+)/);
      const a = m ? Number(m[1]) : 0;
      return Float32Array.from([Math.cos(a), Math.sin(a)]);
    };
    const put = async (statement: string) =>
      (
        await commit(
          port,
          ont,
          { type: "fact", attributes: { statement } },
          prov,
          now,
          { embedder: angled },
        )
      ).entity;
    for (let i = 1; i <= 30; i++) {
      const decoy = await put(
        `verified decoy @${(0.3 + i * 0.0005).toFixed(4)}`,
      );
      await verify(port, [decoy.id], "person:lead", now);
    }
    const a = await put("draft one @0.30");
    const b = await put("draft two @0.34");

    const groups = await clusterDrafts(ont, angled, [a, b] as never);
    expect(groups.map((g) => g.members.length)).toEqual([2]);
  });

  it("keeps queue order inside a group and puts the biggest group first", async () => {
    const one = await draft("oncall rotation is weekly");
    const two = await draft("deploy window is Tuesday");
    const three = await draft("deploy is Tuesday only");
    const four = await draft("deploy needs two approvals");

    const groups = await clusterDrafts(ont, stub, [
      one,
      two,
      three,
      four,
    ] as never);
    expect(groups[0].members.map((m) => m.id)).toEqual([
      two.id,
      three.id,
      four.id,
    ]);
    expect(groups[1].members.map((m) => m.id)).toEqual([one.id]);
  });
});
