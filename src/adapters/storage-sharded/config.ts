// storage-sharded config (PLAN-V2 12.1/12.2) — parse + validate a shard map and instantiate members.
// JSON shape: { shards: [{ name, kind: "sqlite"|"kuzu"|"qdrant", path?, url?, apiKey?, namespaces?, default? }] }.

import { readFileSync } from "node:fs";
import type { StoragePort } from "../../ports/storage.js";

export type ShardKind = "sqlite" | "kuzu" | "qdrant";

export interface ShardSpec {
  name: string;
  kind: ShardKind;
  /** sqlite/kuzu on-disk path (or ":memory:" for sqlite). */
  path?: string;
  /** qdrant base url. */
  url?: string;
  /** qdrant api key (optional). */
  apiKey?: string;
  /** Namespaces this shard owns. A namespace routes to the shard listing it. */
  namespaces?: string[];
  /** Exactly one shard must be the default (holds unlisted/null-ns rows). */
  default?: boolean;
}

export interface ShardConfig {
  shards: ShardSpec[];
}

/** Validate a parsed config object. Throws Error with a clear message on any violation:
 *  >=1 shard, exactly one default, no namespace claimed twice, kind-specific required fields. */
export function parseShardConfig(raw: unknown): ShardConfig {
  if (
    typeof raw !== "object" ||
    raw === null ||
    !Array.isArray((raw as { shards?: unknown }).shards)
  ) {
    throw new Error("shard config must be an object with a `shards` array");
  }
  const shards = (raw as { shards: unknown[] }).shards;
  if (shards.length === 0)
    throw new Error("shard config needs at least one shard");

  const names = new Set<string>();
  const claimed = new Set<string>();
  let defaults = 0;
  const out: ShardSpec[] = [];
  for (const s of shards) {
    if (typeof s !== "object" || s === null)
      throw new Error("each shard must be an object");
    const spec = s as ShardSpec;
    if (!spec.name || typeof spec.name !== "string")
      throw new Error("each shard needs a non-empty `name`");
    if (names.has(spec.name))
      throw new Error(`duplicate shard name: ${spec.name}`);
    names.add(spec.name);
    if (
      spec.kind !== "sqlite" &&
      spec.kind !== "kuzu" &&
      spec.kind !== "qdrant"
    )
      throw new Error(
        `shard ${spec.name}: kind must be sqlite|kuzu|qdrant (got ${String(spec.kind)})`,
      );
    if ((spec.kind === "sqlite" || spec.kind === "kuzu") && !spec.path)
      throw new Error(`shard ${spec.name}: ${spec.kind} needs a \`path\``);
    if (spec.kind === "qdrant" && !spec.url)
      throw new Error(`shard ${spec.name}: qdrant needs a \`url\``);
    if (spec.namespaces !== undefined) {
      if (
        !Array.isArray(spec.namespaces) ||
        spec.namespaces.some((n) => typeof n !== "string")
      )
        throw new Error(`shard ${spec.name}: namespaces must be a string[]`);
      for (const ns of spec.namespaces) {
        if (claimed.has(ns))
          throw new Error(`namespace claimed by two shards: ${ns}`);
        claimed.add(ns);
      }
    }
    if (spec.default) defaults += 1;
    out.push(spec);
  }
  if (defaults !== 1)
    throw new Error(
      `shard config needs exactly one default shard (found ${defaults})`,
    );
  return { shards: out };
}

export function loadShardConfig(path: string): ShardConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(
      `cannot read shard config ${path}: ${(e as Error).message}`,
    );
  }
  return parseShardConfig(raw);
}

/** Instantiate the adapter for one shard. Dynamic import so a sqlite-only config never loads the
 *  kuzu native binding or the qdrant module (keeps `--db` and sqlite-only sharding cheap to start). */
export async function makeShard(spec: ShardSpec): Promise<StoragePort> {
  switch (spec.kind) {
    case "sqlite": {
      const { SqliteStorage } = await import("../storage-sqlite/index.js");
      return new SqliteStorage(spec.path as string);
    }
    case "kuzu": {
      // kuzu is not a runtime dependency: its native binding is 531 MB, which was **91% of what
      // `npx yoke` downloaded** (measured 2026-08-05, docs/ROADMAP.md v2.5) for a backend reachable
      // only by naming `kind: "kuzu"` in a shard config. It is a devDependency, so this repo's own
      // tests and CI still run the full conformance suite against it.
      //
      // The failure is caught here rather than left as MODULE_NOT_FOUND because the caller wrote a
      // config file, not an import, and the stack trace of a dynamic import names neither.
      let mod: typeof import("../storage-kuzu/index.js");
      try {
        mod = await import("../storage-kuzu/index.js");
      } catch (e) {
        throw new Error(
          `this shard config names a kuzu shard, and the kuzu package is not installed. ` +
            `It ships separately because its native binding is ~530 MB: npm install kuzu\n` +
            `  (original error: ${(e as Error).message})`,
        );
      }
      return new mod.KuzuStorage(spec.path as string);
    }
    case "qdrant": {
      const { QdrantStorage } = await import("../storage-qdrant/index.js");
      return new QdrantStorage({
        url: spec.url as string,
        apiKey: spec.apiKey,
      });
    }
  }
}
