// Shared store resolution (ENTERPRISE "sharding"). Four shapes, in precedence order:
//
//   --shards <config.json> / YOKE_SHARDS   ShardedStorage over member sqlite backends
//   YOKE_OPENSEARCH_URL                    knowledge in OpenSearch
//   YOKE_POSTGRES_URL                      knowledge in Postgres
//   --db / YOKE_DB (default)               one SqliteStorage — the fast path
//
// And ONE more, orthogonal to all four: `YOKE_AUDIT_URL` names where the audit trail goes. Unset, it
// goes to the knowledge store — the same rule on a laptop and on a cluster, because a trail that
// follows the process rather than the corpus answers a different question on every machine that
// reads it. A knowledge backend that cannot hold a ledger (OpenSearch: an append per read churns the
// segments an index exists to keep still) says so at boot and names the variable, rather than
// quietly writing to a file beside the process.
//
// Everything but the fast path is imported DYNAMICALLY, so a plain `yoke add` never loads the sharded
// module, the pg driver, or anything they pull in.
//
// Naming more than one remote is an ERROR rather than a precedence order. They are different databases
// holding different corpora; picking one silently would mean a `yoke inject` answering out of a store
// the caller did not think they were using.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
// Type-only: erased at compile time, so the sqlite path pays no runtime import cost for these.
import type { YokeStore } from "../adapters/storage-sharded/index.js";
import { SqliteStorage } from "../adapters/storage-sqlite/index.js";
import { commit } from "../core/commit.js";
import { seedOntology } from "../core/ontology.js";
import type { AuditPort } from "../ports/audit.js";
import { UsageError } from "./params.js";

export type { AuditEvent } from "../ports/audit.js";
export type { YokeStore };

type Env = Record<string, string | undefined>;

/** Resolve, open and seed the store. A server owns its store's lifecycle: creating it, migrating it
 * and seeding the base ontology are what every one of these backends does at boot, so there is no
 * command a person runs first — and no way for a backend to need a ceremony the others do not. */
export async function openStore(
  opts: { db?: string; shards?: string },
  env: Env,
): Promise<YokeStore> {
  const store = await resolveStore(opts, env);
  await store.init();
  await seed(store);
  return store;
}

/** The local file `--db`/`YOKE_DB` names. */
const localDb = (opts: { db?: string }, env: Env) =>
  opts.db ?? env.YOKE_DB ?? "./yoke.db";

/** The ABSOLUTE path of the one local file this configuration holds, or undefined when the knowledge
 * lives in a sharded or remote backend and so has no path a caller can expect to reach. */
export function localStorePath(
  opts: { db?: string; shards?: string },
  env: Env,
): string | undefined {
  const remote =
    opts.shards ||
    env.YOKE_SHARDS ||
    env.YOKE_OPENSEARCH_URL ||
    env.YOKE_POSTGRES_URL;
  return remote ? undefined : resolve(localDb(opts, env));
}

/** The store `serve` and `ui` open: `openStore`, and a line on stdout when it had to create the
 * file. A server creates and seeds whatever it was pointed at, so `yoke ui --db ./typo.db` would
 * otherwise start, silently, on a new empty corpus.
 *
 * Those two and no one else. `openStore` stays quiet for the tests and corpus scripts, and `yoke
 * mcp` must keep it: its stdout IS the JSON-RPC transport, where a line of prose is a protocol
 * error. */
export async function openServerStore(
  opts: { db?: string; shards?: string },
  env: Env,
): Promise<YokeStore> {
  const path = localStorePath(opts, env);
  const created = path !== undefined && !existsSync(path);
  const store = await openStore(opts, env);
  if (created) console.log(`store created: ${path}`);
  return store;
}

/** Idempotent: a store that already holds `yoke:system` is left alone. Answers whether it seeded. */
export async function seed(store: YokeStore): Promise<boolean> {
  if (await store.getEntity("yoke:system")) return false;
  const ontology = seedOntology();
  await store.saveOntology(ontology);
  // Through the gate, not `putEntity`. A nonexistent id creates version 1, so the bootstrap person is
  // committed the same way every later record is.
  const ts = new Date().toISOString();
  await commit(
    store,
    ontology,
    { type: "person", attributes: { name: "system" } },
    { actor: "yoke:system", origin: "cli", occurred_at: ts },
    ts,
    { existingId: "yoke:system" },
  );
  return true;
}

