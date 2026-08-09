// Shared store resolution (PLAN-V2 12.2). Four shapes, in precedence order:
//
//   --shards <config.json> / YOKE_SHARDS   ShardedStorage over member sqlite backends
//   YOKE_OPENSEARCH_URL                    knowledge in OpenSearch, this client's audit + tokens local
//   YOKE_POSTGRES_URL                      the same split, with Postgres holding the knowledge
//   --db / YOKE_DB (default)               one SqliteStorage — the fast path
//
// Everything but the fast path is imported DYNAMICALLY, so a plain `yoke add` never loads the sharded
// module, the pg driver, or anything they pull in.
//
// Naming more than one remote is an ERROR rather than a precedence order. They are different databases
// holding different corpora; picking one silently would mean a `yoke inject` answering out of a store
// the caller did not think they were using.

// Type-only: erased at compile time, so the sqlite path pays no runtime import cost for these.
import type {
  AuditEvent,
  YokeStore,
} from "../adapters/storage-sharded/index.js";
import { SqliteStorage } from "../adapters/storage-sqlite/index.js";

export type { AuditEvent, YokeStore };

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
  const remotes = ["YOKE_OPENSEARCH_URL", "YOKE_POSTGRES_URL"].filter(
    (k) => env[k],
  );
  if (remotes.length > 1)
    throw new Error(
      `${remotes.join(" and ")} are both set. They are different knowledge stores — unset one, or ` +
        "run the two in separate shells with separate --db files for their local halves.",
    );
  // The remote backend holds the knowledge; `--db` still names the LOCAL sqlite that holds this
  // client's audit trail and API tokens. Two databases on purpose — see storage-composite for why the
  // split is a decision rather than a limitation.
  if (env.YOKE_POSTGRES_URL) {
    const [{ PostgresStorage }, { makeCompositeStore }] = await Promise.all([
      import("../adapters/storage-postgres/index.js"),
      import("../adapters/storage-composite/index.js"),
    ]);
    return makeCompositeStore(
      new PostgresStorage({
        url: env.YOKE_POSTGRES_URL,
        schema: env.YOKE_POSTGRES_SCHEMA,
      }),
      new SqliteStorage(localDb),
    );
  }
  if (env.YOKE_OPENSEARCH_URL) {
    const [{ OpenSearchStorage }, { makeCompositeStore }] = await Promise.all([
      import("../adapters/storage-opensearch/index.js"),
      import("../adapters/storage-composite/index.js"),
    ]);
    return makeCompositeStore(
      new OpenSearchStorage({
        url: env.YOKE_OPENSEARCH_URL,
        username: env.YOKE_OPENSEARCH_USER,
        password: env.YOKE_OPENSEARCH_PASSWORD,
        prefix: env.YOKE_OPENSEARCH_PREFIX,
      }),
      new SqliteStorage(localDb),
    );
  }
  return new SqliteStorage(localDb);
}
