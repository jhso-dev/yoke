// RDB read-mapping tests (PLAN 8.3). Source RDB = an in-memory better-sqlite3 (CREATE/INSERT), target =
// an in-memory SqliteStorage. No Postgres. Covers: verified mapping + provenance, idempotent skip,
// change → new version, ontology-invalid row rejected (run continues), FK relation emitted, CLI smoke.

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteStorage } from "../adapters/storage-sqlite/index.js";
import { seedOntology } from "../core/ontology.js";
import { runCli } from "../front/cli/index.js";
import {
  ingestMapped,
  type MappingSpec,
  makeRdbMappingConnector,
} from "./rdb-mapping.js";

const now = "2026-07-12T00:00:00Z";

/** In-memory source RDB with an employees table (self-referential manager_id FK). */
function makeSourceDb(): Database.Database {
  const src = new Database(":memory:");
  src.exec(`
    CREATE TABLE employees (id INTEGER PRIMARY KEY, name TEXT, manager_id INTEGER);
    INSERT INTO employees VALUES (1, 'Ada', NULL), (2, 'Bob', 1), (3, 'Cyd', 1);
  `);
  return src;
}

const query =
  (src: Database.Database) =>
  async (sql: string): Promise<Record<string, unknown>[]> =>
    src.prepare(sql).all() as Record<string, unknown>[];

const EMPLOYEE_MAPPING: MappingSpec[] = [
  {
    table: "employees",
    entityType: "person",
    idColumn: "id",
    columns: { name: "name" },
    relations: [{ fkColumn: "manager_id", relType: "reports_to" }],
  },
];

let port: SqliteStorage;
let src: Database.Database;
beforeEach(async () => {
  port = new SqliteStorage(":memory:");
  await port.init();
  src = makeSourceDb();
});
afterEach(() => {
  port.close();
  src.close();
});

