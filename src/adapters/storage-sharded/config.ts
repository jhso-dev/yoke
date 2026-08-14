// storage-sharded config (PLAN-V2 12.1/12.2) — parse + validate a shard map and instantiate members.
// JSON shape: { shards: [{ name, kind: "sqlite", path, namespaces?, default? }] }.
//
// `kind` is a one-value union. The field stays because the router supports heterogeneous mixes and
// there is simply nothing to mix until a second shardable backend exists — see the ceiling note in
// index.ts for what a non-sqlite member would have to satisfy.

import { readFileSync } from "node:fs";
import type { StoragePort } from "../../ports/storage.js";
import { SqliteStorage } from "../storage-sqlite/index.js";

export type ShardKind = "sqlite";

export interface ShardSpec {
  name: string;
  kind: ShardKind;
  /** On-disk path, or ":memory:". */
  path?: string;
  /** Namespaces this shard owns. A namespace routes to the shard listing it. */
  namespaces?: string[];
  /** Exactly one shard must be the default (holds unlisted/null-ns rows). */
  default?: boolean;
}

export interface ShardConfig {
  shards: ShardSpec[];
}

// An unknown key is refused, not ignored (CLAUDE.md's validateTypeDef rule one level up): a
// `"namespace"` typo for `"namespaces"` was accepted and silently dropped the tenant's namespaces, so
// its rows routed to the DEFAULT shard — a cross-tenant placement bug, exactly what sharding exists to
// prevent. Enumerate what is valid and reject the rest.
const SHARD_SPEC_KEYS = [
  "name",
  "kind",
  "path",
  "namespaces",
  "default",
] as const;
const SHARD_CONFIG_KEYS = ["shards"] as const;

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
  const topUnknown = Object.keys(raw as Record<string, unknown>).filter(
    (k) => !(SHARD_CONFIG_KEYS as readonly string[]).includes(k),
  );
  if (topUnknown.length > 0)
    throw new Error(
      `shard config: unknown key(s): ${topUnknown.join(", ")} — takes ${SHARD_CONFIG_KEYS.join(", ")}`,
    );
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
    const unknown = Object.keys(s as Record<string, unknown>).filter(
      (k) => !(SHARD_SPEC_KEYS as readonly string[]).includes(k),
    );
    if (unknown.length > 0)
      throw new Error(
        `shard ${String((s as { name?: unknown }).name)}: unknown key(s): ${unknown.join(", ")} — a shard takes ${SHARD_SPEC_KEYS.join(", ")}`,
      );
    const spec = s as ShardSpec;
    if (!spec.name || typeof spec.name !== "string")
      throw new Error("each shard needs a non-empty `name`");
    if (names.has(spec.name))
      throw new Error(`duplicate shard name: ${spec.name}`);
    names.add(spec.name);
    if (spec.kind !== "sqlite")
      throw new Error(
        `shard ${spec.name}: kind must be sqlite (got ${String(spec.kind)})`,
      );
    if (!spec.path)
      throw new Error(`shard ${spec.name}: sqlite needs a \`path\``);
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

/** Instantiate the adapter for one shard. `path` is guaranteed by parseShardConfig.
 *  Stays `async` because it is one member of a `Promise.all` over the whole map. */
export async function makeShard(spec: ShardSpec): Promise<StoragePort> {
  return new SqliteStorage(spec.path as string);
}
