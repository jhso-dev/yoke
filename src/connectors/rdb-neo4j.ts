// Neo4j query fn for the RDB read-mapping connector — the graph twin of rdb-pg. Calls the HTTP
// transactional endpoint directly with fetch (no driver — one endpoint, Neo4j 5+: elementId()).
// `ingestMapped` only ever emits one SQL shape (`SELECT * FROM <name>`), so this translates exactly
// that shape to Cypher and refuses anything else: the mapping's `table` is a node label.
//
// A label the database does not have is REFUSED by name, not answered with zero rows. MATCH on an
// unknown label matches nothing, so a typo'd mapping would otherwise sync "0 added" with exit 0 —
// the silent miss a SQL source cannot produce (an unknown table is a loud error). The label list
// comes from `CALL db.labels()`, fetched once per sync.
//
// The row shape handed back, and how a mapping file reads it:
//   - every node property, verbatim (so `columns` and `occurredAtColumn` name properties);
//   - `_id` — elementId(n), the stable per-node key. Use it as the mapping's `idColumn` when nodes
//     have no natural key; prefer a natural key property when one exists (elementId survives only
//     within one database lifetime — a dump/restore re-mints every external_id);
//   - one column per OUTGOING relationship type that occurs exactly once on the node, named as the
//     lowercased type (`GOVERNED_BY` → `governed_by`) and holding the target's elementId — so a
//     RelationSpec { fkColumn: "governed_by", relType: ..., fkTable: <target label> } files the edge.
//     ceiling: to-many relationships are dropped (the FK model is to-one); a fanning-out edge type
//     needs an edge-table spec that does not exist yet. A projected column never shadows a node
//     property of the same name — the node's own data wins.

type TxResponse = {
  results?: { data?: { row?: unknown[] }[] }[];
  errors?: { code?: string; message?: string }[];
};

const EXPECTED_URL = "http(s)://user:pass@host:7474/<database>";

/**
 * URL → query fn for makeRdbMappingConnector.
 *
 * `url` is `http(s)://user:pass@host:7474/<database>` — credentials become Basic auth (omitted when
 * the URL has none, for auth-disabled servers) and the path names the database (default `neo4j`).
 */
export function makeNeo4jQuery(
  url: string,
  fetchImpl: typeof fetch = fetch,
): (sql: string) => Promise<Record<string, unknown>[]> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`--neo4j expects ${EXPECTED_URL} (got "${url}")`);
  }
  // A scheme-less "host:7474" PARSES — as scheme "host:" — and only fails later as a mangled fetch
  // to "null/db/…", so the shape is checked here where the message can name what was expected.
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new Error(`--neo4j expects ${EXPECTED_URL} (got "${url}")`);
  const db = u.pathname.replace(/^\/+|\/+$/g, "") || "neo4j";
  const endpoint = `${u.origin}/db/${db}/tx/commit`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (u.username)
    headers.Authorization = `Basic ${Buffer.from(
      `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`,
    ).toString("base64")}`;

  /** One statement → its rows. All transport and in-band failures surface here, named. */
  const post = async (statement: string): Promise<unknown[][]> => {
    let res: Response;
    try {
      res = await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ statements: [{ statement }] }),
      });
    } catch (e) {
      // Node's bare "fetch failed" names neither host nor port; this layer knows both.
      throw new Error(
        `cannot reach Neo4j at ${endpoint}: ${(e as Error).message}`,
      );
    }
    // Read the body on failure too: a 401/404 carries the in-band error ("Invalid credential.",
    // "Database does not exist.") that names the cause the status line only hints at.
    const body = (await res.json().catch(() => ({}))) as TxResponse;
    const failure = body.errors?.[0];
    if (!res.ok || failure) {
      const status = res.ok ? "" : `${res.status} ${res.statusText} `;
      const detail = failure
        ? `${failure.code ?? "error"}: ${failure.message}`
        : `for ${endpoint}`;
      throw new Error(`Neo4j ${status}${detail}`);
    }
    return (body.results?.[0]?.data ?? []).map(({ row }) => row ?? []);
  };

  let labels: Set<string> | undefined;

  return async (sql) => {
    const label = /^SELECT \* FROM (.+)$/.exec(sql)?.[1];
    // The backtick check is not injection defense (the mapping file is trusted operator config, the
    // same ceiling rdb-mapping states) — a backtick would silently end the quoted label and mangle
    // the match, so refuse it by name instead.
    if (!label || label.includes("`"))
      throw new Error(
        `rdb-neo4j serves only the read-mapping's one query shape, SELECT * FROM <label> (got "${sql}")`,
      );
    if (!labels)
      labels = new Set(
        (await post("CALL db.labels()")).map((r) => String(r[0])),
      );
    if (!labels.has(label))
      throw new Error(
        `unknown label "${label}" — labels in this database: ${[...labels].sort().join(", ")}`,
      );
    const rows = await post(
      `MATCH (n:\`${label}\`) RETURN properties(n), elementId(n), ` +
        `[(n)-[r]->(m) | [type(r), elementId(m)]]`,
    );
    return rows.map((row) => {
      const [props, id, edges] = row as [
        Record<string, unknown>,
        string,
        [string, string][],
      ];
      const flat: Record<string, unknown> = { ...props };
      const counts = new Map<string, number>();
      for (const [t] of edges) counts.set(t, (counts.get(t) ?? 0) + 1);
      for (const [t, target] of edges) {
        const col = t.toLowerCase();
        if (counts.get(t) === 1 && !(col in flat)) flat[col] = target;
      }
      flat._id = id;
      return flat;
    });
  };
}