describe("ingestMapped", () => {
  // The operator registers the FK's relation type in the ontology (reports_to isn't a seed type).
  const ont = [
    ...seedOntology(),
    { name: "reports_to", kind: "relation" as const, attrs: {} },
  ];

  it("maps rows to verified entities with rdb provenance", async () => {
    const connector = makeRdbMappingConnector({
      query: query(src),
      mapping: EMPLOYEE_MAPPING,
    });
    const res = await ingestMapped(port, ont, connector, now);
    expect(res).toMatchObject({ added: 3, updated: 0, skipped: 0, errors: 0 });

    const found = (await port.search({ text: "rdb:employees:1" })).find(
      (e) => e.attributes.external_id === "rdb:employees:1",
    );
    expect(found).toBeDefined();
    if (!found) return;
    expect(found.type).toBe("person");
    expect(found.attributes.name).toBe("Ada");
    // commit(draft) + verify(verified) = 2 versions per write (same cost as cmdInit seeding).
    expect(found.status).toBe("verified");
    expect(found.version).toBe(2);
    expect(found.provenance.actor).toBe("rdb");

    // The rdb origin lives on the draft version (verify rewrites the head's origin to 'lifecycle').
    const draft = await port.getEntity(found.id, 1);
    expect(draft?.provenance.origin).toBe("rdb:employees");
    expect(draft?.status).toBe("draft");
  });

  it("is idempotent — an unchanged re-run skips every row", async () => {
    const connector = makeRdbMappingConnector({
      query: query(src),
      mapping: EMPLOYEE_MAPPING,
    });
    expect(await ingestMapped(port, ont, connector, now)).toMatchObject({
      added: 3,
      skipped: 0,
    });
    expect(await ingestMapped(port, ont, connector, now)).toMatchObject({
      added: 0,
      updated: 0,
      skipped: 3,
    });
  });

  it("re-versions a changed row (head advances, still verified)", async () => {
    const connector = makeRdbMappingConnector({
      query: query(src),
      mapping: EMPLOYEE_MAPPING,
    });
    await ingestMapped(port, ont, connector, now);
    const before = (await port.search({ text: "rdb:employees:2" })).find(
      (e) => e.attributes.external_id === "rdb:employees:2",
    );
    expect(before?.version).toBe(2);

    src.prepare("UPDATE employees SET name = ? WHERE id = 2").run("Bobby");
    const res = await ingestMapped(port, ont, connector, now);
    expect(res).toMatchObject({ added: 0, updated: 1, skipped: 2 });

    const after = (await port.search({ text: "rdb:employees:2" })).find(
      (e) => e.attributes.external_id === "rdb:employees:2",
    );
    expect(after?.id).toBe(before?.id);
    expect(after?.attributes.name).toBe("Bobby");
    expect(after?.status).toBe("verified");
    expect(after?.version).toBe(4); // +2 (draft then verify) over the initial v2
  });

  it("rejects an ontology-invalid row and keeps going (error counted)", async () => {
    // Map to 'decision' (requires conclusion+rationale) but supply neither → gate rejects each row.
    const mapping: MappingSpec[] = [
      {
        table: "employees",
        entityType: "decision",
        idColumn: "id",
        columns: { name: "note" }, // note is not a decision attribute; conclusion/rationale missing
      },
    ];
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const connector = makeRdbMappingConnector({ query: query(src), mapping });
    const res = await ingestMapped(port, ont, connector, now);
    errSpy.mockRestore();
    expect(res).toMatchObject({ added: 0, errors: 3 });
  });

  // The three below are what a COPY of ingest's per-item sequence had lost. They are asserted on the
  // rdb path specifically: the fixes live in `ingestItem`, and the point is that this path runs it.
  it("keeps an attribute the mapping stopped producing", async () => {
    const withNote: MappingSpec[] = [
      {
        table: "employees",
        entityType: "person",
        idColumn: "id",
        columns: { name: "name", manager_id: "manager_id" },
      },
    ];
    await ingestMapped(
      port,
      ont,
      makeRdbMappingConnector({ query: query(src), mapping: withNote }),
      now,
    );

    // The operator drops a column from the mapping file AND the row changes, so the sync re-versions.
    // The head must still carry `manager_id`: a mapping edit is a config change, and knowledge does not
    // leave an append-only store because someone stopped asking for a column.
    src.prepare("UPDATE employees SET name = ? WHERE id = 2").run("Bobby");
    const narrowed: MappingSpec[] = [
      { ...withNote[0], columns: { name: "name" } },
    ];
    const res = await ingestMapped(
      port,
      ont,
      makeRdbMappingConnector({ query: query(src), mapping: narrowed }),
      now,
    );
    expect(res).toMatchObject({ updated: 1, errors: 0 });

    const bob = (await port.search({ text: "rdb:employees:2" })).find(
      (e) => e.attributes.external_id === "rdb:employees:2",
    );
    expect(bob?.attributes.name).toBe("Bobby");
    expect(bob?.attributes.manager_id).toBe(1);
  });

  it("probes and commits inside one critical section", async () => {
    // Two concurrent `yoke connect rdb` runs otherwise both read "absent" for a row and both commit it
    // — the double write ingest.race.test.ts exists to prevent on the capture path.
    let locked = false;
    let probeLocked: boolean | undefined;
    let writeLocked: boolean | undefined;
    const realSection = port.withCriticalSection.bind(port);
    const realSearch = port.search.bind(port);
    const realPut = port.putEntity.bind(port);
    vi.spyOn(port, "withCriticalSection").mockImplementation(async (fn) => {
      locked = true;
      try {
        return await realSection(fn);
      } finally {
        locked = false;
      }
    });
    vi.spyOn(port, "search").mockImplementation(async (q) => {
      probeLocked ??= locked;
      return realSearch(q);
    });
    vi.spyOn(port, "putEntity").mockImplementation(async (e) => {
      writeLocked ??= locked;
      return realPut(e);
    });
    await ingestMapped(
      port,
      ont,
      makeRdbMappingConnector({ query: query(src), mapping: EMPLOYEE_MAPPING }),
      now,
    );
    vi.restoreAllMocks();
    expect({ probeLocked, writeLocked }).toEqual({
      probeLocked: true,
      writeLocked: true,
    });
  });

  it("asks the probe for every term of the external id", async () => {
    // An external id is many tokens and SPEC search clause 8 makes a long query a disjunction, so a
    // probe without `terms: "all"` scores every record sharing the word "rdb". Measured at 1M entities:
    // 292 ms and 1,000 rows per item, against 3 ms and 0 — and this path probes on the bulk path.
    const seen: (string | undefined)[] = [];
    const realSearch = port.search.bind(port);
    vi.spyOn(port, "search").mockImplementation(async (q) => {
      seen.push(q.terms);
      return realSearch(q);
    });
    await ingestMapped(
      port,
      ont,
      makeRdbMappingConnector({ query: query(src), mapping: EMPLOYEE_MAPPING }),
      now,
    );
    vi.restoreAllMocks();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((t) => t === "all")).toBe(true);
  });

  it("emits FK relations to the mapped target entity", async () => {
    const connector = makeRdbMappingConnector({
      query: query(src),
      mapping: EMPLOYEE_MAPPING,
    });
    await ingestMapped(port, ont, connector, now);

    const bob = (await port.search({ text: "rdb:employees:2" })).find(
      (e) => e.attributes.external_id === "rdb:employees:2",
    );
    const ada = (await port.search({ text: "rdb:employees:1" })).find(
      (e) => e.attributes.external_id === "rdb:employees:1",
    );
    expect(bob && ada).toBeTruthy();
    if (!bob || !ada) return;

    const rels = await port.neighbors(bob.id, "reports_to", "out");
    expect(rels).toHaveLength(1);
    expect(rels[0].to).toBe(ada.id); // Bob reports_to Ada (manager_id = 1)

    // Ada (manager_id NULL) emits no relation.
    expect(await port.neighbors(ada.id, "reports_to", "out")).toHaveLength(0);

    // Idempotent: re-run does not duplicate the edge.
    await ingestMapped(port, ont, connector, now);
    expect(await port.neighbors(bob.id, "reports_to", "out")).toHaveLength(1);
  });
});

