// Shared store resolution (PLAN-V2 12.2). Three shapes, in precedence order:
//
//   --shards <config.json> / YOKE_SHARDS   ShardedStorage over member sqlite backends
//   YOKE_NEO4J_URL                         knowledge in Neo4j, this client's audit + tokens local
//   --db / YOKE_DB (default)               one SqliteStorage — the fast path
//
// Everything but the fast path is imported DYNAMICALLY, so a plain `yoke add` never loads the sharded
// module, the neo4j driver, or anything they pull in. That was already the rule for sharding and it
// matters more now: the driver is 3.8MB of code the common case has no use for.

// Type-only: erased at compile time, so the sqlite path pays no runtime import cost for these.
import type { YokeStore } from "../adapters/storage-sharded/index.js";
import { SqliteStorage } from "../adapters/storage-sqlite/index.js";

export type { YokeStore };

type Env = Record<string, string | undefined>;

/** Resolve and build the store (unopened — the caller awaits init()). */
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
  const localDb = opts.db ?? env.YOKE_DB ?? "./yoke.db";
  // Neo4j holds the knowledge; `--db` still names the LOCAL sqlite that holds this client's audit
  // trail and API tokens. Two databases on purpose — see storage-composite for why the split is a
  // decision rather than a limitation.
  if (env.YOKE_NEO4J_URL) {
    const [{ Neo4jStorage }, { makeCompositeStore }] = await Promise.all([
      import("../adapters/storage-neo4j/index.js"),
      import("../adapters/storage-composite/index.js"),
    ]);
    return makeCompositeStore(
      new Neo4jStorage({
        url: env.YOKE_NEO4J_URL,
        user: env.YOKE_NEO4J_USER,
        password: env.YOKE_NEO4J_PASSWORD,
        database: env.YOKE_NEO4J_DATABASE,
      }),
      new SqliteStorage(localDb),
    );
  }
  return new SqliteStorage(localDb);
}
