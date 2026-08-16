// Extraction tests. The model call is never made: everything here is the code around it — which types
// may be proposed, how a response is parsed, and the grounding check that drops a record nobody said.

import { describe, expect, it, vi } from "vitest";
import { seedOntology } from "../core/ontology.js";
import {
  extractableTypes,
  keepGrounded,
  makeFetchExtractor,
  parseItems,
  systemPrompt,
  typeMenu,
} from "./extract.js";

const ont = seedOntology();
const source =
  "user: we keep chunking dumb on purpose, no NLP in the connector";

describe("extractableTypes", () => {
  it("offers the knowledge types and withholds the structural ones", () => {
    const names = extractableTypes(ont).map((t) => t.name);
    expect(names).toContain("fact");
    expect(names).toContain("decision");
    expect(names).toContain("term");
    // person and collaboration NAME what knowledge attaches to; a model must not file them as
    // knowledge it found.
    expect(names).not.toContain("person");
    expect(names).not.toContain("collaboration");
    // relations are not entities.
    expect(names).not.toContain("authored_by");
  });

  it("follows the ontology rather than a hardcoded list", () => {
    const custom = [
      ...ont,
      { name: "incident", kind: "entity" as const, attrs: {} },
    ];
    expect(extractableTypes(custom).map((t) => t.name)).toContain("incident");
    expect(typeMenu(custom)).toContain("incident");
  });
});

describe("systemPrompt", () => {
  it("names each type with its required attributes", () => {
    const p = systemPrompt(ont);
    expect(p).toContain("conclusion: string (required)");
    expect(p).toContain("rationale: string (required)");
    // title is optional on a fact and must not be advertised as required
    expect(p).toContain("- fact — title: string, statement: string (required)");
  });
});

describe("parseItems", () => {
  it("reads a bare array", () => {
    expect(parseItems('[{"type":"fact"}]')).toEqual([{ type: "fact" }]);
  });

  it("reads through a code fence and a sentence of preamble", () => {
    expect(
      parseItems('Sure! Here you go:\n```json\n[{"type":"fact"}]\n```'),
    ).toEqual([{ type: "fact" }]);
  });

  it("returns null rather than throwing on junk", () => {
    expect(parseItems("no json here")).toBeNull();
    expect(parseItems("[{oops]")).toBeNull();
  });

  // Verbatim from a 26B local model over Korean material: it closed a string early with an
  // unescaped inner quote. `JSON.parse` on the array rejects the whole response, so the three
  // well-formed records beside it were being thrown away too.
  const withBadQuote = `[
  {"type":"fact","attributes":{"statement":"first"},"quote":"a"},
  {"type":"decision","attributes":{"conclusion":"번역 규칙을 "사람에게 시키는 말"로 수정함."},"quote":"b"},
  {"type":"fact","attributes":{"statement":"third"},"quote":"c"}
]`;

  it("salvages the well-formed records around one the model broke", () => {
    const items = parseItems(withBadQuote) as Array<{
      attributes: { statement?: string };
    }>;
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.attributes.statement)).toEqual([
      "first",
      "third",
    ]);
  });

  it("still returns null when nothing at all survives", () => {
    expect(parseItems('[{"a": "b" "c"}]')).toBeNull();
  });

  it("does not reach for the salvage when the array parses", () => {
    // A brace inside a string would confuse a span scan; the fast path never runs it.
    expect(parseItems('[{"type":"fact","quote":"{t.common.actor}"}]')).toEqual([
      { type: "fact", quote: "{t.common.actor}" },
    ]);
  });
});

