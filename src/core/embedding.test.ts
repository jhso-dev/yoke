// embedding.ts tests — no-op (null) when unconfigured; success/failure paths via a stub fetch.
// No real API calls (global fetch is stubbed with vi). Verifying against a real provider is on the human-check list.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INDEX_KEY_META,
  makeFetchEmbedder,
  pinIndexKey,
  proseKeyEnabled,
  proseText,
  resolveIndexKey,
  serializeText,
} from "./embedding.js";
import { seedOntology } from "./ontology.js";

afterEach(() => {
  vi.restoreAllMocks();
  // `restoreAllMocks` does not undo `stubGlobal`, so the fetch stub above outlived this file and
  // threw "network down" inside whichever suite ran next (measured: src/front/ui/static.test.ts).
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("makeFetchEmbedder", () => {
  it("returns a no-op (null) embedder when URL/MODEL unset", async () => {
    const embed = makeFetchEmbedder({});
    expect(await embed("hello")).toBeNull();
    // URL present but model missing → still a no-op.
    const embed2 = makeFetchEmbedder({ YOKE_EMBED_URL: "http://x" });
    expect(await embed2("hello")).toBeNull();
  });

  it("POSTs to {url}/embeddings and returns Float32Array on success", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const embed = makeFetchEmbedder({
      YOKE_EMBED_URL: "http://api.test/v1/",
      YOKE_EMBED_MODEL: "m",
      YOKE_EMBED_KEY: "sk-x",
    });
    const out = await embed("hello world");
    expect(out).toBeInstanceOf(Float32Array);
    expect(Array.from(out as Float32Array)).toEqual([
      expect.closeTo(0.1),
      expect.closeTo(0.2),
      expect.closeTo(0.3),
    ]);
    // Trailing-slash normalization + Bearer auth.
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://api.test/v1/embeddings");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer sk-x",
    );
  });

  it("returns null (not throw) on non-OK response", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );
    const embed = makeFetchEmbedder({
      YOKE_EMBED_URL: "http://x",
      YOKE_EMBED_MODEL: "m",
    });
    expect(await embed("hi")).toBeNull();
  });

  it("returns null (not throw) when fetch rejects", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const embed = makeFetchEmbedder({
      YOKE_EMBED_URL: "http://x",
      YOKE_EMBED_MODEL: "m",
    });
    expect(await embed("hi")).toBeNull();
  });
});

describe("serializeText", () => {
  it("joins type and attributes JSON (shared FTS/embedding rule)", () => {
    expect(serializeText("fact", '{"a":1}')).toBe('fact {"a":1}');
  });

  it("is byte-identical to the JSON key unless YOKE_INDEX_KEY says prose", () => {
    // The A/B is two index builds of one corpus, which is only a comparison if the control arm is
    // untouched — including the ontology argument the prose arm added.
    const attrs = JSON.stringify({
      conclusion: "Reads on the commute now",
      sources: 'raw:00007-a.md — "I read on the commute"',
      external_id: "raw:00007-a.md#3",
    });
    expect(serializeText("decision", attrs, seedOntology())).toBe(
      `decision ${attrs}`,
    );
    expect(proseKeyEnabled({})).toBe(false);
    expect(proseKeyEnabled({ YOKE_INDEX_KEY: "prose" })).toBe(true);
    // The name that was asked for, accepted as an alias — and not sent as a bearer token.
    expect(proseKeyEnabled({ YOKE_EMBED_KEY: "prose" })).toBe(true);
    expect(proseKeyEnabled({ YOKE_EMBED_KEY: "sk-x" })).toBe(false);
  });

  it("switches both halves of the key when the STORE says prose, never the env", () => {
    vi.stubEnv("YOKE_INDEX_KEY", "prose");
    // The env is set and changes nothing here: what a store is keyed on is recorded in the store
    // (`resolveIndexKey`), and a command run without the flag must not re-key the rows it rewrites.
    expect(serializeText("fact", '{"statement":"blogs are back"}')).toBe(
      'fact {"statement":"blogs are back"}',
    );
    expect(
      serializeText("fact", '{"statement":"blogs are back"}', [], "prose"),
    ).toBe("fact. blogs are back");
  });
});

