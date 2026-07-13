// embedding.ts tests — no-op (null) when unconfigured; success/failure paths via a stub fetch.
// No real API calls (global fetch is stubbed with vi). Verifying against a real provider is on the human-check list.

import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFetchEmbedder, serializeText } from "./embedding.js";

afterEach(() => vi.restoreAllMocks());

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
});
