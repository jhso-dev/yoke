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

  // The cross-shard merge is what conformance cannot reach (it runs a single-member store), and it
  // is where a per-shard cursor map would have been needed if `after` were not a global predicate.
  it("un-scoped enumeration yields exact global id order across shards, and its cursor has no gap", async () => {
    // Interleaved ids placed directly in both members, so neither shard's local order is the
    // global order: a merge that just concatenated pages would fail this.
    for (const id of ["k1", "k3", "k5"])
      await a.putEntity(makeEntity({ id, type: "kpage" }));
    for (const id of ["k2", "k4"])
      await d.putEntity(makeEntity({ id, type: "kpage" }));

    const all = await store.listEntities({ type: "kpage" });
    expect(all.items.map((e) => e.id)).toEqual(["k1", "k2", "k3", "k4", "k5"]);
    expect(all.next).toBeNull();

    const p1 = await store.listEntities({ type: "kpage", limit: 2 });
    expect(p1.items.map((e) => e.id)).toEqual(["k1", "k2"]);
    expect(p1.next).toBe("k2");
    const p2 = await store.listEntities({
      type: "kpage",
      limit: 2,
      after: p1.next ?? undefined,
    });
    expect(p2.items.map((e) => e.id)).toEqual(["k3", "k4"]);
    const p3 = await store.listEntities({
      type: "kpage",
      limit: 2,
      after: p2.next ?? undefined,
    });
    expect(p3.items.map((e) => e.id)).toEqual(["k5"]);
    expect(p3.next).toBeNull();
  });

  it("scoped enumeration hits only the owner shard", async () => {
    await store.putEntity(makeEntity({ id: "n1", ns: "tenant-a" }));
    await d.putEntity(makeEntity({ id: "n2" })); // default ns, other shard
    const scoped = await store.listEntities({ ns: "tenant-a" });
    expect(scoped.items.map((e) => e.id)).toEqual(["n1"]);
  });

  // Writes split by ns (shared → default shard, tenant → owner shard) but a READ overlays them, the
  // way sqlite does inside one database. Asserting the owner shard alone here would pin a defect: a
  // tenant shard never holds the shared types, so a namespace owned by one would load an empty
  // ontology and every command under it would refuse to run.
  it("overlays the default shard's shared ontology under the owner shard's", async () => {
    await store.saveOntology([{ name: "note", kind: "entity", attrs: {} }]); // → default
    await store.saveOntology(
      [{ name: "secret", kind: "entity", attrs: {} }],
      "tenant-a",
    ); // → a
    expect(store.loadOntology().map((t) => t.name)).toEqual(["note"]);
    expect(store.loadOntology("tenant-a").map((t) => t.name)).toEqual([
      "note",
      "secret",
    ]);
    // A namespace with no shard of its own still sees the shared base.
    expect(store.loadOntology("unclaimed").map((t) => t.name)).toEqual([
      "note",
    ]);
    // Each def still landed in its own member — the split is the storage layout, not the read. The
    // "a" member holds ONLY the tenant def (its own shared base is empty), which is exactly why the
    // overlay has to happen at this level and cannot be left to the member.
    expect(d.loadOntology().map((t) => t.name)).toEqual(["note"]);
    expect(a.loadOntology("tenant-a").map((t) => t.name)).toEqual(["secret"]);
    expect(a.loadOntology().map((t) => t.name)).toEqual([]);
  });

  // A tenant def SHADOWS a shared one of the same name, in the shared slot (sqlite's rule, so the
  // two backends cannot disagree about which definition is in force).
  it("lets a tenant def override a shared one of the same name", async () => {
    await store.saveOntology([
      { name: "note", kind: "entity", attrs: {} },
      { name: "fact", kind: "entity", attrs: {}, ttl_days: 180 },
    ]);
    await store.saveOntology(
      [{ name: "fact", kind: "entity", attrs: {}, ttl_days: 7 }],
      "tenant-a",
    );
    const eff = store.loadOntology("tenant-a");
    expect(eff.map((t) => t.name)).toEqual(["note", "fact"]);
    expect(eff.find((t) => t.name === "fact")?.ttl_days).toBe(7);
    // The shared namespace is untouched by the tenant's override.
    expect(store.loadOntology().find((t) => t.name === "fact")?.ttl_days).toBe(
      180,
    );
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

  it("rejects a sqlite shard with no path", () => {
    expect(() =>
      parseShardConfig({
        shards: [{ name: "a", kind: "sqlite", default: true }],
      }),
    ).toThrow(/sqlite needs a `path`/);
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

    // `yoke init` writes the seed with NO ns, so it lands on the default shard — and that is all a
    // tenant shard ever gets. Run init here rather than hand-seeding the "a" shard: the flow a real
    // user takes is init, then work in a namespace, and that is the flow worth exercising.
    expect(await runCli(["init", "--shards", cfg])).toBe(0);
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

  // The flow that was broken, with nothing hand-seeded: `yoke init`, then work in a namespace owned
  // by a NON-default shard, using only the seed ontology. Every command below failed with
  // "not initialized: … — run 'yoke init' first" while the identical commands worked on plain sqlite.
  it("a namespace on a non-default shard works off the seed ontology alone", async () => {
    const tag = Math.random().toString(36).slice(2);
    const cfg = join(dir, `seedflow-${tag}.json`);
    writeFileSync(
      cfg,
      JSON.stringify({
        shards: [
          {
            name: "teamb",
            kind: "sqlite",
            path: join(dir, `teamb-${tag}.db`),
            namespaces: ["teamb"],
          },
          {
            name: "main",
            kind: "sqlite",
            path: join(dir, `main-${tag}.db`),
            default: true,
          },
        ],
      }),
    );

    expect(await runCli(["init", "--shards", cfg, "--json"])).toBe(0);
    // It reports the store it opened, not `--db` — naming the local sqlite here would name a file it
    // never touched (SPEC "A command reports the store it actually opened").
    const out = JSON.parse(logs.at(-1) as string);
    expect(out.store).toBe(`shards ${cfg}`);
    expect(out.db).toBe("./yoke.db"); // the local half stays a path for scripts
    // No `ontology add-type`: `fact` comes from the seed, which lives on the default shard.
    expect(
      await runCli([
        "add",
        "fact",
        "--ns",
        "teamb",
        "--attr",
        "statement=tenant knowledge",
        "--shards",
        cfg,
        "--json",
      ]),
    ).toBe(0);
    const id = JSON.parse(logs.at(-1) as string).id as string;

    // Readable in its namespace, and the whole lifecycle works there.
    expect(
      await runCli(["verify", id, "--ns", "teamb", "--shards", cfg, "--json"]),
    ).toBe(0);
    expect(JSON.parse(logs.at(-1) as string)[0].status).toBe("verified");
    expect(
      await runCli([
        "inject",
        "tenant",
        "--ns",
        "teamb",
        "--shards",
        cfg,
        "--json",
      ]),
    ).toBe(0);
    expect(JSON.parse(logs.at(-1) as string)).toHaveLength(1);

    // Still isolated: the shared namespace cannot see it.
    expect(await runCli(["search", "tenant", "--shards", cfg, "--json"])).toBe(
      0,
    );
    expect(JSON.parse(logs.at(-1) as string)).toHaveLength(0);
  });
});
