// github-pr connector + ingest tests. No real GitHub API calls — a fetchImpl stub returns
// a fixture (1 PR + 2 comments). Verifies mapping accuracy and ingest idempotency (a re-run skips).

import { beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../adapters/storage-sqlite/index.js";
import { commit } from "../core/commit.js";
import { inject } from "../core/inject.js";
import { seedOntology } from "../core/ontology.js";
import { makeGithubPrConnector } from "./github-pr.js";
import { ingest } from "./ingest.js";

const PR = {
  number: 7,
  title: "Add cache",
  merged_at: "2026-07-10T09:00:00Z",
  body: "LRU over TTL because the hot set is small and stable.\n\nRejected: redis (an extra service for 200 keys).",
  html_url: "https://github.com/o/r/pull/7",
  user: { login: "alice" },
};
const COMMENTS = [
  {
    html_url: "https://github.com/o/r/pull/7#discussion_r1",
    body: "use lru_cache here",
    path: "src/cache.ts",
    line: 12,
    user: { login: "alice" },
  },
  {
    html_url: "https://github.com/o/r/pull/7#discussion_r2",
    body: "this ttl is too short",
    path: "src/cache.ts",
    line: 20,
    user: { login: "bob" },
  },
];

/** A fetch stub that routes by URL. Mimics only the minimal Response shape. */
function stubFetch(): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    let body: unknown;
    // The pager stops on an empty page, so every page past the first is empty.
    if (u.includes("/pulls?")) body = u.endsWith("&page=1") ? [PR] : [];
    else if (u.includes("/pulls/7/comments")) body = COMMENTS;
    else throw new Error(`unexpected url: ${u}`);
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as unknown as typeof fetch;
}

const ont = seedOntology();
const now = "2026-07-12T00:00:00Z";

let port: SqliteStorage;
beforeEach(async () => {
  port = new SqliteStorage(":memory:");
  await port.init();
});

describe("github-pr connector", () => {
  it("maps a review comment to a decision EntityInput", async () => {
    const connector = makeGithubPrConnector({
      repo: "o/r",
      fetchImpl: stubFetch(),
    });
    const items = [];
    for await (const item of connector.pull()) items.push(item);

    // The merged PR itself leads: one decision from the artifact the team accepted, then the two
    // review comments.
    expect(items).toHaveLength(3);
    const [merged, first] = items;
    expect(merged.type).toBe("decision");
    expect(merged.attributes.conclusion).toBe("Add cache");
    expect(merged.attributes.rationale).toContain("LRU over TTL");
    expect(merged.attributes.sources).toBe("https://github.com/o/r/pull/7");
    expect(merged.externalId).toBe("pr:o/r#7");
    // Acceptance time, not import time.
    expect(merged.occurredAt).toBe("2026-07-10T09:00:00Z");
    expect(first.type).toBe("decision");
    expect(first.attributes.conclusion).toBe("use lru_cache here");
    expect(first.attributes.rationale).toBe(
      "PR #7 Add cache review, src/cache.ts:12",
    );
    expect(first.attributes.external_id).toBe(
      "https://github.com/o/r/pull/7#discussion_r1",
    );
    expect(first.attributes.author).toBe("alice");
    expect(first.externalId).toBe(
      "https://github.com/o/r/pull/7#discussion_r1",
    );
  });

  it("throws a clear error on a non-ok response", async () => {
    const failing = (async () =>
      ({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        text: async () => "rate limit exceeded",
        json: async () => ({}),
      }) as Response) as unknown as typeof fetch;
    const connector = makeGithubPrConnector({
      repo: "o/r",
      fetchImpl: failing,
    });
    await expect(async () => {
      for await (const _ of connector.pull()) {
        /* consume */
      }
    }).rejects.toThrow(/GitHub API 403 Forbidden/);
  });
});

describe("ingest", () => {
  it("commits each comment as a decision via the gate", async () => {
    const connector = makeGithubPrConnector({
      repo: "o/r",
      fetchImpl: stubFetch(),
    });
    const res = await ingest(port, ont, connector, "yoke:system", now);
    expect(res).toEqual({ added: 3, updated: 0, skipped: 0 });

    const stored = await port.search({
      text: "https://github.com/o/r/pull/7#discussion_r1",
    });
    const hit = stored.find(
      (e) =>
        e.attributes.external_id ===
        "https://github.com/o/r/pull/7#discussion_r1",
    );
    expect(hit?.type).toBe("decision");
    expect(hit?.status).toBe("verified");
    expect(hit?.provenance.origin).toBe("connector:github-pr");
  });

  it("attaches what it captures to the working context when one is named", async () => {
    // Captured knowledge that is only query-reachable never reaches a briefing: a merged PR's
    // decision would be absent from the opening page of the work it was merged into.
    const ws = await commit(
      port,
      ont,
      { type: "collaboration", attributes: { title: "uploads" } },
      { actor: "u", origin: "cli", occurred_at: now },
      now,
    );
    const connector = makeGithubPrConnector({
      repo: "o/r",
      fetchImpl: stubFetch(),
    });
    await ingest(
      port,
      ont,
      connector,
      "u",
      now,
      undefined,
      undefined,
      undefined,
      ws.entity.id,
    );
    const briefed = await inject(port, ont, "", now, { scope: ws.entity.id });
    expect(briefed.items.map((i) => i.entity.attributes.conclusion)).toContain(
      "Add cache",
    );
  });

  it("is idempotent — a second run skips everything already present", async () => {
    const connector = makeGithubPrConnector({
      repo: "o/r",
      fetchImpl: stubFetch(),
    });
    const first = await ingest(port, ont, connector, "yoke:system", now);
    expect(first).toEqual({ added: 3, updated: 0, skipped: 0 });
    const second = await ingest(port, ont, connector, "yoke:system", now);
    expect(second).toEqual({ added: 0, updated: 0, skipped: 3 });
  });
});
