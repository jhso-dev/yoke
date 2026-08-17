// docs connector (v7.4.1). Confluence or Notion pages → draft `resource` records, dated from the page.
//
// What this is for: the portal's docs question ("is anything written down about this service") needs the
// documents to be records, not a second search box. A `resource` is exactly that — a pointer with a title,
// a URL and a source date — so `/browse?type=resource` becomes the docs index with no new screen, and the
// scorecard's docs check reads the same rows.
//
// What this deliberately does NOT do: extract decisions from page prose. `connect raw` already turns
// unstructured material into proposed records with a model, and a second extractor here would be a second
// answer to "what does this page claim". Point `raw` at exported pages when you want that; this indexes.
//
// Both products in one connector for the reason `tracker` holds Jira and Linear: two request shapes, one
// mapping, and a page is a page.

import type { Connector, SourceItem } from "./types.js";

const PAGE = 50;

interface Doc {
  key: string;
  title: string;
  url: string;
  /** ISO instant the source says the page last changed. */
  at?: string;
}

/**
 * Confluence or Notion → draft `resource` records.
 *
 * @param opts.host Confluence base (`https://acme.atlassian.net/wiki`). Absent → Notion.
 * @param opts.token Confluence: `email:api-token`. Notion: an integration secret.
 * @param opts.space Confluence space key. Ignored by Notion, whose search has no space concept.
 */
export function makeDocsConnector(opts: {
  token: string;
  host?: string;
  space?: string;
  fetchImpl?: typeof fetch;
}): Connector {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const isConfluence = Boolean(opts.host);

  async function* confluence(since?: string): AsyncIterable<Doc> {
    const base = opts.host?.replace(/\/$/, "") ?? "";
    const cql = [
      "type=page",
      opts.space ? `space="${opts.space}"` : "",
      // CQL wants `yyyy/MM/dd HH:mm`, not an ISO instant — the same class of trap as JQL's date literal,
      // and Confluence answers the ISO form with a 400 naming the whole query.
      since
        ? `lastmodified >= "${since.slice(0, 10).replace(/-/g, "/")} ${since.slice(11, 16)}"`
        : "",
    ]
      .filter(Boolean)
      .join(" AND ");
    for (let start = 0; ; start += PAGE) {
      const url = `${base}/rest/api/content/search?${new URLSearchParams({
        cql,
        start: String(start),
        limit: String(PAGE),
        expand: "version",
      })}`;
      const res = await fetchImpl(url, {
        headers: {
          authorization: `Basic ${Buffer.from(opts.token).toString("base64")}`,
          accept: "application/json",
        },
      });
      if (!res.ok)
        throw new Error(
          `confluence search failed (${res.status}): ${await res.text()}`,
        );
      const body = (await res.json()) as {
        results?: {
          id?: string;
          title?: string;
          version?: { when?: string };
          _links?: { webui?: string };
        }[];
      };
      const results = body.results ?? [];
      for (const r of results) {
        if (!r.id || !r.title) continue;
        yield {
          key: r.id,
          title: r.title,
          // `_links.webui` is a path, not a URL; a record whose link does not open is a record nobody
          // trusts twice.
          url: r._links?.webui ? `${base}${r._links.webui}` : base,
          at: r.version?.when,
        };
      }
      if (results.length < PAGE) return;
    }
  }

  async function* notion(since?: string): AsyncIterable<Doc> {
    let cursor: string | undefined;
    for (;;) {
      const res = await fetchImpl("https://api.notion.com/v1/search", {
        method: "POST",
        headers: {
          authorization: `Bearer ${opts.token}`,
          "content-type": "application/json",
          // Required by Notion on every call, and omitting it fails the request rather than defaulting.
          "notion-version": "2022-06-28",
        },
        body: JSON.stringify({
          filter: { property: "object", value: "page" },
          sort: { direction: "ascending", timestamp: "last_edited_time" },
          page_size: PAGE,
          ...(cursor ? { start_cursor: cursor } : {}),
        }),
      });
      if (!res.ok)
        throw new Error(
          `notion search failed (${res.status}): ${await res.text()}`,
        );
      const body = (await res.json()) as {
        results?: {
          id?: string;
          url?: string;
          last_edited_time?: string;
          properties?: Record<string, unknown>;
        }[];
        has_more?: boolean;
        next_cursor?: string | null;
      };
      for (const p of body.results ?? []) {
        if (!p.id) continue;
        const at = p.last_edited_time;
        // Notion's search has no `since`, so the filter is applied here rather than not at all — the sort
        // is ascending, so this drops the older head of the list and keeps paging.
        if (since && at && at < since) continue;
        yield {
          key: p.id,
          title: notionTitle(p.properties) || "(untitled)",
          url: p.url ?? `https://notion.so/${p.id.replace(/-/g, "")}`,
          at,
        };
      }
      if (!body.has_more || !body.next_cursor) return;
      cursor = body.next_cursor;
    }
  }

  return {
    name: isConfluence ? "confluence" : "notion",
    async *pull(since?: string): AsyncIterable<SourceItem> {
      for await (const doc of isConfluence
        ? confluence(since)
        : notion(since)) {
        const externalId = `${isConfluence ? "confluence" : "notion"}:${doc.key}`;
        yield {
          type: "resource",
          attributes: {
            title: doc.title,
            url: doc.url,
            external_id: externalId,
          },
          externalId,
          occurredAt: doc.at,
        };
      }
    },
  };
}

/**
 * A Notion page's title, out of whichever property holds it.
 *
 * Notion has no fixed title field: a page in a database titles itself through whatever property is of type
 * `title`, and that property's name is the database's to choose. Scanning for the type rather than for the
 * name "Name" is why this works on a database somebody renamed.
 */
export function notionTitle(properties: unknown): string {
  if (!properties || typeof properties !== "object") return "";
  for (const value of Object.values(properties as Record<string, unknown>)) {
    const prop = value as { type?: string; title?: { plain_text?: string }[] };
    if (prop?.type !== "title") continue;
    return (prop.title ?? [])
      .map((t) => t.plain_text ?? "")
      .join("")
      .trim();
  }
  return "";
}
