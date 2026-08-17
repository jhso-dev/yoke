// backstage connector tests (v7.3.3). A stub catalog API, through the real gate and the real store — the
// verified-on-import exception and the two-pass edge filing are what need pinning.

import { beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../adapters/storage-sqlite/index.js";
import { commit } from "../core/commit.js";
import { effectiveStatus } from "../core/lifecycle.js";
import type { TypeDef } from "../core/ontology.js";
import { seedOntology } from "../core/ontology.js";
import { ingestCatalog, makeBackstageConnector, refToId } from "./backstage.js";

const CATALOG: TypeDef[] = [
  {
    name: "service",
    kind: "entity",
    attrs: { name: { type: "string", required: true } },
    ttl_days: 180,
  },
  {
    name: "api",
    kind: "entity",
    attrs: { name: { type: "string", required: true } },
    ttl_days: 180,
  },
  {
    name: "datastore",
    kind: "entity",
    attrs: { name: { type: "string", required: true } },
    ttl_days: 180,
  },
  { name: "depends_on", kind: "relation", attrs: {} },
];
const ont = [...seedOntology(), ...CATALOG];
const now = "2026-08-17T00:00:00Z";

const entity = (over: Record<string, unknown> = {}) => ({
  kind: "Component",
  metadata: {
    name: "ledger",
    title: "Ledger",
    description: "Double-entry ledger",
    annotations: {
      "backstage.io/techdocs-ref": "dir:.",
      "backstage.io/source-location": "url:https://github.com/acme/ledger",
    },
  },
  spec: {
    lifecycle: "production",
    owner: "group:default/payments",
    dependsOn: ["resource:default/ledger-db"],
  },
  ...over,
});

const connectorFor = (pages: unknown[][]) => {
  let call = 0;
  return makeBackstageConnector({
    url: "https://backstage.acme.com/",
    fetchImpl: async () =>
      new Response(JSON.stringify({ items: pages[call++] ?? [] }), {
        status: 200,
      }),
  });
};

let port: SqliteStorage;
beforeEach(async () => {
  port = new SqliteStorage(":memory:");
  await port.init();
});

describe("refToId", () => {
  it("keeps the kind, drops Backstage's namespace, and lands groups on v7.2's ids", () => {
    // The group id has to match what the IdP sync mirrors, or `owns` builds a parallel org chart.
    expect(refToId("group:default/payments")).toBe("group:payments");
    expect(refToId("user:default/ann")).toBe("person:ann");
    expect(refToId("component:default/ledger")).toBe("service:ledger");
    expect(refToId("resource:default/ledger-db")).toBe("datastore:ledger-db");
    // A bare ref is a component by Backstage's own default.
    expect(refToId("ledger")).toBe("service:ledger");
  });
});

describe("ingestCatalog", () => {
  it("imports descriptors as VERIFIED records with their ownership and dependencies", async () => {
    const res = await ingestCatalog(port, ont, connectorFor([[entity()]]), now);
    // `entities` counts catalog rows and `docs` counts the TechDocs resources filed beside them — two
    // separate numbers, so a run can report "12 services, 3 of them documented".
    expect(res.entities).toBe(1);
    expect(res.docs).toBe(1);

    const service = await port.getEntity("service:ledger");
    // Verified on import, under the documented `connect rdb` exception: the catalog is already the org's
    // system of record for what it runs.
    expect(service?.status).toBe("verified");
    expect(service?.attributes.name).toBe("Ledger");
    expect(service?.attributes.repo).toBe("url:https://github.com/acme/ledger");

    // `owns` points FROM the owner so a group's briefing reaches what it is accountable for.
    const owns = await port.neighbors("service:ledger", "owns", "in");
    expect(owns.map((r) => r.from)).toEqual(["group:payments"]);
    const deps = await port.neighbors("service:ledger", "depends_on", "out");
    expect(deps.map((r) => r.to)).toEqual(["datastore:ledger-db"]);
  });

  it("carries a TTL, so a catalog nobody re-syncs goes stale instead of lying", async () => {
    await ingestCatalog(port, ont, connectorFor([[entity()]]), now);
    const service = await port.getEntity("service:ledger");
    expect(effectiveStatus(service as never, ont, now)).toBe("verified");
    // 200 days on, past the fragment's 180: this is the axis a descriptor-driven portal cannot show.
    expect(effectiveStatus(service as never, ont, "2027-03-06T00:00:00Z")).toBe(
      "stale",
    );
  });

  it("re-versions on re-import rather than duplicating, so it is safe on a schedule", async () => {
    await ingestCatalog(port, ont, connectorFor([[entity()]]), now);
    await ingestCatalog(
      port,
      ont,
      connectorFor([
        [
          entity({
            metadata: { ...entity().metadata, title: "Ledger Service" },
          }),
        ],
      ]),
      "2026-08-18T00:00:00Z",
    );
    const service = await port.getEntity("service:ledger");
    expect(service?.attributes.name).toBe("Ledger Service");
    // One record with history, not two records.
    expect(service?.version).toBeGreaterThan(2);
    const all = await port.listEntities({ type: "service" });
    expect(all.items).toHaveLength(1);
  });

  it("files an ownership edge whose group has not been mirrored yet", async () => {
    // The alternative is dropping the accountability edge that makes the portal answer "who do I ask".
    const res = await ingestCatalog(port, ont, connectorFor([[entity()]]), now);
    expect(res.errors).toBe(0);
    expect(await port.getEntity("group:payments")).toBeNull();
    expect((await port.neighbors("service:ledger", "owns", "in")).length).toBe(
      1,
    );
  });

  it("reads both catalog response shapes and pages to the end", async () => {
    const many = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) =>
        entity({ metadata: { name: `svc-${from + i}` } }),
      );
    let call = 0;
    const bare = makeBackstageConnector({
      url: "https://b",
      // A bare array is what older backends answer; reading only `{items}` would report an empty catalog.
      fetchImpl: async () =>
        new Response(
          JSON.stringify(call++ === 0 ? many(100, 0) : many(2, 100)),
        ),
    });
    const res = await ingestCatalog(port, ont, bare, now);
    expect(res.entities).toBe(102);
  });

  it("reports an HTTP failure instead of importing nothing quietly", async () => {
    const failing = makeBackstageConnector({
      url: "https://b",
      fetchImpl: async () => new Response("no", { status: 403 }),
    });
    await expect(ingestCatalog(port, ont, failing, now)).rejects.toThrow(
      /backstage catalog failed \(403\)/,
    );
  });

  it("leaves a record it cannot validate out, and says so", async () => {
    // A kind whose yoke type is not in this ontology: the run must not claim to have imported it.
    const res = await ingestCatalog(
      port,
      seedOntology(),
      connectorFor([[entity()]]),
      now,
    );
    expect(res.entities).toBe(0);
    // Two: the `service` record and its `depends_on` edge, both types living in the fragment. The `owns`
    // edge is seeded (v7.2) and still lands, which is why the CLI refuses the whole run up front when the
    // fragment is missing rather than leaving a reader to interpret a mixed count.
    expect(res.errors).toBe(2);
    expect(await port.getEntity("service:ledger")).toBeNull();
    // The docs `resource` is a seeded type, so it lands — a partial import that says which half failed
    // beats one that refuses everything because one type is missing.
    expect(res.docs).toBe(1);
  });

  it("does not disturb records it did not import", async () => {
    const mine = await commit(
      port,
      ont,
      { type: "fact", attributes: { statement: "hand-written" } },
      { actor: "person:ann", origin: "cli", occurred_at: now },
      now,
    );
    await ingestCatalog(port, ont, connectorFor([[entity()]]), now);
    const after = await port.getEntity(mine.entity.id);
    expect(after?.status).toBe("draft");
    expect(after?.version).toBe(1);
  });
});