/** Where the trail goes, from `YOKE_AUDIT_URL`. Null = wherever the knowledge store is.
 *
 * A URL, not a family of variables, because the ledger is one address: `sqlite:<path>` (also a bare
 * path), `postgres://…`. Same spelling on a laptop and on a cluster, which is the point. */
async function resolveAudit(env: Env): Promise<AuditPort | null> {
  const url = env.YOKE_AUDIT_URL;
  if (!url) return null;
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    const { PostgresStorage } = await import(
      "../adapters/storage-postgres/index.js"
    );
    return new PostgresStorage({ url, schema: env.YOKE_AUDIT_SCHEMA });
  }
  if (url.startsWith("dynamodb://")) {
    const { DynamoAudit, dynamoAuditFromUrl } = await import(
      "../adapters/audit-dynamodb/index.js"
    );
    // An adapter validates its own configuration but cannot say so in this tier's vocabulary:
    // importing `UsageError` from front/ would reverse the dependency direction (invariant 1).
    try {
      return new DynamoAudit(dynamoAuditFromUrl(url, env));
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
  }
  const path = url.startsWith("sqlite:") ? url.slice("sqlite:".length) : url;
  if (path.includes("://"))
    throw new UsageError(
      `YOKE_AUDIT_URL: no ledger adapter for ${path.split("://")[0]} — use postgres://…, ` +
        "dynamodb://… or a file path",
    );
  return new SqliteStorage(path);
}

async function resolveStore(
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
  const remotes = ["YOKE_OPENSEARCH_URL", "YOKE_POSTGRES_URL"].filter(
    (k) => env[k],
  );
  if (remotes.length > 1)
    throw new UsageError(
      `${remotes.join(" and ")} are both set. They are different knowledge stores — unset one, or ` +
        "run the two in separate shells.",
    );
  const audit = await resolveAudit(env);

  if (env.YOKE_POSTGRES_URL) {
    const { PostgresStorage } = await import(
      "../adapters/storage-postgres/index.js"
    );
    const pg = new PostgresStorage({
      url: env.YOKE_POSTGRES_URL,
      schema: env.YOKE_POSTGRES_SCHEMA,
    });
    // Postgres holds its own ledger, so with nothing configured there is nothing to compose.
    if (!audit) return await composite(pg, pg);
    return await composite(pg, audit);
  }

  if (env.YOKE_OPENSEARCH_URL) {
    // OpenSearch is a search engine and is used as one. A ledger appends a document per read, which
    // is exactly the write pattern a segment-merging index is worst at, so this backend does not
    // implement AuditPort and the trail must be given an address of its own. Refusing here rather
    // than defaulting is the point: the old default wrote it to a file beside whichever process
    // happened to run, which made "the audit trail" mean something different on every machine.
    if (!audit)
      throw new UsageError(
        "YOKE_OPENSEARCH_URL holds the knowledge but cannot hold the audit trail. Set " +
          "YOKE_AUDIT_URL to where the trail goes (postgres://… for a shared one, or a file path " +
          "for a single machine).",
      );
    const { OpenSearchStorage } = await import(
      "../adapters/storage-opensearch/index.js"
    );
    return await composite(
      new OpenSearchStorage({
        url: env.YOKE_OPENSEARCH_URL,
        username: env.YOKE_OPENSEARCH_USER,
        password: env.YOKE_OPENSEARCH_PASSWORD,
        prefix: env.YOKE_OPENSEARCH_PREFIX,
      }),
      audit,
    );
  }

  const sqlite = new SqliteStorage(localDb(opts, env));
  if (!audit) return sqlite;
  // A local corpus whose trail was deliberately sent elsewhere — the same composition, and the same
  // reason, as the remote cases. sqlite is one backend among several, not the one with an exemption.
  return await composite(sqlite, audit);
}

/** `makeCompositeStore` is loaded here so the fast path never pulls it in. */
async function composite(
  knowledge: Parameters<
    typeof import("../adapters/storage-composite/index.js").makeCompositeStore
  >[0],
  audit: AuditPort,
): Promise<YokeStore> {
  const { makeCompositeStore } = await import(
    "../adapters/storage-composite/index.js"
  );
  return makeCompositeStore(knowledge, audit);
}