describe("keepGrounded", () => {
  const item = (over: Record<string, unknown> = {}) => ({
    type: "fact",
    attributes: { statement: "chunking is deliberately dumb" },
    quote: "we keep chunking dumb on purpose",
    ...over,
  });

  it("keeps a record whose quote is in the source", () => {
    expect(keepGrounded([item()], source, ont)).toHaveLength(1);
  });

  it("drops a record whose quote is not — the fabrication case", () => {
    const made_up = item({ quote: "we decided to rewrite it in Rust" });
    expect(keepGrounded([made_up], source, ont)).toEqual([]);
  });

  it("matches across reflowed whitespace, since only the wording is the claim", () => {
    const rewrapped = item({ quote: "we keep\n  chunking   dumb on purpose" });
    expect(keepGrounded([rewrapped], source, ont)).toHaveLength(1);
  });

  // Measured: of four parseable quotes a 26B local model returned over this repo's transcripts,
  // three matched only once backticks and asterisks were ignored. It reproduced the words and not
  // the typography, and `compact` vs compact is not a different claim.
  it("ignores markdown emphasis on either side", () => {
    const md = "user: we keep **chunking dumb** on `purpose`, no NLP";
    expect(
      keepGrounded(
        [item({ quote: "we keep chunking dumb on purpose" })],
        md,
        ont,
      ),
    ).toHaveLength(1);
    expect(
      keepGrounded(
        [item({ quote: "we keep **chunking dumb** on `purpose`" })],
        "user: we keep chunking dumb on purpose, no NLP",
        ont,
      ),
    ).toHaveLength(1);
  });

  // The line: dropped formatting is tolerated, a dropped passage is not. The fourth quote from that
  // same model elided its middle and stayed dropped, which is the behaviour worth keeping.
  it("still drops a quote that elides its middle", () => {
    const elided = item({
      quote: "we keep chunking … no NLP in the connector",
    });
    expect(keepGrounded([elided], source, ont)).toEqual([]);
  });

  // Emptiness is judged after normalization, not before: `***` survives a trim and then normalizes
  // to "", which every source contains, so a record resting on nothing would ground perfectly.
  it("drops a quote that is only formatting, or too short to identify a passage", () => {
    expect(keepGrounded([item({ quote: "***" })], source, ont)).toEqual([]);
    expect(keepGrounded([item({ quote: "   " })], source, ont)).toEqual([]);
    expect(keepGrounded([item({ quote: "we keep" })], source, ont)).toEqual([]);
  });

  it("drops a type the ontology does not offer for extraction", () => {
    expect(keepGrounded([item({ type: "person" })], source, ont)).toEqual([]);
    expect(keepGrounded([item({ type: "nonsense" })], source, ont)).toEqual([]);
  });

  it("drops malformed proposals without losing the good ones beside them", () => {
    const items = [
      item(),
      null,
      "a string",
      item({ quote: "" }),
      item({ attributes: null }),
      item({ attributes: ["not", "an", "object"] }),
      item({ quote: 42 }),
    ];
    expect(keepGrounded(items, source, ont)).toHaveLength(1);
  });

  it("returns nothing when the response was not an array at all", () => {
    expect(keepGrounded(null, source, ont)).toEqual([]);
    expect(keepGrounded({ items: [item()] }, source, ont)).toEqual([]);
  });
});

/** The two records every streaming test replays: one grounded, one the model invented. */
const ITEMS = [
  {
    type: "fact",
    attributes: { statement: "chunking is deliberately dumb" },
    quote: "we keep chunking dumb on purpose",
  },
  {
    type: "fact",
    attributes: { statement: "they are rewriting it in Rust" },
    quote: "nobody ever said this",
  },
];

/** An OpenAI-compatible SSE body, delivered as several frames so the reassembly is exercised. */
function sse(content: string, chunkSize = 7): AsyncIterable<Uint8Array> {
  const enc = new TextEncoder();
  const frames: string[] = [];
  for (let i = 0; i < content.length; i += chunkSize) {
    frames.push(
      `data: ${JSON.stringify({
        choices: [{ delta: { content: content.slice(i, i + chunkSize) } }],
      })}\n\n`,
    );
  }
  frames.push("data: [DONE]\n\n");
  return {
    async *[Symbol.asyncIterator]() {
      // Split mid-frame on purpose: a chunk boundary must not land inside a `data:` line.
      const whole = frames.join("");
      for (let i = 0; i < whole.length; i += 13) {
        yield enc.encode(whole.slice(i, i + 13));
      }
    },
  };
}

