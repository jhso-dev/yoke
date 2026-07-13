// github-pr 커넥터 (PLAN 5.2). GitHub REST v3를 fetch로 직접 호출 (octokit 금지 — 엔드포인트 2개).
// 리뷰 코멘트 1건 → decision draft. 작성자 person 자동 생성은 하지 않는다: actor 매핑 정책
// (GitHub login ↔ person)이 SPEC에 없어 발명 금지 원칙에 걸린다. provenance.actor는 ingest
// 호출자(--actor)로 두고, 코멘트 작성자 login은 attributes.author로 보존한다.

import type { EntityInput } from "../core/types.js";
import type { Connector } from "./types.js";

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
}

/** GitHub PR 리뷰 코멘트 → decision 커넥터. token 없으면 Authorization 생략(공개 레포). */
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
      // GitHub /pulls는 since 파라미터 미지원 — 클라이언트 측 updated_at 필터.
      // updated 내림차순 정렬이므로 경계 도달 시 중단해도 안전하다.
      const pulls = await getJson<PullRequest[]>(
        `${base}/repos/${opts.repo}/pulls?state=all&sort=updated&direction=desc`,
      );
      for (const pr of pulls) {
        if (since && pr.updated_at < since) break;
        const comments = await getJson<ReviewComment[]>(
          `${base}/repos/${opts.repo}/pulls/${pr.number}/comments`,
        );
        for (const c of comments) {
          const item: EntityInput & { externalId: string } = {
            type: "decision",
            attributes: {
              conclusion: c.body,
              rationale: `PR #${pr.number} ${pr.title} 리뷰, ${c.path}:${c.line ?? "?"}`,
              external_id: c.html_url,
              author: c.user?.login ?? "unknown",
            },
            externalId: c.html_url,
          };
          yield item;
        }
      }
    },
  };
}
