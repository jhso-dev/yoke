// Shared store resolution (PLAN-V2 12.2). Four shapes, in precedence order:
//
//   --shards <config.json> / YOKE_SHARDS   ShardedStorage over member sqlite backends
//   YOKE_OPENSEARCH_URL                    knowledge in OpenSearch, this client's audit + tokens local
//   YOKE_NEO4J_URL                         the same split, with Neo4j holding the knowledge
//   --db / YOKE_DB (default)               one SqliteStorage — the fast path
//
// (The order between the two remote checks is unobservable — naming both is an error, below — but
// the comment lists them in the order the code checks, so the two cannot read as disagreeing.)
//
// Everything but the fast path is imported DYNAMICALLY, so a plain `yoke add` never loads the sharded
// module, the neo4j driver, or anything they pull in. That was already the rule for sharding and it
// matters more now: the driver is 3.8MB of code the common case has no use for. (The OpenSearch
// adapter is plain fetch and costs nothing to import, but it stays dynamic for symmetry — one rule for
// remote backends is easier to keep than an exception.)
//
// Naming both variables is an ERROR rather than a precedence order. They are two different databases
// holding two different corpora; picking one silently would mean a `yoke inject` answering out of a
// store the caller did not think they were using.

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
  if (env.YOKE_NEO4J_URL && env.YOKE_OPENSEARCH_URL) {
    throw new Error(
      "YOKE_NEO4J_URL and YOKE_OPENSEARCH_URL are both set. They are two different knowledge stores — " +
        "unset one, or run the two in separate shells with separate --db files for their local halves.",
    );
  }
  // The remote backend holds the knowledge; `--db` still names the LOCAL sqlite that holds this
  // client's audit trail and API tokens. Two databases on purpose — see storage-composite for why the
  // split is a decision rather than a limitation.
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