describe("makeFetchExtractor", () => {
  it("is a no-op returning null when unconfigured", async () => {
    const extract = makeFetchExtractor({}, ont);
    expect(await extract(source)).toBeNull();
    expect(await makeFetchExtractor({ YOKE_LLM_URL: "x" }, ont)(source)).toBe(
      null,
    );
  });

  it("posts to /chat/completions and grounds what comes back", async () => {
    const calls: Array<{ url: string; body: string; auth?: string }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({
        url: String(url),
        body: String(init.body),
        auth: (init.headers as Record<string, string>).authorization,
      });
      return { ok: true, body: sse(JSON.stringify(ITEMS)) };
    }) as unknown as typeof fetch;
    try {
      const extract = makeFetchExtractor(
        {
          YOKE_LLM_URL: "https://api.example.com/v1/",
          YOKE_LLM_MODEL: "m",
          YOKE_LLM_KEY: "sk-test",
        },
        ont,
      );
      const got = await extract(source);
      expect(calls[0].url).toBe("https://api.example.com/v1/chat/completions");
      expect(calls[0].auth).toBe("Bearer sk-test");
      // The ungrounded second item is dropped even though the model returned it.
      expect(got).toHaveLength(1);
      expect(got?.[0].attributes.statement).toBe(
        "chunking is deliberately dumb",
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  // Uncapped, a chunk whose generation degenerates into repetition costs the whole timeout and does
  // it again on every retry — measured at 161 timeouts across a 23-chunk ingest. The cap is what
  // makes that failure cheap, so it is pinned rather than left to the endpoint's own default.
  it("caps one completion, and lets YOKE_LLM_MAX_TOKENS move the cap", async () => {
    const original = globalThis.fetch;
    const bodies: string[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return { ok: true, body: sse(JSON.stringify(ITEMS)) };
    }) as unknown as typeof fetch;
    try {
      const env = { YOKE_LLM_URL: "https://x", YOKE_LLM_MODEL: "m" };
      await makeFetchExtractor(env, ont)(source);
      await makeFetchExtractor(
        { ...env, YOKE_LLM_MAX_TOKENS: "9000" },
        ont,
      )(source);
      // 0 and a non-number both mean "use the default", as every other knob here reads them.
      await makeFetchExtractor(
        { ...env, YOKE_LLM_MAX_TOKENS: "0" },
        ont,
      )(source);
      await makeFetchExtractor(
        { ...env, YOKE_LLM_MAX_TOKENS: "lots" },
        ont,
      )(source);
      expect(bodies.map((b) => JSON.parse(b).max_tokens)).toEqual([
        4000, 9000, 4000, 4000,
      ]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("gives up on a slow model with a message naming the knob", async () => {
    const original = globalThis.fetch;
    const errs: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((m?: unknown) => void errs.push(String(m)));
    // Never resolves on its own — only the abort signal ends it, which is the case being pinned.
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(
            Object.assign(new Error("operation was aborted"), {
              name: "TimeoutError",
            }),
          ),
        );
      })) as unknown as typeof fetch;
    try {
      const extract = makeFetchExtractor(
        {
          YOKE_LLM_URL: "https://x",
          YOKE_LLM_MODEL: "m",
          YOKE_LLM_TIMEOUT_MS: "20",
          YOKE_LLM_RETRIES: "0",
        },
        ont,
      );
      expect(await extract(source)).toBeNull();
      expect(errs.at(-1)).toContain("YOKE_LLM_TIMEOUT_MS");
    } finally {
      globalThis.fetch = original;
      spy.mockRestore();
    }
  });

  // A chunk that failed is a chunk nobody read, and with a document split into pieces that is a
  // hole in the middle of what gets filed. Measured against a LAN endpoint that flapped mid-run.
  it("offers a failed chunk again before giving up on it", async () => {
    const original = globalThis.fetch;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls < 3) throw new Error("fetch failed");
      return { ok: true, body: sse(JSON.stringify(ITEMS)) };
    }) as unknown as typeof fetch;
    try {
      const got = await makeFetchExtractor(
        {
          YOKE_LLM_URL: "https://x",
          YOKE_LLM_MODEL: "m",
          YOKE_LLM_RETRIES: "5",
          YOKE_LLM_RETRY_BASE_MS: "1",
        },
        ont,
      )(source);
      expect(calls).toBe(3);
      expect(got).toHaveLength(1);
    } finally {
      globalThis.fetch = original;
      spy.mockRestore();
    }
  });

  it("takes YOKE_LLM_RETRIES=0 as 'fail on the first error'", async () => {
    const original = globalThis.fetch;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    try {
      const got = await makeFetchExtractor(
        {
          YOKE_LLM_URL: "https://x",
          YOKE_LLM_MODEL: "m",
          YOKE_LLM_RETRIES: "0",
        },
        ont,
      )(source);
      expect(calls).toBe(1);
      expect(got).toBeNull();
    } finally {
      globalThis.fetch = original;
      spy.mockRestore();
    }
  });

  it("returns null instead of throwing when the endpoint fails", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: false,
      status: 500,
    })) as unknown as typeof fetch;
    try {
      const extract = makeFetchExtractor(
        {
          YOKE_LLM_URL: "https://x",
          YOKE_LLM_MODEL: "m",
          YOKE_LLM_RETRIES: "0",
        },
        ont,
      );
      expect(await extract(source)).toBeNull();
    } finally {
      globalThis.fetch = original;
    }
  });
});
