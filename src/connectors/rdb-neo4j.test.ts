// rdb-neo4j query shim tests. No live Neo4j — a fetchImpl stub serves transactional-endpoint
// fixtures (db.labels() included, since the shim validates labels before matching). Verifies the
// one-shape SQL→Cypher translation, label validation, row flattening (properties, `_id`, to-one
// edge projection), and error surfacing (URL shape, network, HTTP status, in-band).

import { describe, expect, it } from "vitest";
import { makeNeo4jQuery } from "./rdb-neo4j.js";

type Row = { row: unknown[] };
type Seen = { urls: string[]; inits: RequestInit[] };

/** Serves db.labels() from the fixture keys and each label's rows, like the real endpoint. */
function stubFetch(
  fixtures: Record<string, Row[]>,
  seen: Seen = { urls: [], inits: [] },
): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    seen.urls.push(String(url));
    if (init) seen.inits.push(init);
    const { statements } = JSON.parse(String(init?.body)) as {
      statements: { statement: string }[];
    };
    const stmt = statements[0].statement;
    const data = /db\.labels/.test(stmt)
      ? Object.keys(fixtures).map((l) => ({ row: [l] }))
      : (fixtures[/MATCH \(n:`([^`]+)`\)/.exec(stmt)?.[1] ?? ""] ?? []);
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ results: [{ data }], errors: [] }),
    };
  }) as unknown as typeof fetch;
}

describe("makeNeo4jQuery", () => {
  it("translates the read-mapping's one query shape and hits the tx endpoint with Basic auth", async () => {
    const seen: Seen = { urls: [], inits: [] };
    const query = makeNeo4jQuery(
      "http://alice:s3cret@localhost:7474/kg",
      stubFetch({ Policy: [] }, seen),
    );
    await query("SELECT * FROM Policy");
    expect(seen.urls[0]).toBe("http://localhost:7474/db/kg/tx/commit");
    const bodies = seen.inits.map(
      (i) =>
        (JSON.parse(String(i.body)) as { statements: { statement: string }[] })
          .statements[0].statement,
    );
    expect(bodies[0]).toContain("db.labels");
    expect(bodies[1]).toContain("MATCH (n:`Policy`)");
    const headers = (seen.inits[0].headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from("alice:s3cret").toString("base64")}`,
    );
  });

  it("defaults the database to neo4j, sends no auth header without credentials, and fetches labels once", async () => {
    const seen: Seen = { urls: [], inits: [] };
    const query = makeNeo4jQuery(
      "http://localhost:7474",
      stubFetch({ Policy: [] }, seen),
    );
    await query("SELECT * FROM Policy");
    await query("SELECT * FROM Policy");
    expect(seen.urls[0]).toBe("http://localhost:7474/db/neo4j/tx/commit");
    const headers = (seen.inits[0].headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(seen.urls).toHaveLength(3); // labels once + two matches
  });

  it("flattens properties, sets _id, and projects to-one edges as lowercased columns", async () => {
    const query = makeNeo4jQuery(
      "http://localhost:7474",
      stubFetch({
        Policy: [
          {
            row: [
              { title: "refund policy", updated_at: "2026-01-05" },
              "4:abc:1",
              [
                ["GOVERNED_BY", "4:abc:9"], // to-one → projected
                ["MENTIONS", "4:abc:2"], // to-many → dropped
                ["MENTIONS", "4:abc:3"],
              ],
            ],
          },
        ],
      }),
    );
    const rows = await query("SELECT * FROM Policy");
    expect(rows).toEqual([
      {
        title: "refund policy",
        updated_at: "2026-01-05",
        governed_by: "4:abc:9",
        _id: "4:abc:1",
      },
    ]);
  });

  it("never lets a projected edge shadow a node property of the same name", async () => {
    const query = makeNeo4jQuery(
      "http://localhost:7474",
      stubFetch({
        Policy: [
          {
            row: [
              { owner: "a real property" },
              "4:abc:1",
              [["OWNER", "4:abc:9"]],
            ],
          },
        ],
      }),
    );
    const rows = await query("SELECT * FROM Policy");
    expect(rows[0].owner).toBe("a real property");
  });

  it("refuses a label the database does not have, naming the ones it does", async () => {
    const query = makeNeo4jQuery(
      "http://localhost:7474",
      stubFetch({ Policy: [], Guideline: [] }),
    );
    await expect(query("SELECT * FROM Polcy")).rejects.toThrow(
      /unknown label "Polcy" — labels in this database: Guideline, Policy/,
    );
  });

  it("refuses any SQL that is not the read-mapping's one shape", async () => {
    const query = makeNeo4jQuery("http://localhost:7474", stubFetch({}));
    await expect(query("SELECT id FROM Policy")).rejects.toThrow(
      /one query shape/,
    );
    await expect(query("SELECT * FROM Poli`cy")).rejects.toThrow(
      /one query shape/,
    );
  });

  it("refuses a URL that is not http(s), by expected shape", () => {
    expect(() => makeNeo4jQuery("localhost:7474")).toThrow(
      /--neo4j expects http\(s\):\/\//,
    );
    expect(() => makeNeo4jQuery("not a url at all")).toThrow(
      /--neo4j expects http\(s\):\/\//,
    );
  });

  it("names the endpoint when the server is unreachable", async () => {
    const query = makeNeo4jQuery("http://localhost:7474", (async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch);
    await expect(query("SELECT * FROM Policy")).rejects.toThrow(
      /cannot reach Neo4j at http:\/\/localhost:7474\/db\/neo4j\/tx\/commit/,
    );
  });

  it("surfaces the in-band error body on a failed status, not just the status line", async () => {
    const query = makeNeo4jQuery("http://localhost:7474", (async () => ({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      json: async () => ({
        errors: [
          {
            code: "Neo.ClientError.Security.Unauthorized",
            message: "Invalid credential.",
          },
        ],
      }),
    })) as unknown as typeof fetch);
    await expect(query("SELECT * FROM Policy")).rejects.toThrow(
      /401 Unauthorized Neo\.ClientError\.Security\.Unauthorized: Invalid credential\./,
    );
  });

  it("surfaces in-band Cypher errors as a throw, not an empty label", async () => {
    const query = makeNeo4jQuery("http://localhost:7474", (async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        results: [],
        errors: [{ code: "Neo.ClientError", message: "boom" }],
      }),
    })) as unknown as typeof fetch);
    await expect(query("SELECT * FROM Policy")).rejects.toThrow(
      /Neo\.ClientError: boom/,
    );
  });
});
