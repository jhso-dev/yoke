// tracker connector (v7.1.4). Jira or Linear issues → draft records, dated from the issue.
//
// Why a tracker: `github-pr` catches decisions argued in code review, but scope, priority and product
// decisions are argued in tickets, and those are the PO/PD half of ADOPTION.md's role table. Both APIs
// are a single paginated search, so this is one connector with two request shapes rather than two files.
//
// A ticket is not a decision. Only an issue that RESOLVED something becomes a `decision` — the field
// both trackers already carry for that is the completion state — and everything else becomes a `fact`
// stating what the ticket says. That mapping is deliberately mechanical: no NLP guess at whether a
// description "sounds like" a decision, because the reviewer at the gate is the judgment (the same rule
// slack and notes follow).

import type { Connector, SourceItem } from "./types.js";

/** How many issues one request asks for. Both APIs cap well above this; smaller pages retry cheaper. */
const PAGE = 50;

interface Issue {
  key: string;
  title: string;
  body: string;
  /** ISO instant the tracker says the issue reached its current state. */
  at?: string;
  resolved: boolean;
  url?: string;
}

const trimmed = (s: unknown): string => (typeof s === "string" ? s.trim() : "");

/** ADF node types that are their own line. Everything else is inline and concatenates. */
const ADF_BLOCK = new Set([
  "paragraph",
  "heading",
  "listItem",
  "blockquote",
  "codeBlock",
  "panel",
  "rule",
]);

/**
 * Jira's ADF description arrives as a node tree; take its text leaves in order.
 *
 * The separator is chosen per CHILD, not per parent. Choosing it from the parent joined the inline spans
 * INSIDE a paragraph with newlines — so any description containing bold, code or a link, which is most of
 * them, came out one line per span and became the `decision.rationale` in that state. It also joined a
 * bulletList's items with nothing, running the entries together.
 */
export function adfText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (typeof n.text === "string") return n.text;
  let out = "";
  for (const child of n.content ?? []) {
    const text = adfText(child);
    if (!text) continue;
    const type = (child as { type?: string })?.type ?? "";
    out += out && ADF_BLOCK.has(type) ? `\n${text}` : text;
  }
  return out;
}

interface JiraIssue {
  key: string;
  fields?: {
    summary?: string;
    description?: unknown;
    resolutiondate?: string | null;
    updated?: string;
    status?: { statusCategory?: { key?: string } };
  };
}

interface LinearIssue {
  identifier: string;
  title?: string;
  description?: string | null;
  completedAt?: string | null;
  updatedAt?: string;
  url?: string;
}

/**
 * Jira or Linear → draft records.
 *
 * @param opts.host Jira site (`https://acme.atlassian.net`). Absent → Linear.
 * @param opts.token Jira: `email:api-token` (the pair Jira's basic auth wants). Linear: the API key.
 * @param opts.project Jira project key or Linear team key. Absent → every issue the token can read.
 */
