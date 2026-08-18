// docs connector tests (v7.4.1). Stub fetch: the date literals and the title lookup are the connector.

import { describe, expect, it } from "vitest";
import { makeDocsConnector, notionTitle } from "./docs.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

const collect = async (
  c: ReturnType<typeof makeDocsConnector>,
  since?: string,
) => {
  const out = [];
  for await (const item of c.pull(since)) out.push(item);
  return out;
};

describe("docs connector — confluence", () => {
  const page = {
    id: "12345",
    title: "Ledger runbook",
    version: { when: "2026-04-02T10:00:00.000Z" },
    _links: { webui: "/spaces/ENG/pages/12345" },
  };

  it("files a page as a resource with an openable URL and the page's own date", async () => {
    const c = makeDocsConnector({
      host: "https://acme.atlassian.net/wiki/",
      token: "me@acme.com:tok",
      fetchImpl: async () => json({ results: [page] }),
    });
    const [item] = await collect(c);
    expect(item.type).toBe("resource");
    expect(item.attributes.title).toBe("Ledger runbook");
    // `_links.webui` is a path; a record whose link does not open is a record nobody trusts twice.
    expect(item.attributes.url).toBe(
      "https://acme.atlassian.net/wiki/spaces/ENG/pages/12345",
    );
    expect(item.occurredAt).toBe("2026-04-02T10:00:00.000Z");
    expect(item.externalId).toBe("confluence:12345");
  });

  it("converts an ISO since into the CQL date literal, and scopes by space", async () => {
    let seen = "";
    const c = makeDocsConnector({
      host: "https://h/wiki",
      token: "t",
      space: "ENG",
      fetchImpl: async (u) => {
        seen = String(u);
        return json({ results: [] });
      },
    });
    await collect(c, "2026-05-01T09:30:00.000Z");
    const cql = new URL(seen).searchParams.get("cql") ?? "";
    // Confluence answers an ISO instant with a 400 naming the whole query, so the shape matters.
    expect(cql).toContain('lastmodified >= "2026/05/01 09:30"');
    expect(cql).toContain('space="ENG"');
  });

  it("reports an HTTP failure instead of importing nothing quietly", async () => {
    const c = makeDocsConnector({
      host: "https://h",
      token: "t",
      fetchImpl: async () => json({ message: "no" }, 401),
    });
    await expect(collect(c)).rejects.toThrow(
      /confluence search failed \(401\)/,
    );
  });
});

describe("docs connector — notion", () => {
  const page = (over: Record<string, unknown> = {}) => ({
    id: "abc-123",
    url: "https://notion.so/abc123",
    last_edited_time: "2026-06-01T00:00:00.000Z",
    properties: {
      // Deliberately not called "Name": the title property's NAME is the database's to choose.
      Heading: { type: "title", title: [{ plain_text: "Deploy policy" }] },
    },
    ...over,
  });

  it("files a page, finding its title by property TYPE", async () => {
    const c = makeDocsConnector({
      token: "secret",
      fetchImpl: async () => json({ results: [page()], has_more: false }),
    });
    const [item] = await collect(c);
    expect(item.attributes.title).toBe("Deploy policy");
    expect(item.externalId).toBe("notion:abc-123");
  });

  it("sends the version header Notion requires, and follows the cursor", async () => {
    let call = 0;
    const seen: string[] = [];
    const c = makeDocsConnector({
      token: "secret",
      fetchImpl: async (_u, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        seen.push(String(headers["notion-version"]));
        return call++ === 0
          ? json({
              results: [page({ id: "one" })],
              has_more: true,
              next_cursor: "c1",
            })
          : json({ results: [page({ id: "two" })], has_more: false });
      },
    });
    expect((await collect(c)).map((i) => i.externalId)).toEqual([
      "notion:one",
      "notion:two",
    ]);
    // Omitting it fails the request rather than defaulting, so every call must carry it.
    expect(seen.every((v) => v && v !== "undefined")).toBe(true);
  });

  it("applies `since` itself, because Notion's search has no such filter", async () => {
    const c = makeDocsConnector({
      token: "secret",
      fetchImpl: async () =>
        json({
          results: [
            page({ id: "old", last_edited_time: "2026-01-01T00:00:00.000Z" }),
            page({ id: "new", last_edited_time: "2026-07-01T00:00:00.000Z" }),
          ],
          has_more: false,
        }),
    });
    expect(
      (await collect(c, "2026-06-01T00:00:00.000Z")).map((i) => i.externalId),
    ).toEqual(["notion:new"]);
  });
});

describe("notionTitle", () => {
  it("reads whichever property is of type title, and survives a page with none", () => {
    expect(
      notionTitle({
        Renamed: {
          type: "title",
          title: [{ plain_text: "A" }, { plain_text: "B" }],
        },
      }),
    ).toBe("AB");
    expect(notionTitle({ Other: { type: "rich_text" } })).toBe("");
    expect(notionTitle(null)).toBe("");
  });
});
