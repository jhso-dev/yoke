// slack connector tests (PLAN 8.5). No live Slack calls — a fetchImpl stub serves fixtures.
// Verifies message→fact mapping (thread replies included), error surfacing, and ingest idempotency.

import { beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../adapters/storage-sqlite/index.js";
import { seedOntology } from "../core/ontology.js";
import { ingest } from "./ingest.js";
import { makeSlackConnector } from "./slack.js";

const HISTORY = {
  ok: true,
  messages: [
    { ts: "1700.001", text: "we will use sqlite", user: "U1", reply_count: 1 },
    { ts: "1700.002", text: "standup at 10", user: "U2" },
    { ts: "1700.003", user: "U3" }, // no text (upload) → skipped
    // system event WITH text (seen live: join notices) → skipped by subtype
    {
      ts: "1700.004",
      text: "U4 has joined",
      user: "U4",
      subtype: "channel_join",
    },
  ],
};
const REPLIES = {
  ok: true,
  messages: [
    { ts: "1700.001", text: "we will use sqlite", user: "U1" }, // parent — not re-yielded
    { ts: "1700.005", text: "agreed, WAL mode", user: "U2" },
  ],
};

function stubFetch(seen: string[] = []): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    seen.push(u);
    let body: unknown;
    if (u.includes("conversations.history")) body = HISTORY;
    else if (u.includes("conversations.replies")) body = REPLIES;
    else throw new Error(`unexpected url: ${u}`);
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
}

const ont = seedOntology();
const now = "2026-07-13T00:00:00Z";

let port: SqliteStorage;
beforeEach(async () => {
  port = new SqliteStorage(":memory:");
  await port.init();
});

describe("slack connector", () => {
  it("maps channel messages and thread replies to draft facts", async () => {
    const connector = makeSlackConnector({
      channel: "C123",
      token: "t",
      fetchImpl: stubFetch(),
    });
    const items = [];
    for await (const item of connector.pull()) items.push(item);

    expect(items.map((i) => i.externalId)).toEqual([
      "slack:C123:1700.001",
      "slack:C123:1700.005", // thread reply, parent not duplicated
      "slack:C123:1700.002",
    ]);
    const [first] = items;
    expect(first.type).toBe("fact");
    expect(first.attributes.statement).toBe("we will use sqlite");
    expect(first.attributes.author).toBe("U1");
    expect(first.attributes.external_id).toBe("slack:C123:1700.001");
  });

  it("passes since as oldest (ISO converted to unix seconds)", async () => {
    const seen: string[] = [];
    const connector = makeSlackConnector({
      channel: "C123",
      token: "t",
      fetchImpl: stubFetch(seen),
    });
    for await (const _ of connector.pull("2026-07-01T00:00:00Z")) {
      // drain
    }
    expect(seen[0]).toContain(
      `oldest=${String(Date.parse("2026-07-01T00:00:00Z") / 1000)}`,
    );
  });

  it("throws a clear error on HTTP failure and on Slack ok:false", async () => {
    const http500 = (async () =>
      ({
        ok: false,
        status: 500,
        statusText: "boom",
      }) as Response) as unknown as typeof fetch;
    const c1 = makeSlackConnector({
      channel: "C123",
      token: "t",
      fetchImpl: http500,
    });
    await expect(c1.pull()[Symbol.asyncIterator]().next()).rejects.toThrow(
      /Slack API 500/,
    );

    const notOk = (async () =>
      ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ ok: false, error: "invalid_auth" }),
      }) as unknown as Response) as unknown as typeof fetch;
    const c2 = makeSlackConnector({
      channel: "C123",
      token: "t",
      fetchImpl: notOk,
    });
    await expect(c2.pull()[Symbol.asyncIterator]().next()).rejects.toThrow(
      /invalid_auth/,
    );
  });

  it("retries on 429 honoring Retry-After (seen live: replies rate limit)", async () => {
    let calls = 0;
    const rateLimitedOnce = (async (_url: string | URL) => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          headers: { get: (h: string) => (h === "retry-after" ? "0" : null) },
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => HISTORY,
      } as Response;
    }) as unknown as typeof fetch;

    const c = makeSlackConnector({
      channel: "C123",
      token: "t",
      fetchImpl: rateLimitedOnce,
    });
    const first = await c.pull()[Symbol.asyncIterator]().next();
    expect(calls).toBe(2); // 429 → retried → succeeded
    expect(first.done).toBe(false);
  });

  it("ingest is idempotent on re-run (external_id skip)", async () => {
    const make = () =>
      makeSlackConnector({
        channel: "C123",
        token: "t",
        fetchImpl: stubFetch(),
      });
    const first = await ingest(port, ont, make(), "alice", now);
    expect(first).toEqual({ added: 3, updated: 0, skipped: 0 });
    const second = await ingest(port, ont, make(), "alice", now);
    expect(second).toEqual({ added: 0, updated: 0, skipped: 3 });
    const drafts = (await port.listEntities({ status: "draft" })).items;
    expect(drafts).toHaveLength(3);
    expect(drafts.every((e) => e.type === "fact")).toBe(true);
  });
});

// Every connector stamped the import time, so the type's TTL counted from the sync: an imported archive
// never went stale, never reached `review --stale`, and was injected as current knowledge indefinitely.
// The Slack `ts` was already in hand at the line that builds the external id.
describe("an imported message ages from when it was posted", () => {
  /** A one-message channel, so the assertion is about that message's own instant. */
  const oneMessage = (ts: string, text: string): typeof fetch =>
    (async (url: string | URL) => {
      const u = String(url);
      const body = u.includes("conversations.history")
        ? { ok: true, messages: [{ ts, text, user: "U1" }] }
        : { ok: true, messages: [] };
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => body,
      } as Response;
    }) as unknown as typeof fetch;

  it("records the source instant, not the import clock", async () => {
    // 1785900010.000200 = 2026-08-05T03:20:10Z. The fraction is Slack's 6-digit disambiguator, finer
    // than a millisecond, so it does not survive into an ISO instant — the second is what matters for a
    // TTL measured in days.
    const connector = makeSlackConnector({
      channel: "C1",
      token: "t",
      fetchImpl: oneMessage("1785900010.000200", "archived knowledge"),
    });
    const importedAt = "2026-08-13T00:00:00Z";
    await ingest(port, ont, connector, "alice", importedAt);
    const [rec] = await port.search({ text: "archived knowledge" });
    expect(rec.provenance.occurred_at).toBe("2026-08-05T03:20:10.000Z");
    // `last_confirmed` too: freshness is measured from it, so leaving it at the import clock keeps the
    // record fresh however old the message is.
    expect(rec.last_confirmed).toBe("2026-08-05T03:20:10.000Z");
    expect(rec.last_confirmed).not.toBe(importedAt);
  });

  it("falls back to the import clock when the source instant is unusable", async () => {
    // Absent or unparseable means "the source does not say", and an ingestion timestamp is at least
    // honest about being one.
    const connector = makeSlackConnector({
      channel: "C1",
      token: "t",
      fetchImpl: oneMessage("not-a-ts", "undated knowledge"),
    });
    const importedAt = "2026-08-13T00:00:00Z";
    await ingest(port, ont, connector, "alice", importedAt);
    const [rec] = await port.search({ text: "undated knowledge" });
    expect(rec.last_confirmed).toBe(importedAt);
  });
});