export function makeTrackerConnector(opts: {
  token: string;
  host?: string;
  project?: string;
  fetchImpl?: typeof fetch;
}): Connector {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const isJira = Boolean(opts.host);

  async function* jira(since?: string): AsyncIterable<Issue> {
    const clauses = [
      opts.project ? `project = "${opts.project}"` : "",
      // JQL's own date literal, which is minute-resolution and space-separated — not ISO. Converted here
      // rather than passed through, because Jira answers an ISO instant with a 400 that names the whole JQL
      // string instead of the field, and the run would read as a broken query.
      since ? `updated >= "${since.slice(0, 16).replace("T", " ")}"` : "",
    ].filter(Boolean);
    const jql = `${clauses.join(" AND ")}${clauses.length ? " " : ""}ORDER BY updated ASC`;
    // `/search/jql` with `nextPageToken`, not `/search` with `startAt`. Atlassian removed the offset-paged
    // endpoint from Jira Cloud, so the old call returns 410/404 there — this connector could import nothing
    // from a Cloud site while its tests, which stub fetch, stayed green.
    let nextPageToken: string | undefined;
    for (;;) {
      const url = `${opts.host?.replace(/\/$/, "")}/rest/api/3/search/jql?${new URLSearchParams(
        {
          jql,
          maxResults: String(PAGE),
          fields: "summary,description,resolutiondate,updated,status",
          ...(nextPageToken ? { nextPageToken } : {}),
        },
      )}`;
      const res = await fetchImpl(url, {
        headers: {
          authorization: `Basic ${Buffer.from(opts.token).toString("base64")}`,
          accept: "application/json",
        },
      });
      if (!res.ok)
        throw new Error(
          `jira search failed (${res.status}): ${await res.text()}`,
        );
      const body = (await res.json()) as {
        issues?: JiraIssue[];
        nextPageToken?: string;
        isLast?: boolean;
      };
      for (const i of body.issues ?? []) {
        const f = i.fields ?? {};
        yield {
          key: i.key,
          title: trimmed(f.summary),
          body: adfText(f.description).trim(),
          at: f.resolutiondate ?? f.updated,
          // The status CATEGORY, not the status name: every Jira project renames its columns, so a
          // connector matching on "Done" reads as working and captures nothing on a project that says
          // "Shipped".
          resolved: f.status?.statusCategory?.key === "done",
          url: `${opts.host?.replace(/\/$/, "")}/browse/${i.key}`,
        };
      }
      // `isLast` is the documented signal; an absent token is the same answer from an older backend.
      if (body.isLast || !body.nextPageToken) return;
      nextPageToken = body.nextPageToken;
    }
  }

  async function* linear(since?: string): AsyncIterable<Issue> {
    const query = `query($after: String, $filter: IssueFilter) {
      issues(first: ${PAGE}, after: $after, filter: $filter, orderBy: updatedAt) {
        pageInfo { hasNextPage endCursor }
        nodes { identifier title description completedAt updatedAt url }
      }
    }`;
    const filter: Record<string, unknown> = {};
    if (opts.project) filter.team = { key: { eq: opts.project } };
    if (since) filter.updatedAt = { gte: since };
    let after: string | null = null;
    for (;;) {
      const res = await fetchImpl("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
          authorization: opts.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query, variables: { after, filter } }),
      });
      if (!res.ok)
        throw new Error(
          `linear query failed (${res.status}): ${await res.text()}`,
        );
      const body = (await res.json()) as {
        errors?: { message?: string }[];
        data?: {
          issues?: {
            pageInfo?: { hasNextPage?: boolean; endCursor?: string };
            nodes?: LinearIssue[];
          };
        };
      };
      // GraphQL answers an invalid query with 200 and an `errors` array, so a connector that only
      // checks the status code imports nothing and reports success.
      if (body.errors?.length)
        throw new Error(
          `linear query failed: ${body.errors.map((e) => e.message).join("; ")}`,
        );
      for (const n of body.data?.issues?.nodes ?? [])
        yield {
          key: n.identifier,
          title: trimmed(n.title),
          body: trimmed(n.description),
          at: n.completedAt ?? n.updatedAt,
          resolved: Boolean(n.completedAt),
          url: n.url,
        };
      const page = body.data?.issues?.pageInfo;
      if (!page?.hasNextPage || !page.endCursor) return;
      after = page.endCursor;
    }
  }

  return {
    name: isJira ? "jira" : "linear",
    async *pull(since?: string): AsyncIterable<SourceItem> {
      for await (const issue of isJira ? jira(since) : linear(since)) {
        if (!issue.title) continue;
        const externalId = `${isJira ? "jira" : "linear"}:${issue.key}`;
        const shared = {
          external_id: externalId,
          ...(issue.url ? { sources: issue.url } : {}),
        };
        yield issue.resolved
          ? {
              type: "decision",
              attributes: {
                conclusion: issue.title,
                // The gate requires a rationale, and an issue with an empty description still has the
                // fact of where it was decided — which is more useful to a reviewer than a refusal.
                rationale: issue.body || `Resolved in ${issue.key}`,
                ...shared,
              },
              externalId,
              occurredAt: issue.at,
            }
          : {
              type: "fact",
              attributes: {
                title: issue.title,
                statement: issue.body || issue.title,
                ...shared,
              },
              externalId,
              occurredAt: issue.at,
            };
      }
    },
  };
}
