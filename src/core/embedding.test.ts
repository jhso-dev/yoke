// embedding.ts tests — no-op (null) when unconfigured; success/failure paths via a stub fetch.
// No real API calls (global fetch is stubbed with vi). Verifying against a real provider is on the human-check list.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makeFetchEmbedder,
  resolveEmbedConfig,
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
  it("returns a no-op (null) embedder when URL/MODEL unset and auto-detection is off", async () => {
    // Quietly: the opt-out is a decision, and "run ollama pull" on the host that turned it off is noise.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const embed = makeFetchEmbedder({ YOKE_NO_AUTO_EMBED: "1" });
    expect(await embed("hello")).toBeNull();
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
    // Half-configured is NOT a probe: a URL with no model is a mistake to report, not a reason to
    // silently reach for a different provider than the one that was named.
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
  const ont = seedOntology();

  it("renders the type and the values, in declared order, as prose", () => {
    // Declared order is {conclusion, rationale, rejected_alternatives}; written order here is not.
    const key = serializeText(
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

  it("keeps the verbatim quote and the identifiers, drops the rest of the bookkeeping", () => {
    // The real shape a `connect raw` record has, and the real failure it was built for: a record
    // whose values say "blog" and whose old JSON key buried that among attribute names and an id.
    const attributes = {
      statement: "Started writing a blog again",
      sources: 'raw:00012-u2.md — "I picked the blog back up this spring"',
      external_id: "raw:00012-u2.md#4",
      author: "Adaline",
      status: "verified",
    };
    const key = serializeText("fact", JSON.stringify(attributes), ont);
    expect(key).toBe(
      "fact. Started writing a blog again. " +
        'raw:00012-u2.md — "I picked the blog back up this spring". ' +
        "raw:00012-u2.md#4",
    );
    // Prose plus the original value — not prose alone (the measured gain was the concatenation).
    expect(key).toContain("I picked the blog back up");
    // The identifier is last and verbatim, because it is SEARCHED FOR: `findByExternalId` is every
    // connector's idempotency check and it retrieves candidates through this index. Out of the key,
    // a re-ingest finds nothing and stores a second copy of every record.
    expect(key.endsWith("raw:00012-u2.md#4")).toBe(true);
    expect(serializeText("collaboration", '{"key":"ABC-123"}', ont)).toBe(
      "collaboration. ABC-123",
    );
    // The bookkeeping nobody looks up is out: the author, the status.
    expect(key).not.toContain("Adaline");
    expect(key).not.toContain("verified");
    // And no JSON: no braces, no quoted attribute names, no `":"` separators.
    expect(key).not.toMatch(/[{}]/);
    expect(key).not.toContain("statement");
    expect(key).not.toContain('":');
  });

  it("orders by written order when no ontology is in hand (the FTS callers)", () => {
    // The storage adapters are constructed with a path and have no ontology, so they pass none. FTS
    // ranks a bag of words, so the halves still see the same key.
    expect(serializeText("fact", '{"statement":"blogs are back"}')).toBe(
      "fact. blogs are back",
    );
  });

  it("degrades to the raw text when the attributes are not an object", () => {
    // An index that throws on a malformed row is worse than one that indexes it verbatim.
    expect(serializeText("fact", "not json", ont)).toBe("fact not json");
    expect(serializeText("fact", "[1,2]", ont)).toBe("fact [1,2]");
  });
});

describe("resolveEmbedConfig", () => {
  /** An Ollama /api/tags stub. `models` is what that host reports as installed. */
  const tags = (models: string[], ok = true) =>
    (async () => ({
      ok,
      json: async () => ({ models: models.map((name) => ({ name })) }),
    })) as unknown as typeof fetch;

  it("prefers explicit configuration over anything installed locally", async () => {
    const cfg = await resolveEmbedConfig(
      { YOKE_EMBED_URL: "http://pinned/v1", YOKE_EMBED_MODEL: "m" },
      tags(["bge-m3:latest"]),
    );
    expect(cfg).toEqual({
      url: "http://pinned/v1",
      model: "m",
      key: undefined,
    });
    expect(cfg?.auto).toBeUndefined();
  });

  it("uses a local embedding model with no configuration, and reports the resolved tag", async () => {
    const cfg = await resolveEmbedConfig(
      {},
      tags(["llama3:8b", "bge-m3:567m"]),
    );
    // The TAG, not the family name: it is what the endpoint is asked for.
    expect(cfg).toMatchObject({ model: "bge-m3:567m", auto: true });
    expect(cfg?.url).toContain("11434");
  });

  it("picks the multilingual model when both it and an English-only one are installed", async () => {
    // Order is the guarantee: an English-centric model on a non-English corpus is indistinguishable
    // from having no embedder, so it must never win over a multilingual one that is present.
    const cfg = await resolveEmbedConfig(
      {},
      tags(["nomic-embed-text:latest", "bge-m3:latest"]),
    );
    expect(cfg?.model).toBe("bge-m3:latest");
  });

  it("still selects an English-only model when it is the only one installed", async () => {
    const cfg = await resolveEmbedConfig({}, tags(["nomic-embed-text:latest"]));
    expect(cfg?.model).toBe("nomic-embed-text:latest");
  });

  it("resolves to nothing when the host runs no embedding model, or none at all", async () => {
    expect(await resolveEmbedConfig({}, tags(["llama3:8b"]))).toBeNull();
    expect(await resolveEmbedConfig({}, tags([], false))).toBeNull();
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await resolveEmbedConfig({}, down)).toBeNull();
  });

  it("does not probe at all when auto-detection is opted out", async () => {
    let called = false;
    const spy = (async () => {
      called = true;
      return { ok: true, json: async () => ({ models: [] }) };
    }) as unknown as typeof fetch;
    expect(
      await resolveEmbedConfig({ YOKE_NO_AUTO_EMBED: "1" }, spy),
    ).toBeNull();
    expect(called).toBe(false);
  });
});
