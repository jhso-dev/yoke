// catalog tests (v7.3.4). The screen's whole licence to exist is that a row cannot be read without its
// rot, so that is what these pin.

import { beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../adapters/storage-sqlite/index.js";
import { catalog } from "./catalog.js";
import { commit } from "./commit.js";
import { deprecate, verify } from "./lifecycle.js";
import type { TypeDef } from "./ontology.js";
import { seedOntology } from "./ontology.js";

const CATALOG: TypeDef[] = [
  {
    name: "service",
    kind: "entity",
    attrs: {
      name: { type: "string", required: true },
      lifecycle: { type: "string" },
    },
    ttl_days: 180,
  },
  { name: "depends_on", kind: "relation", attrs: {} },
];
const ont = [...seedOntology(), ...CATALOG];
const now = "2026-08-17T00:00:00Z";
const prov = { actor: "backstage", origin: "backstage", occurred_at: now };

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
) => {
  await commit(
    port,
    ont,
    { type, attributes },
    { ...prov, occurred_at: at },
    at,
    { existingId: id },
  );
  await verify(port, [id], "backstage", at);
  return id;
};

const link = async (type: string, from: string, to: string) => {
  await commit(port, ont, { type, attributes: {}, from, to }, prov, now, {
    derived: true,
  });
};

describe("catalog", () => {
  it("is empty rather than broken when the fragment was never loaded", async () => {
    // The types live in ontology/catalog.json, not the seed. Asking a database that never loaded it must
    // not scan for types it cannot hold.
    await put("service:ledger", "service", { name: "Ledger" });
    expect(await catalog(port, seedOntology(), now)).toEqual([]);
  });

  it("carries status, owner, dependency counts, docs and its own citation", async () => {
    await put("group:payments", "group", { name: "Payments" });
    await put("service:ledger", "service", {
      name: "Ledger",
      lifecycle: "production",
    });
    await put("datastore:db", "service", { name: "Ledger DB" });
    await put("resource:docs", "resource", { title: "Ledger docs" });
    await link("owns", "group:payments", "service:ledger");
    await link("depends_on", "service:ledger", "datastore:db");
    await link("relates_to", "resource:docs", "service:ledger");

    const rows = await catalog(port, ont, now);
    const ledger = rows.find((r) => r.id === "service:ledger");
    expect(ledger).toMatchObject({
      name: "Ledger",
      status: "verified",
      lifecycle: "production",
      owners: ["group:payments"],
      dependsOn: 1,
      docs: 1,
      stale: 0,
    });
    // A catalog row is a record, so it shows its source like every other knowledge surface.
    expect(ledger?.citation).toContain("service:ledger@");
    expect(rows.find((r) => r.id === "datastore:db")?.dependents).toBe(1);
  });

  it("counts its own staleness, so a row cannot report 0 beside its expired self", async () => {
    await put("service:ledger", "service", { name: "Ledger" });
    // 200 days on, past the fragment's 180.
    const later = "2027-03-06T00:00:00Z";
    const [row] = await catalog(port, ont, later);
    expect(row.status).toBe("stale");
    expect(row.stale).toBe(1);
  });

  it("counts stale knowledge attached to it, and sorts the rot first", async () => {
    await put(
      "service:quiet",
      "service",
      { name: "Quiet" },
      "2026-08-16T00:00:00Z",
    );
    await put(
      "service:rotten",
      "service",
      { name: "Rotten" },
      "2026-08-16T00:00:00Z",
    );
    // A fact ages at 180 days; committed far enough back that it is stale at `read`, while the service
    // records themselves are not.
    await put(
      "fact:old",
      "fact",
      { statement: "how settlement worked" },
      "2026-01-01T00:00:00Z",
    );
    await link("relates_to", "fact:old", "service:rotten");

    const read = "2026-08-17T00:00:00Z";
    const rows = await catalog(port, ont, read);
    expect(rows.map((r) => r.id)).toEqual(["service:rotten", "service:quiet"]);
    expect(rows[0].stale).toBe(1);
    expect(rows[1].stale).toBe(0);
  });

  it("reports the newest verified decision by the knowledge's own time", async () => {
    await put("service:ledger", "service", { name: "Ledger" });
    await put(
      "decision:old",
      "decision",
      { conclusion: "settle nightly", rationale: "batch was cheaper" },
      "2026-03-01T00:00:00Z",
    );
    await put(
      "decision:new",
      "decision",
      { conclusion: "settle continuously", rationale: "nightly drifted" },
      "2026-06-01T00:00:00Z",
    );
    await link("relates_to", "decision:old", "service:ledger");
    await link("relates_to", "decision:new", "service:ledger");

    const [row] = await catalog(port, ont, now);
    expect(row.latestDecision?.summary).toBe("settle continuously");
  });

  it("filters by owner and by rot, and says nothing about rows it filtered", async () => {
    await put("group:a", "group", { name: "A" });
    await put("service:mine", "service", { name: "Mine" });
    await put("service:theirs", "service", { name: "Theirs" });
    await link("owns", "group:a", "service:mine");

    expect(
      (await catalog(port, ont, now, { owner: "group:a" })).map((r) => r.id),
    ).toEqual(["service:mine"]);
    expect(await catalog(port, ont, now, { staleOnly: true })).toEqual([]);
  });

  it("shows EVERY owner, because two claims on one record is the finding", async () => {
    // Reporting the first `owns` edge is the screen reporting health it did not check — the thing
    // WEB-UI.md's amended test 1 forbids — and contested ownership means "who do I ask" has two answers.
    await put("service:ledger", "service", { name: "Ledger" });
    await put("group:payments", "group", { name: "Payments" });
    await put("group:platform", "group", { name: "Platform" });
    await link("owns", "group:payments", "service:ledger");
    await link("owns", "group:platform", "service:ledger");

    const [row] = await catalog(port, ont, now);
    expect(row.owners.sort()).toEqual(["group:payments", "group:platform"]);
    // And the owner filter matches either claim, not just the first one filed.
    for (const g of ["group:payments", "group:platform"])
      expect(
        (await catalog(port, ont, now, { owner: g })).map((r) => r.id),
      ).toEqual(["service:ledger"]);
  });

  it("counts one disagreement once, seen from both ends", async () => {
    await put("service:ledger", "service", { name: "Ledger" });
    await put("decision:a", "decision", {
      conclusion: "settle nightly",
      rationale: "cheaper",
    });
    await put("decision:b", "decision", {
      conclusion: "settle continuously",
      rationale: "nightly drifted",
    });
    await link("relates_to", "decision:a", "service:ledger");
    await link("relates_to", "decision:b", "service:ledger");
    await link("conflicts_with", "decision:a", "decision:b");

    const [row] = await catalog(port, ont, now);
    // Naively this is 2 — each attached record sees the same edge — and a row labelled "pairs" reporting
    // two for one disagreement is a lie by a factor of the whole thing.
    expect(row.conflicts).toBe(1);
  });

  it("does not read another namespace's catalog", async () => {
    await put("service:mine", "service", { name: "Mine" });
    expect(await catalog(port, ont, now, { ns: "acme" })).toEqual([]);
  });

  it("shows a retired service as retired rather than hiding it", async () => {
    // A decommissioned service is still a fact about the estate, and dropping it from the catalog is how
    // a portal loses track of what it used to run.
    await put("service:gone", "service", { name: "Gone" });
    await deprecate(port, ["service:gone"], "person:admin", now);
    const [row] = await catalog(port, ont, now);
    expect(row.status).toBe("deprecated");
  });
});
