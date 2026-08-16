// C4 regression fixture — one real process that ingests ONE fixed source item into a shared DB file.
// The ingest race test spawns TWO of these against one file at once (the honest topology: two
// processes, not two handles in one thread, which better-sqlite3's blocking lock would deadlock).
// With the withCriticalSection serialization the second process sees the first's committed row and
// takes the skipped/updated path, so exactly one record exists for the external id. Run via tsx.

import { SqliteStorage } from "../src/adapters/storage-sqlite/index.js";
import { ingest } from "../src/connectors/ingest.js";
import type { Connector } from "../src/connectors/types.js";
import { seedOntology } from "../src/core/ontology.js";

const dbPath = process.argv[2];
const actor = process.argv[3] ?? "worker";

const connector: Connector = {
  name: "race",
  async *pull() {
    yield {
      externalId: "file:race#0",
      type: "fact",
      attributes: { statement: "the shard rebalance runs at 02:00 UTC" },
    };
  },
};

const store = new SqliteStorage(dbPath);
await store.init();

// The loser of the write-lock race waits out busy_timeout; under a heavily loaded CI box the winner
// can hold the lock long enough for that wait to expire, which surfaces as SQLITE_BUSY. A cron ingest
// would simply run again, so retry a few times rather than treating transient contention as failure.
const isBusy = (e: unknown) =>
  e instanceof Error &&
  ((e as { code?: string }).code === "SQLITE_BUSY" ||
    /database is locked|busy/i.test(e.message));

let res: Awaited<ReturnType<typeof ingest>> | undefined;
for (let attempt = 0; ; attempt++) {
  try {
    res = await ingest(
      store,
      seedOntology(),
      connector,
      actor,
      "2026-08-14T00:00:00Z",
    );
    break;
  } catch (e) {
    if (!isBusy(e) || attempt >= 10) throw e;
    await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
  }
}
store.close();
process.stdout.write(JSON.stringify(res));
