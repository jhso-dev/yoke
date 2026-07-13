// storage-sharded tests (PLAN-V2 12.1/12.2).
//   (a) full StoragePort conformance against a single-sqlite-member ShardedStorage;
//   (b) routing across TWO sqlite members (ns isolation, fan-out, merge, per-shard ontology, audit);
//   (c) config validation rejections;
//   (d) CLI smoke through runCli with --shards.
// Members are sqlite (the extension surface is sqlite-shaped — see the class header ceiling note).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Entity } from "../../core/types.js";
import { runCli } from "../../front/cli/index.js";
import { describeStoragePort } from "../../ports/conformance.js";
import { SqliteStorage } from "../storage-sqlite/index.js";
import { parseShardConfig } from "./config.js";
import { ShardedStorage, type ShardMember } from "./index.js";

const dir = mkdtempSync(join(tmpdir(), "yoke-sharded-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function makeEntity(over: Partial<Entity> & { id: string }): Entity {
  return {
    type: "fact",
    attributes: { title: "x" },
    status: "draft",
    version: 1,
    last_confirmed: "2026-01-01T00:00:00Z",
    provenance: {
      actor: "yoke:system",
      origin: "cli",
      occurred_at: "2026-01-01T00:00:00Z",
    },
    ...over,
  };
}

// (a) conformance: one sqlite member, marked default.
describeStoragePort(
  "sharded (1 sqlite member)",
  async () =>
    new ShardedStorage([
      {
        name: "only",
        store: new SqliteStorage(":memory:"),
        namespaces: [],
        isDefault: true,
      },
    ]),
);

// (b) routing across two sqlite members: shard "a" owns namespace "tenant-a", plus the default shard.
describe("sharded routing (2 sqlite members)", () => {
  let a: SqliteStorage;
  let d: SqliteStorage;
  let store: ShardedStorage;

  beforeEach(async () => {
    a = new SqliteStorage(":memory:");
    d = new SqliteStorage(":memory:");
    const members: ShardMember[] = [
      { name: "a", store: a, namespaces: ["tenant-a"], isDefault: false },
      { name: "default", store: d, namespaces: [], isDefault: true },
    ];
    store = new ShardedStorage(members);
    await store.init();
  });
  afterEach(() => store.close());

  it("routes an ns-tagged write to its owner shard", async () => {
    const e = makeEntity({ id: "t1", ns: "tenant-a" });
    await store.putEntity(e);
    expect(await a.getEntity("t1")).toEqual(e); // landed in shard a
    expect(await d.getEntity("t1")).toBeNull(); // not in default
  });

  it("routes a null-ns write to the default shard", async () => {
    const e = makeEntity({ id: "t2" }); // no ns
    await store.putEntity(e);
    expect(await d.getEntity("t2")).toEqual(e);
    expect(await a.getEntity("t2")).toBeNull();
  });

  it("scoped search hits only the owner shard; an unlisted ns falls to default (empty)", async () => {
    await store.putEntity(
      makeEntity({ id: "s1", ns: "tenant-a", attributes: { title: "alpha" } }),
    );
    expect(
      (await store.search({ text: "alpha", ns: "tenant-a" })).map((e) => e.id),
    ).toEqual(["s1"]);
    // "tenant-b" is claimed by no shard → routes to default, which has nothing.
    expect(await store.search({ text: "alpha", ns: "tenant-b" })).toEqual([]);
  });

  it("fan-out getEntity finds rows from either shard", async () => {
    await store.putEntity(makeEntity({ id: "g1", ns: "tenant-a" }));
    await store.putEntity(makeEntity({ id: "g2" }));
    expect((await store.getEntity("g1"))?.id).toBe("g1");
    expect((await store.getEntity("g2"))?.id).toBe("g2");
  });

  it("un-scoped search merges across shards and applies the post-merge limit", async () => {
    // Default-ns rows placed directly in both members (bypassing routing) to exercise fan-out merge.
    await a.putEntity(makeEntity({ id: "m1", attributes: { title: "merge" } }));
    await d.putEntity(makeEntity({ id: "m2", attributes: { title: "merge" } }));
    const all = await store.search({ text: "merge" });
    expect(all.map((e) => e.id).sort()).toEqual(["m1", "m2"]);
    expect(await store.search({ text: "merge", limit: 1 })).toHaveLength(1);
  });

  it("keeps ontology per shard (owner overlay), default separate", () => {
    store.saveOntology([{ name: "note", kind: "entity", attrs: {} }]); // → default
    store.saveOntology(
      [{ name: "secret", kind: "entity", attrs: {} }],
      "tenant-a",
    ); // → a
    expect(store.loadOntology().map((t) => t.name)).toEqual(["note"]);
    expect(store.loadOntology("tenant-a").map((t) => t.name)).toEqual([
      "secret",
    ]);
    // Verify each landed in its own member.
    expect(d.loadOntology().map((t) => t.name)).toEqual(["note"]);
    expect(a.loadOntology("tenant-a").map((t) => t.name)).toEqual(["secret"]);
  });

  it("writes audit to the default shard only", () => {
    store.logAudit({
      actor: "u",
      action: "inject",
      detail: "x",
      at: "2026-01-01T00:00:00Z",
    });
    expect(d.listAudit()).toHaveLength(1);
    expect(a.listAudit()).toHaveLength(0);
    expect(store.listAudit()).toHaveLength(1);
  });

  it("throws a clear per-shard error for backup/export", async () => {
    await expect(store.backupTo()).rejects.toThrow(/per-shard/);
    await expect(store.exportUntil()).rejects.toThrow(/per-shard/);
  });
});

// (c) config validation.
describe("shard config validation", () => {
  const sqlite = (name: string, extra: object = {}) => ({
    name,
    kind: "sqlite",
    path: `${name}.db`,
    ...extra,
  });

  it("rejects when no shard is default", () => {
    expect(() => parseShardConfig({ shards: [sqlite("a")] })).toThrow(
      /exactly one default/,
    );
  });

  it("rejects two default shards", () => {
    expect(() =>
      parseShardConfig({
        shards: [
          sqlite("a", { default: true }),
          sqlite("b", { default: true }),
        ],
      }),
    ).toThrow(/exactly one default/);
  });

  it("rejects a namespace claimed twice", () => {
    expect(() =>
      parseShardConfig({
        shards: [
          sqlite("a", { default: true, namespaces: ["t"] }),
          sqlite("b", { namespaces: ["t"] }),
        ],
      }),
    ).toThrow(/claimed by two/);
  });

  it("rejects a bad kind", () => {
    expect(() =>
      parseShardConfig({
        shards: [{ name: "a", kind: "mongo", default: true }],
      }),
    ).toThrow(/kind must be/);
  });

  it("rejects a missing kind-specific field (qdrant without url)", () => {
    expect(() =>
      parseShardConfig({
        shards: [{ name: "a", kind: "qdrant", default: true }],
      }),
    ).toThrow(/qdrant needs a `url`/);
  });
});

// (d) CLI smoke through --shards.
describe("CLI --shards smoke", () => {
  let logs: string[];
  let errs: string[];
  beforeEach(() => {
    logs = [];
    errs = [];
    vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
      logs.push(String(m));
    });
    vi.spyOn(console, "error").mockImplementation((m?: unknown) => {
      errs.push(String(m));
    });
  });

  it("routes add/search by ns and errors on backup", async () => {
    const tag = Math.random().toString(36).slice(2);
    const cfg = join(dir, `shards-${tag}.json`);
    const typeFile = join(dir, `type-${tag}.json`);
    writeFileSync(
      cfg,
      JSON.stringify({
        shards: [
          {
            name: "a",
            kind: "sqlite",
            path: join(dir, `a-${tag}.db`),
            namespaces: ["a"],
          },
          {
            name: "default",
            kind: "sqlite",
            path: join(dir, `d-${tag}.db`),
            default: true,
          },
        ],
      }),
    );
    writeFileSync(
      typeFile,
      JSON.stringify({ name: "fact", kind: "entity", attrs: {} }),
    );

    // Seed the "a" shard's tenant ontology, then add under ns a.
    expect(
      await runCli([
        "ontology",
        "add-type",
        typeFile,
        "--ns",
        "a",
        "--shards",
        cfg,
      ]),
    ).toBe(0);
    expect(
      await runCli([
        "add",
        "fact",
        "--ns",
        "a",
        "--attr",
        "title=hello",
        "--shards",
        cfg,
        "--json",
      ]),
    ).toBe(0);

    // search --ns a hits; --ns b (unclaimed → default) is empty.
    expect(
      await runCli(["search", "hello", "--ns", "a", "--shards", cfg, "--json"]),
    ).toBe(0);
    expect(JSON.parse(logs.at(-1) as string)).toHaveLength(1);
    expect(
      await runCli(["search", "hello", "--ns", "b", "--shards", cfg, "--json"]),
    ).toBe(0);
    expect(JSON.parse(logs.at(-1) as string)).toHaveLength(0);

    // backup with --shards errors clearly (per-shard operation).
    expect(await runCli(["backup", join(dir, "x.db"), "--shards", cfg])).toBe(
      1,
    );
    expect(errs.at(-1)).toMatch(/per-shard/);
  });
});
