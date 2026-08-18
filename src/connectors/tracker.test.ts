// tracker connector tests (v7.1.4). A stub fetch, because the mapping and the pagination ARE the
// connector — and because a test that needs a Jira site is a test nobody runs.

import { describe, expect, it } from "vitest";
import { adfText, makeTrackerConnector } from "./tracker.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

const collect = async (
  c: ReturnType<typeof makeTrackerConnector>,
  since?: string,
) => {
  const out = [];
  for await (const item of c.pull(since)) out.push(item);
  return out;
};

const jiraIssue = (over: Record<string, unknown> = {}) => ({
  key: "PAY-42",
  fields: {
    summary: "Settle refunds through the ledger, not the PG",
    description: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "The PG's totals drifted from ours." },
          ],
        },
      ],
    },
    resolutiondate: "2026-05-04T09:00:00.000Z",
    updated: "2026-05-05T09:00:00.000Z",
    status: { statusCategory: { key: "done" } },
    ...over,
  },
});

describe("tracker connector — jira", () => {
  it("files a resolved issue as a decision, dated when it was resolved", async () => {
    const c = makeTrackerConnector({
      host: "https://acme.atlassian.net",
      token: "me@acme.com:tok",
      project: "PAY",
      fetchImpl: async () => json({ issues: [jiraIssue()], isLast: true }),
    });
    const [item] = await collect(c);
    expect(item.type).toBe("decision");
    expect(item.attributes.conclusion).toBe(
      "Settle refunds through the ledger, not the PG",
    );
    expect(item.attributes.rationale).toBe(
      "The PG's totals drifted from ours.",
    );
    expect(item.externalId).toBe("jira:PAY-42");
    // The resolution date, not `updated`: freshness should count from when the decision was made.
    expect(item.occurredAt).toBe("2026-05-04T09:00:00.000Z");
    expect(item.attributes.sources).toBe(
      "https://acme.atlassian.net/browse/PAY-42",
    );
  });

  it("files an open issue as a fact", async () => {
    const c = makeTrackerConnector({
      host: "https://acme.atlassian.net",
      token: "me@acme.com:tok",
      fetchImpl: async () =>
        json({
          issues: [
            jiraIssue({
              resolutiondate: null,
              status: { statusCategory: { key: "indeterminate" } },
            }),
          ],
          isLast: true,
        }),
    });
    const [item] = await collect(c);
    expect(item.type).toBe("fact");
    expect(item.occurredAt).toBe("2026-05-05T09:00:00.000Z");
  });

  it("reads the status CATEGORY, so a renamed column still resolves", async () => {
    const c = makeTrackerConnector({
      host: "https://acme.atlassian.net",
      token: "t",
      fetchImpl: async () =>
        json({
          issues: [
            // A project that calls its final column "Shipped". Matching on the NAME would capture
            // nothing here while looking like a working run.
            jiraIssue({ status: { statusCategory: { key: "done" } } }),
          ],
          isLast: true,
        }),
    });
    const [item] = await collect(c);
    expect(item.type).toBe("decision");
  });

  it("converts an ISO since into the minute-resolution literal JQL accepts", async () => {
    let seen = "";
    const c = makeTrackerConnector({
      host: "https://acme.atlassian.net",
      token: "t",
      project: "PAY",
      fetchImpl: async (u) => {
        seen = String(u);
        return json({ issues: [], isLast: true });
      },
    });
    await collect(c, "2026-05-01T00:00:00.000Z");
    const jql = new URL(seen).searchParams.get("jql") ?? "";
    expect(jql).toContain('updated >= "2026-05-01 00:00"');
    expect(jql).toContain('project = "PAY"');
  });

  it("calls the Cloud endpoint and follows nextPageToken", async () => {
    // `/search` with `startAt` was removed from Jira Cloud, so the old call imported nothing from a Cloud
    // site while a stubbed test stayed green. Both halves asserted: the path and the pagination signal.
    const paths: string[] = [];
    let call = 0;
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        ...jiraIssue(),
        key: `PAY-${i}`,
      }));
    const ok = makeTrackerConnector({
      host: "https://h",
      token: "t",
      fetchImpl: async (u) => {
        paths.push(new URL(String(u)).pathname);
        return call++ === 0
          ? json({ issues: many(50), nextPageToken: "tok", isLast: false })
          : json({ issues: many(3), isLast: true });
      },
    });
    expect(await collect(ok)).toHaveLength(53);
    expect(paths).toEqual(["/rest/api/3/search/jql", "/rest/api/3/search/jql"]);
  });

  it("reports an HTTP failure instead of importing nothing", async () => {
    const bad = makeTrackerConnector({
      host: "https://h",
      token: "t",
      fetchImpl: async () => json({ message: "nope" }, 401),
    });
    await expect(collect(bad)).rejects.toThrow(/jira search failed \(401\)/);
  });
});