describe("pinIndexKey / resolveIndexKey", () => {
  const meta = () => {
    const m = new Map<string, string>();
    return {
      m,
      async getMeta(k: string) {
        return m.get(k) ?? null;
      },
      async setMeta(k: string, v: string) {
        m.set(k, v);
      },
    };
  };

  it("lets the env choose only for a store that has indexed nothing", () => {
    const prose = { YOKE_INDEX_KEY: "prose" };
    expect(pinIndexKey(null, true, prose)).toBe("prose");
    expect(pinIndexKey(null, false, prose)).toBe("default");
    expect(pinIndexKey(null, true, {})).toBe("default");
  });

  it("prefers what the store recorded over what the env says", () => {
    expect(pinIndexKey("prose", true, {})).toBe("prose");
    expect(pinIndexKey("default", true, { YOKE_INDEX_KEY: "prose" })).toBe(
      "default",
    );
    // Anything else is not a variant this build knows — read it as the legacy key rather than
    // guessing, so nothing already written is re-interpreted.
    expect(pinIndexKey("sentences", false, {})).toBe("default");
  });

  it("stamps a fresh store and then answers from the stamp", async () => {
    const store = meta();
    expect(
      await resolveIndexKey(store, () => true, { YOKE_INDEX_KEY: "prose" }),
    ).toBe("prose");
    expect(store.m.get(INDEX_KEY_META)).toBe("prose");
    // Same store, a process with no flag set: the recorded variant wins.
    expect(await resolveIndexKey(store, () => false, {})).toBe("prose");
  });

  it("reads a legacy store (no meta, rows present) as the default key", async () => {
    const store = meta();
    expect(
      await resolveIndexKey(store, () => false, { YOKE_INDEX_KEY: "prose" }),
    ).toBe("default");
    expect(store.m.get(INDEX_KEY_META)).toBe("default");
  });
});

describe("proseText", () => {
  const ont = seedOntology();

  it("renders the type and the values, in declared order, as prose", () => {
    // Declared order is {conclusion, rationale, rejected_alternatives}; written order here is not.
    const key = proseText(
      "decision",
      JSON.stringify({
        rationale: "The long-form ones hold an argument together",
        conclusion: "Went back to reading blogs",
        rejected_alternatives: ["newsletters", "short video"],
      }),
      ont,
    );
    expect(key).toBe(
      "decision. Went back to reading blogs. " +
        "The long-form ones hold an argument together. newsletters, short video",
    );
  });

  it("keeps the verbatim source quote and drops the bookkeeping", () => {
    // The real shape a `connect raw` record has, and the real failure it was built for: a record
    // whose values say "blog" and whose JSON key buries that among attribute names and an id.
    const attributes = {
      statement: "Started writing a blog again",
      sources: 'raw:00012-u2.md — "I picked the blog back up this spring"',
      external_id: "raw:00012-u2.md#4",
      author: "u2",
      status: "verified",
    };
    const key = proseText("fact", JSON.stringify(attributes), ont);
    expect(key).toBe(
      "fact. Started writing a blog again. " +
        'raw:00012-u2.md — "I picked the blog back up this spring"',
    );
    // Prose plus the original value — not prose alone (LongMemEval measured the concatenation).
    expect(key).toContain("I picked the blog back up");
    // Bookkeeping is out: the id, the author, the status.
    expect(key).not.toContain("#4");
    expect(key).not.toContain("verified");
    // And no JSON: no braces, no quoted attribute names, no `":"` separators.
    expect(key).not.toMatch(/[{}]/);
    expect(key).not.toContain("statement");
    expect(key).not.toContain('":');
  });

  it("falls back to the JSON key when the attributes are not an object", () => {
    // An index that throws on a malformed row is worse than one that indexes it verbatim.
    expect(proseText("fact", "not json", ont)).toBe("fact not json");
    expect(proseText("fact", "[1,2]", ont)).toBe("fact [1,2]");
  });
});
