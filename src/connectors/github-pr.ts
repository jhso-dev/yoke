// github-pr connector (PLAN 5.2). Calls GitHub REST v3 directly with fetch (no octokit — only 2 endpoints).
// One review comment → one decision draft. It does not auto-create an author person: no actor-mapping
// policy (GitHub login ↔ person) exists in the SPEC, so inventing one violates the no-invention rule.
// provenance.actor is left to the ingest caller (--actor), and the comment author's login is preserved in attributes.author.

import type { Connector, SourceItem } from "./types.js";

interface PullRequest {
  number: number;
  title: string;
  updated_at: string;
}

interface ReviewComment {
  html_url: string;
  body: string;
  path: string;
  line: number | null;
  user: { login: string } | null;
  /** When the comment was written. Optional in the type because a fixture may omit it. */
  created_at?: string;
}

/** GitHub PR review comment → decision connector. Omits Authorization when there's no token (public repos). */
export function makeGithubPrConnector(opts: {
  repo: string;
  token?: string;
  fetchImpl?: typeof fetch;
}): Connector {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = "https://api.github.com";
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "yoke",
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  async function getJson<T>(url: string): Promise<T> {
    const res = await fetchImpl(url, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `GitHub API ${res.status} ${res.statusText} for ${url}${body ? `: ${body}` : ""}`,
      );
    }
    return (await res.json()) as T;
  }

  return {
    name: "github-pr",
    async *pull(since?: string) {
      // GitHub /pulls has no `since` parameter — filter on updated_at client-side.
      // Sorted by updated descending, so stopping once we cross the boundary is safe.
      const pulls = await getJson<PullRequest[]>(
        `${base}/repos/${opts.repo}/pulls?state=all&sort=updated&direction=desc`,
      );
      for (const pr of pulls) {
        if (since && pr.updated_at < since) break;
        const comments = await getJson<ReviewComment[]>(
          `${base}/repos/${opts.repo}/pulls/${pr.number}/comments`,
        );
        for (const c of comments) {
          const item: SourceItem = {
            type: "decision",
            attributes: {
              conclusion: c.body,
              rationale: `PR #${pr.number} ${pr.title} review, ${c.path}:${c.line ?? "?"}`,
              external_id: c.html_url,
              author: c.user?.login ?? "unknown",
            },
            externalId: c.html_url,
            // The review comment's own timestamp, so an imported PR archive ages from when the review
            // happened rather than from when the import ran. `created_at` and not `updated_at`: the
            // judgment was made when it was written, and an edit to wording does not renew it.
            occurredAt: c.created_at,
          };
          yield item;
        }
      }
    },
  };
}