describe("tracker connector — linear", () => {
  const node = (over: Record<string, unknown> = {}) => ({
    identifier: "ENG-7",
    title: "Move the recommender to per-request features",
    description: "Batch features went stale between runs.",
    completedAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
    url: "https://linear.app/acme/issue/ENG-7",
    ...over,
  });

  it("files a completed issue as a decision", async () => {
    const c = makeTrackerConnector({
      token: "lin_key",
      fetchImpl: async () =>
        json({
          data: {
            issues: { pageInfo: { hasNextPage: false }, nodes: [node()] },
          },
        }),
    });
    const [item] = await collect(c);
    expect(item.type).toBe("decision");
    expect(item.externalId).toBe("linear:ENG-7");
    expect(item.occurredAt).toBe("2026-06-01T00:00:00.000Z");
  });

  it("fails loudly on a GraphQL error answered with HTTP 200", async () => {
    // The trap this exists for: 200 + `errors` means a connector that checks only the status code
    // imports nothing and reports success.
    const c = makeTrackerConnector({
      token: "k",
      fetchImpl: async () => json({ errors: [{ message: "unknown field" }] }),
    });
    await expect(collect(c)).rejects.toThrow(/unknown field/);
  });

  it("follows the cursor", async () => {
    let call = 0;
    const c = makeTrackerConnector({
      token: "k",
      fetchImpl: async () =>
        call++ === 0
          ? json({
              data: {
                issues: {
                  pageInfo: { hasNextPage: true, endCursor: "c1" },
                  nodes: [node({ identifier: "ENG-1" })],
                },
              },
            })
          : json({
              data: {
                issues: {
                  pageInfo: { hasNextPage: false },
                  nodes: [node({ identifier: "ENG-2" })],
                },
              },
            }),
    });
    expect((await collect(c)).map((i) => i.externalId)).toEqual([
      "linear:ENG-1",
      "linear:ENG-2",
    ]);
  });
});

describe("adfText", () => {
  it("keeps paragraph boundaries and drops the node scaffolding", () => {
    expect(
      adfText({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "one" }] },
          { type: "paragraph", content: [{ type: "text", text: "two" }] },
        ],
      }),
    ).toBe("one\ntwo");
    expect(adfText(null)).toBe("");
  });

  it("concatenates the inline spans INSIDE a paragraph", () => {
    // Bold, code and links split a paragraph into spans, which is most real descriptions. Choosing the
    // separator from the parent put a newline between each one, and that text became the rationale.
    expect(
      adfText({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "The PG totals " },
              { type: "text", text: "drifted", marks: [{ type: "strong" }] },
              { type: "text", text: " from ours." },
            ],
          },
        ],
      }),
    ).toBe("The PG totals drifted from ours.");
  });

  it("puts each list item on its own line", () => {
    // The other half of the same bug: a bulletList's items were joined with nothing and ran together.
    expect(
      adfText({
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "one" }],
                  },
                ],
              },
              {
                type: "listItem",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "two" }],
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toBe("one\ntwo");
  });
});