describe("connect rdb CLI (sqlite source)", () => {
  const logs: string[] = [];
  beforeEach(() => {
    logs.length = 0;
    vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
      logs.push(String(m));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("mapped N added / M updated / K skipped via --sqlite", async () => {
    // Write the source DB and mapping to temp files the CLI can read.
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "yoke-rdb-"));
    const srcPath = join(dir, "source.sqlite");
    const fileSrc = new Database(srcPath);
    fileSrc.exec(
      "CREATE TABLE employees (id INTEGER PRIMARY KEY, name TEXT, manager_id INTEGER); INSERT INTO employees VALUES (1,'Ada',NULL),(2,'Bob',1);",
    );
    fileSrc.close();
    const mapPath = join(dir, "map.json");
    writeFileSync(mapPath, JSON.stringify(EMPLOYEE_MAPPING));
    const targetDb = join(dir, "yoke.db");

    try {
      expect(await runCli(["init", "--db", targetDb])).toBe(0);
      // The FK's relation type has to be declared, exactly as the in-process test above says: it is not
      // a seed type. This test never declared it, so the relation pass failed with
      // `unknown type: reports_to` on every run and the FK edge this fixture exists to exercise was never
      // created — invisible because `errors` was computed and discarded. Surfacing that count is what
      // made it visible.
      const relPath = join(dir, "reports_to.json");
      writeFileSync(
        relPath,
        JSON.stringify({ name: "reports_to", kind: "relation", attrs: {} }),
      );
      expect(
        await runCli(["ontology", "add-type", relPath, "--db", targetDb]),
      ).toBe(0);
      expect(
        await runCli([
          "connect",
          "rdb",
          "--mapping",
          mapPath,
          "--sqlite",
          srcPath,
          "--db",
          targetDb,
          "--json",
        ]),
      ).toBe(0);
      expect(JSON.parse(logs.at(-1) as string)).toMatchObject({
        added: 2,
        updated: 0,
        skipped: 0,
        // Zero, and asserted: this count was thrown away, so a sync in which every row failed was
        // indistinguishable from a no-op success.
        errors: 0,
      });

      // The FK edge, which is the whole reason the mapping declares `relations` — and which this test
      // did not check, so it went missing for as long as `errors` went unread.
      const check = new SqliteStorage(targetDb);
      await check.init();
      const people = (await check.listEntities({ type: "person" })).items;
      const bob = people.find((p) => p.attributes.name === "Bob");
      const ada = people.find((p) => p.attributes.name === "Ada");
      const edges = await check.neighbors(bob?.id ?? "", "reports_to", "out");
      expect(edges).toHaveLength(1);
      expect(edges[0].to).toBe(ada?.id);
      check.close();

      // Re-run → all skipped.
      expect(
        await runCli([
          "connect",
          "rdb",
          "--mapping",
          mapPath,
          "--sqlite",
          srcPath,
          "--db",
          targetDb,
          "--json",
        ]),
      ).toBe(0);
      expect(JSON.parse(logs.at(-1) as string)).toMatchObject({ skipped: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("errors without --dsn or --sqlite", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "yoke-rdb-"));
    const mapPath = join(dir, "map.json");
    writeFileSync(mapPath, JSON.stringify(EMPLOYEE_MAPPING));
    try {
      expect(await runCli(["connect", "rdb", "--mapping", mapPath])).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
