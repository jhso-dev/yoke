// storage-qdrant tests — a deterministic in-memory fake of the Qdrant REST surface routed via
// fetchImpl (no live server), the shared conformance suite against it, an ontology round-trip,
// and a similar() top-k check with hand-made vectors.

import { describe, expect, it } from "vitest";
import { seedOntology } from "../../core/ontology.js";
import { describeStoragePort } from "../../ports/conformance.js";
import { QdrantStorage } from "./index.js";

type Match = { key: string; match: { value: string | number } };
type Filter = { must?: Match[]; should?: Match[] };
interface Point {
  id: string | number;
  payload: Record<string, unknown>;
  vector?: number[];
}
interface Collection {
  vectorSize?: number;
  points: Map<string | number, Point>;
}

function matchesFilter(payload: Record<string, unknown>, f?: Filter): boolean {
  if (!f) return true;
  const hit = (m: Match) => payload[m.key] === m.match.value;
  const mustOk = !f.must || f.must.every(hit);
  const shouldOk = !f.should || f.should.some(hit);
  return mustOk && shouldOk;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });

// Honest fake: real Qdrant filter semantics (must=AND, should=any), point upsert by id, scroll
// pagination, and cosine vector search. State lives in Maps; one fake per adapter instance.
function makeFakeQdrant(): typeof fetch {
  const collections = new Map<string, Collection>();

  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const seg = url.pathname.split("/").filter(Boolean); // ["collections", name, ...]
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const name = seg[1];
    const sub = seg[2]; // "points" | undefined
    const op = seg[3]; // "scroll" | "search" | "delete" | undefined

    // Collection create / info
    if (seg[0] === "collections" && sub === undefined) {
      if (method === "PUT") {
        collections.set(name, {
          vectorSize: body?.vectors?.size,
          points: new Map(),
        });
        return json({ result: true, status: "ok" });
      }
      if (method === "GET") {
        const c = collections.get(name);
        if (!c) return json({ status: { error: "Not found" } }, 404);
        return json({
          result: {
            config: {
              params: {
                vectors:
                  c.vectorSize === undefined ? {} : { size: c.vectorSize },
              },
            },
          },
        });
      }
    }

    const coll = collections.get(name);
    if (!coll) return json({ status: { error: "Not found" } }, 404);

    // Upsert points
    if (sub === "points" && op === undefined && method === "PUT") {
      for (const p of body.points as Point[]) coll.points.set(p.id, p);
      return json({ result: { status: "completed" } });
    }

    // Scroll
    if (sub === "points" && op === "scroll" && method === "POST") {
      const all = [...coll.points.values()].filter((p) =>
        matchesFilter(p.payload, body.filter),
      );
      const limit: number = body.limit ?? 256;
      const start: number = typeof body.offset === "number" ? body.offset : 0;
      const page = all.slice(start, start + limit);
      const next = start + limit < all.length ? start + limit : null;
      return json({
        result: {
          points: page.map((p) => ({
            id: p.id,
            payload: body.with_payload ? p.payload : undefined,
            vector: body.with_vector ? p.vector : undefined,
          })),
          next_page_offset: next,
        },
      });
    }

    // Vector search
    if (sub === "points" && op === "search" && method === "POST") {
      const hits = [...coll.points.values()]
        .filter((p) => p.vector && matchesFilter(p.payload, body.filter))
        .map((p) => ({ p, score: cosine(body.vector, p.vector as number[]) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, body.limit ?? 10);
      return json({
        result: hits.map((h) => ({
          id: h.p.id,
          score: h.score,
          payload: body.with_payload ? h.p.payload : undefined,
          vector: body.with_vector ? h.p.vector : undefined,
        })),
      });
    }

    return json(
      { status: { error: `unhandled ${method} ${url.pathname}` } },
      500,
    );
  }) as typeof fetch;
}

describeStoragePort(
  "qdrant (fake REST)",
  async () =>
    new QdrantStorage({ url: "http://fake", fetchImpl: makeFakeQdrant() }),
);

describe("ontology save/load", () => {
  it("round-trips the seed ontology", async () => {
    const store = new QdrantStorage({
      url: "http://fake",
      fetchImpl: makeFakeQdrant(),
    });
    await store.init();
    const seed = seedOntology();
    await store.saveOntology(seed);
    expect(await store.loadOntology()).toEqual(seed);
    store.close();
  });
});

describe("qdrant similar", () => {
  const emb = (arr: number[]) => Float32Array.from(arr);
  const base = {
    type: "fact",
    status: "draft" as const,
    version: 1,
    last_confirmed: "2026-01-01T00:00:00Z",
    provenance: {
      actor: "yoke:system",
      origin: "cli",
      occurred_at: "2026-01-01T00:00:00Z",
    },
  };

  it("returns [] before any embedding is stored", async () => {
    const store = new QdrantStorage({
      url: "http://fake",
      fetchImpl: makeFakeQdrant(),
    });
    await store.init();
    expect(await store.similar(emb([1, 0, 0]), 3)).toEqual([]);
    store.close();
  });

  it("returns k nearest ordered by similarity, embedding restored", async () => {
    const store = new QdrantStorage({
      url: "http://fake",
      fetchImpl: makeFakeQdrant(),
    });
    await store.init();
    await store.putEntity({
      ...base,
      id: "x",
      attributes: { n: "x" },
      embedding: emb([1, 0, 0]),
    });
    await store.putEntity({
      ...base,
      id: "near",
      attributes: { n: "near" },
      embedding: emb([0.9, 0.1, 0]),
    });
    await store.putEntity({
      ...base,
      id: "far",
      attributes: { n: "far" },
      embedding: emb([0, 1, 0]),
    });
    const hits = await store.similar(emb([1, 0, 0]), 2);
    expect(hits.map((h) => h.id)).toEqual(["x", "near"]);
    expect(hits[0].embedding).toBeInstanceOf(Float32Array);
    expect(Array.from(hits[0].embedding as Float32Array)).toEqual([1, 0, 0]);
    store.close();
  });

  it("keeps only the latest version's vector (re-upsert overwrites)", async () => {
    const store = new QdrantStorage({
      url: "http://fake",
      fetchImpl: makeFakeQdrant(),
    });
    await store.init();
    await store.putEntity({
      ...base,
      id: "e",
      attributes: { n: "v1" },
      embedding: emb([1, 0, 0]),
    });
    await store.putEntity({
      ...base,
      id: "e",
      version: 2,
      attributes: { n: "v2" },
      embedding: emb([0, 1, 0]),
    });
    const hits = await store.similar(emb([0, 1, 0]), 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe("e");
    expect(hits[0].attributes).toEqual({ n: "v2" });
    store.close();
  });
});
