// Postgres query fn for the RDB read-mapping connector (PLAN 8.3). Trivial pg.Pool wrapper.
// Imported dynamically by the CLI only on the --dsn path, so the sqlite/test path never needs `pg`.

import pg from "pg";

/** DSN → query fn for makeRdbMappingConnector. */
export function makePgQuery(
  dsn: string,
): (sql: string) => Promise<Record<string, unknown>[]> {
  const pool = new pg.Pool({ connectionString: dsn });
  // ponytail: pool lives for the process; the one-shot CLI sync exits right after, tearing it down.
  // Add an explicit pool.end() if we ever run multiple syncs in one process.
  return async (sql) =>
    (await pool.query(sql)).rows as Record<string, unknown>[];
}
