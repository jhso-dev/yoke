// github-pr connector. Calls GitHub REST v3 directly with fetch
// (no octokit — only 2 endpoints). Two kinds of source item:
//   - a MERGED pull request → one decision. The merge is the team's acceptance of the change, and
//     the PR body is text a human wrote and reviewers read — the one capture point that costs the
//     author nothing extra (the plan's "merge button is the capture moment").
//   - one review comment → one decision (the original path; measured precision decides its future).
// It does not auto-create an author person: no actor-mapping policy (GitHub login ↔ person) exists
// in the SPEC, so inventing one violates the no-invention rule. provenance.actor is left to the
// ingest caller (--actor); the GitHub login is preserved in attributes.author.

import type { Connector, SourceItem } from "./types.js";

interface PullRequest {
  number: number;
  title: string;
  updated_at: string;
  merged_at?: string | null;
  body?: string | null;
  html_url?: string;
  user?: { login: string } | null;
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
      // Sorted by updated descending, so stopping once we cross the boundary is safe. Paged,
      // because the default page is 30 and a backfill of a repo's history is exactly the call
      // that has more (measured: 53 merged PRs, 28 captured before this loop existed).
      // ceiling: 20 pages (2,000 PRs) — a bound, not a cursor; past it, run again with --since.
      pages: for (let page = 1; page <= 20; page++) {
        const pulls = await getJson<PullRequest[]>(
          `${base}/repos/${opts.repo}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${page}`,
        );
        if (pulls.length === 0) break;
        for (const pr of pulls) {
          if (since && pr.updated_at < since) break pages;
          if (pr.merged_at) {
            // The body is quoted, not summarized: a connector inventing a conclusion would be writing
            // knowledge nobody recorded. Bounded so one exhaustive PR essay does not become the
            // largest record in the store; the pointer carries the rest.
            const body = (pr.body ?? "").trim();
            yield {
              type: "decision",
              attributes: {
                conclusion: pr.title,
                rationale: body
                  ? body.length > 2000
                    ? `${body.slice(0, 2000)}…`
                    : body
                  : `merged without a description (PR #${pr.number})`,
                sources: pr.html_url ?? `${opts.repo}#${pr.number}`,
                author: pr.user?.login ?? "unknown",
              },
              externalId: `pr:${opts.repo}#${pr.number}`,
              // The merge instant, not the import run: acceptance is when the decision happened.
              occurredAt: pr.merged_at,
            } as SourceItem;
          }
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
      }
    },
  };
}
