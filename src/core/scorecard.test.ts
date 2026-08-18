// scorecard tests (v7.4.2). The check that matters is the owner one: absence and rot both have to score,
// or a service passes by being quiet.

import { beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../adapters/storage-sqlite/index.js";
import { commit } from "./commit.js";
import { deprecate, verify } from "./lifecycle.js";
import type { TypeDef } from "./ontology.js";
import { seedOntology } from "./ontology.js";
import { scorecard } from "./scorecard.js";

const CATALOG: TypeDef[] = [
  {
    name: "service",
    kind: "entity",
    attrs: { name: { type: "string", required: true } },
    ttl_days: 180,
  },
  { name: "depends_on", kind: "relation", attrs: {} },
];
const ont = [...seedOntology(), ...CATALOG];
const now = "2026-08-17T00:00:00Z";

let port: SqliteStorage;
beforeEach(async () => {
  port = new SqliteStorage(":memory:");
  await port.init();
});

const put = async (
  id: string,
  type: string,
  attributes: Record<string, unknown>,
  at = now,
  promote = true,
) => {
  await commit(
    port,
    ont,
    { type, attributes },
    { actor: "backstage", origin: "backstage", occurred_at: at },
    at,
    { existingId: id },
  );
  if (promote) await verify(port, [id], "backstage", at);
};

const link = async (type: string, from: string, to: string) => {
  await commit(
    port,
    ont,
    { type, attributes: {}, from, to },
    { actor: "backstage", origin: "backstage", occurred_at: now },
    now,
    { derived: true },
  );
};

const check = (
  row: { checks: { id: string; pass: boolean; detail: string }[] },
  id: string,
) => row.checks.find((c) => c.id === id);

describe("scorecard", () => {
  it("goes fully green only when every check has evidence", async () => {
    await put("group:payments", "group", { name: "Payments" });
    await put("service:ledger", "service", { name: "Ledger" });
    await put("resource:runbook", "resource", { title: "Ledger runbook" });
    await put("decision:d", "decision", {
      conclusion: "settle continuously",
      rationale: "nightly drifted",
    });
    await link("owns", "group:payments", "service:ledger");
    await link("relates_to", "resource:runbook", "service:ledger");
    await link("relates_to", "decision:d", "service:ledger");

    const [row] = await scorecard(port, ont, now);
    expect(row.score).toBe(row.of);
  });

  it("fails a RETIRED owner — a descriptor still names them", async () => {
    await put("group:payments", "group", { name: "Payments" });
    await put("service:ledger", "service", { name: "Ledger" });
    await link("owns", "group:payments", "service:ledger");

    await deprecate(port, ["group:payments"], "person:admin", now);
    const [row] = await scorecard(port, ont, now);
    expect(check(row, "owner")?.pass).toBe(false);
    expect(check(row, "owner")?.detail).toContain("retired");
  });

  it("cannot fail a STALE owner on the seed ontology, and can when the type declares a TTL", async () => {
    // The claim "an owner nobody re-confirmed is not green" was written before this was checked, and it was
    // wrong by default: the seed gives `group` no `ttl_days`, so a group promoted once reads `verified`
    // forever. Both halves are pinned here so the ceiling in scorecard.ts cannot quietly stop being true.
    await put("group:payments", "group", { name: "Payments" });
    await put("service:ledger", "service", { name: "Ledger" });
    await link("owns", "group:payments", "service:ledger");

    const farFuture = "2099-01-01T00:00:00Z";
    const [seedRow] = await scorecard(port, ont, farFuture);
    expect(check(seedRow, "owner")?.pass).toBe(true);

    // The same store, read against an ontology whose `group` expires — what a tenant declares with
    // `yoke ontology add-type` when it wants the org chart to be re-confirmed.
    const expiring = ont.map((t) =>
      t.name === "group" ? { ...t, ttl_days: 180 } : t,
    );
    const [expiringRow] = await scorecard(port, expiring, farFuture);
    expect(check(expiringRow, "owner")?.pass).toBe(false);
    expect(check(expiringRow, "owner")?.detail).toContain("TTL");
  });

  it("fails an owner that no record backs, naming who was claimed", async () => {
    await put("service:ledger", "service", { name: "Ledger" });
    await link("owns", "group:ghosts", "service:ledger");
    const [row] = await scorecard(port, ont, now);
    expect(check(row, "owner")?.detail).toContain("group:ghosts");
    expect(check(row, "owner")?.detail).toContain("nobody to ask");
  });

  it("fails an owner nobody verified", async () => {
    await put("service:ledger", "service", { name: "Ledger" });
    await put("group:draft", "group", { name: "Unverified" }, now, false);
    await link("owns", "group:draft", "service:ledger");
    const [row] = await scorecard(port, ont, now);
    expect(check(row, "owner")?.detail).toContain("never verified");
  });

  it("counts silence as a failure, not as a pass", async () => {
    await put("service:quiet", "service", { name: "Quiet" });
    const [row] = await scorecard(port, ont, now);
    // Three of four fail, and each says what is absent. Freshness passes — nothing IS stale — but its
    // reason says the pass is vacuous, so the row cannot read as health.
    expect(row.score).toBe(1);
    expect(check(row, "fresh")?.detail).toBe(
      "nothing recorded about it, so nothing to go stale",
    );
    expect(check(row, "owner")?.detail).toBe("nobody owns it");
    expect(check(row, "docs")?.detail).toContain("no runbook");
    expect(check(row, "decision")?.detail).toContain("no verified decision");
  });

  it("fails a decision that has aged past its TTL", async () => {
    await put("service:ledger", "service", { name: "Ledger" });
    await put(
      "decision:ancient",
      "decision",
      { conclusion: "settle nightly", rationale: "batch was cheaper" },
      "2024-01-01T00:00:00Z",
    );
    await link("relates_to", "decision:ancient", "service:ledger");
    const [row] = await scorecard(port, ont, now);
    // A stale decision is not a current decision, and its own staleness also fails the freshness check.
    expect(check(row, "decision")?.pass).toBe(false);
    expect(check(row, "fresh")?.pass).toBe(false);
  });

  it("sorts the worst first, because a scorecard is a work queue", async () => {
    await put("group:g", "group", { name: "G" });
    await put("service:better", "service", { name: "Better" });
    await put("service:worse", "service", { name: "Worse" });
    await link("owns", "group:g", "service:better");
    const rows = await scorecard(port, ont, now);
    expect(rows.map((r) => r.id)).toEqual(["service:worse", "service:better"]);
  });
});

describe("scorecard — contested and multiple owners", () => {
  const at = "2026-08-18T00:00:00Z";
  let store: SqliteStorage;
  beforeEach(async () => {
    store = new SqliteStorage(":memory:");
    await store.init();
  });
  const prov = { actor: "x", origin: "cli" as const, occurred_at: at };
  const put = async (
    id: string,
    type: string,
    attributes: Record<string, unknown>,
  ) => {
    await commit(store, ont, { type, attributes }, prov, at, {
      existingId: id,
    });
    await verify(store, [id], "x", at);
  };
  const link = async (type: string, from: string, to: string) => {
    await commit(store, ont, { type, attributes: {}, from, to }, prov, at, {
      derived: true,
    });
  };

  it("fails when ANY named owner cannot be asked, not just the first", async () => {
    // Half-broken routing is broken routing: passing on whichever `owns` edge came back first is the row
    // reporting health it did not check.
    await put("service:ledger", "service", { name: "Ledger" });
    await put("group:live", "group", { name: "Live" });
    await put("group:gone", "group", { name: "Gone" });
    await link("owns", "group:live", "service:ledger");
    await link("owns", "group:gone", "service:ledger");
    await deprecate(store, ["group:gone"], "person:admin", at);

    const [row] = await scorecard(store, ont, at);
    const owner = row.checks.find((c) => c.id === "owner");
    expect(owner?.pass).toBe(false);
    expect(owner?.detail).toContain("group:gone is retired");
    // And it names only the broken one — a reader fixes what is named.
    expect(owner?.detail).not.toContain("group:live is");
  });

  it("passes two healthy owners but says the ownership is contested", async () => {
    await put("service:ledger", "service", { name: "Ledger" });
    await put("group:a", "group", { name: "A" });
    await put("group:b", "group", { name: "B" });
    await link("owns", "group:a", "service:ledger");
    await link("owns", "group:b", "service:ledger");

    const owner = (await scorecard(store, ont, at))[0].checks.find(
      (c) => c.id === "owner",
    );
    // Not a failure — two groups may share one — but "who do I ask" with two answers is reported.
    expect(owner?.pass).toBe(true);
    expect(owner?.detail).toContain("contested");
  });
});
