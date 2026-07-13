// Shared store resolution (PLAN-V2 12.2). `--shards <config.json>` (or YOKE_SHARDS) wins over `--db`
// and builds a ShardedStorage; otherwise a single SqliteStorage — the single-backend fast path, which
// never loads the sharded/kuzu/qdrant modules (ShardedStorage is imported dynamically only on --shards).

// Type-only: erased at compile time, so the sqlite path pays no runtime import cost for the sharded module.
import type { YokeStore } from "../adapters/storage-sharded/index.js";
import { SqliteStorage } from "../adapters/storage-sqlite/index.js";

export type { YokeStore };

type Env = Record<string, string | undefined>;

/** Resolve and build the store (unopened — the caller awaits init()). --shards/YOKE_SHARDS beats --db. */
export async function openStore(
  opts: { db?: string; shards?: string },
  env: Env,
): Promise<YokeStore> {
  const shards = opts.shards ?? env.YOKE_SHARDS;
  if (shards) {
    const { makeShardedStorage } = await import(
      "../adapters/storage-sharded/index.js"
    );
    return makeShardedStorage(shards);
  }
  return new SqliteStorage(opts.db ?? env.YOKE_DB ?? "./yoke.db");
}
