// namespace tests (PLAN-V2 10.1) — normalizeNs/resolveNs semantics, the gate assigning ns to the
// stored row, and inject isolation across namespaces (data prepared via real SqliteStorage + gate).

import { describe, expect, it } from "vitest";
import { SqliteStorage } from "../adapters/storage-sqlite/index.js";
import { commit } from "./commit.js";
import { inject } from "./inject.js";
import { verify } from "./lifecycle.js";
import { normalizeNs, resolveNs } from "./namespace.js";
import { seedOntology } from "./ontology.js";
import type { Provenance } from "./types.js";

const ont = seedOntology();
const now = "2026-07-12T00:00:00Z";
const prov: Provenance = {
  actor: "yoke:system",
  origin: "cli",
  occurred_at: now,
};

describe("normalizeNs / resolveNs", () => {
  it("maps undefined, null and empty string to the default (null) namespace", () => {
    expect(normalizeNs(undefined)).toBeNull();
    expect(normalizeNs(null)).toBeNull();
    expect(normalizeNs("")).toBeNull();
    expect(normalizeNs("tenant-a")).toBe("tenant-a");
  });

  it("resolveNs precedence: flag > YOKE_NS env > default", () => {
    expect(resolveNs("flag", { YOKE_NS: "env" })).toBe("flag");
    expect(resolveNs(undefined, { YOKE_NS: "env" })).toBe("env");
    expect(resolveNs(undefined, {})).toBeNull();
  });
});

describe("gate assigns ns", () => {
  it("stores opts.ns on the row; default leaves the field absent", async () => {
    const port = new SqliteStorage(":memory:");
    await port.init();
    const a = await commit(
      port,
      ont,
      { type: "fact", attributes: { note: "x" } },
      prov,
      now,
      {
        ns: "tenant-a",
      },
    );
    expect(a.entity.ns).toBe("tenant-a");
    const d = await commit(
      port,
      ont,
      { type: "fact", attributes: { note: "y" } },
      prov,
      now,
    );
    expect("ns" in d.entity).toBe(false);
    port.close();
  });
});

describe("inject isolation", () => {
  it("only returns verified knowledge from the queried namespace", async () => {
    const port = new SqliteStorage(":memory:");
    await port.init();
    const mk = async (ns: string | undefined) => {
      const { entity } = await commit(
        port,
        ont,
        { type: "fact", attributes: { note: "shared-token secret" } },
        prov,
        now,
        { ns },
      );
      await verify(port, [entity.id], "alice", now);
      return entity.id;
    };
    const idA = await mk("tenant-a");
    const idB = await mk("tenant-b");
    const idDefault = await mk(undefined);

    const a = await inject(port, ont, "secret", now, { ns: "tenant-a" });
    expect(a.items.map((i) => i.entity.id)).toEqual([idA]);

    const b = await inject(port, ont, "secret", now, { ns: "tenant-b" });
    expect(b.items.map((i) => i.entity.id)).toEqual([idB]);

    const def = await inject(port, ont, "secret", now);
    expect(def.items.map((i) => i.entity.id)).toEqual([idDefault]);
    port.close();
  });
});
