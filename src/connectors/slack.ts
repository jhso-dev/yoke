// slack connector (PLAN 8.5). Calls the Slack Web API directly with fetch (no SDK — 2 endpoints).
// One channel message (thread replies included) → one draft fact. Mapping is deliberately dumb:
// no decision-marker NLP — humans promote what matters via review/verify (the governance model).
// external_id = slack:<channel>:<ts> (stable message address; a permalink needs an extra API call).

import type { EntityInput } from "../core/types.js";
import type { Connector } from "./types.js";

interface SlackMessage {
  ts: string;
  text?: string;
  user?: string;
  reply_count?: number;
  subtype?: string;
}

interface SlackPage {
  ok: boolean;
  error?: string;
  messages?: SlackMessage[];
  response_metadata?: { next_cursor?: string };
}

/** Slack channel → draft fact connector. since accepts a unix ts (Slack native) or ISO 8601. */
export function makeSlackConnector(opts: {
  channel: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Connector {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = "https://slack.com/api";

  async function getPage(
    method: string,
    params: Record<string, string>,
  ): Promise<SlackPage> {
    const url = `${base}/${method}?${new URLSearchParams(params)}`;
    // conversations.replies fires once per threaded message, so a busy channel
    // trips Slack's rate limit quickly (seen live: 429 mid-sync). Honor
    // Retry-After and retry a few times before giving up.
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${opts.token}` },
      });
      if (res.status === 429 && attempt < 5) {
        const wait = Number(res.headers.get("retry-after") ?? "5");
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      if (!res.ok)
        throw new Error(`Slack API ${res.status} ${res.statusText} for ${url}`);
      const body = (await res.json()) as SlackPage;
      if (!body.ok)
        throw new Error(
          `Slack API error for ${method}: ${body.error ?? "unknown"}`,
        );
      return body;
    }
  }

  function toItem(
    m: SlackMessage,
  ): (EntityInput & { externalId: string }) | null {
    // Skip system events (channel_join, bot_message, etc.) — seen live: join
    // notices carry text and were landing in the review queue as noise.
    if (m.subtype) return null;
    if (!m.text) return null; // uploads etc. carry no statement
    const externalId = `slack:${opts.channel}:${m.ts}`;
    return {
      type: "fact",
      attributes: {
        statement: m.text,
        author: m.user ?? "unknown",
        external_id: externalId,
      },
      externalId,
    };
  }

  return {
    name: "slack",
    async *pull(since?: string) {
      // Slack's oldest is a unix timestamp; accept ISO 8601 too (the CLI convention elsewhere).
      const oldest =
        since === undefined
          ? undefined
          : Number.isNaN(Number(since))
            ? String(Date.parse(since) / 1000)
            : since;
      let cursor: string | undefined;
      do {
        const params: Record<string, string> = { channel: opts.channel };
        if (oldest) params.oldest = oldest;
        if (cursor) params.cursor = cursor;
        const page = await getPage("conversations.history", params);
        for (const m of page.messages ?? []) {
          const item = toItem(m);
          if (item) yield item;
          if (m.reply_count) {
            // ponytail: replies fetched in one page; add a cursor loop if a thread ever exceeds it.
            const thread = await getPage("conversations.replies", {
              channel: opts.channel,
              ts: m.ts,
            });
            for (const r of thread.messages ?? []) {
              if (r.ts === m.ts) continue; // replies includes the parent — already yielded
              const reply = toItem(r);
              if (reply) yield reply;
            }
          }
        }
        cursor = page.response_metadata?.next_cursor || undefined;
      } while (cursor);
    },
  };
}
