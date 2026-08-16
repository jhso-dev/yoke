// relate tests. No model is called: everything here is the code around it — which relation types a
// model may propose, and the checks that decide whether a proposed edge can reach a reviewer.
//
// The entity extractor's net is the quote check. A relation has no single span to quote, so its net
// is structural, and these tests are that net.

import { describe, expect, it, vi } from "vitest";
import { seedOntology } from "../core/ontology.js";
import type { Entity } from "../core/types.js";
import {
  keepLinkable,
  linkableTypes,
  makeFetchRelater,
  type Ref,
  rankOf,
  refsFor,
  relateSystemPrompt,
  relateText,
} from "./relate.js";

const ont = seedOntology();

// The anchor is always r1 and the rest are older — the shape `groupsFor` builds.
const refs: Ref[] = [
  {
    ref: "r1",
    type: "fact",
    text: "stopped listening, they got repetitive",
    at: "2026-06-01T00:00:00Z",
    order: 2,
  },
  {
    ref: "r2",
    type: "fact",
    text: "podcasts opened a new dimension",
    at: "2026-01-01T00:00:00Z",
    order: 1,
  },
];

describe("relateText: what the relater is allowed to read", () => {
  it("keeps the rationale a decision's conclusion cannot carry", () => {
    // The measured defect this function exists to fix: `summarize` returns the first declared string
    // attribute cut at 60 characters, so a decision reached the relater as its conclusion alone and
    // the half that says the position CHANGED never arrived.
    const text = relateText(
      {
        type: "decision",
        attributes: {
          conclusion: "Stopped reading graphic novels altogether.",
          rationale:
            "A few disappointing titles overshadowed the earlier enjoyment of the form.",
          external_id: "raw:00003-abc.md#7",
          sources: "I have stopped reading graphic novels altogether",
        },
      },
      ont,
    );
    expect(text).toContain("Stopped reading graphic novels");
    expect(text).toContain("disappointing titles");
    // Bookkeeping stays out: an id is not a claim, and the quote is longer than the record.
    expect(text).not.toContain("raw:00003");
    expect(text).not.toContain("I have stopped reading");
  });

  it("caps a long record rather than sending a whole document", () => {
    const text = relateText(
      { type: "fact", attributes: { statement: "x".repeat(900) } },
      ont,
    );
    expect(text.length).toBe(400);
  });
});

describe("linkableTypes", () => {
  it("offers the edges that are knowledge and withholds the ones that are not", () => {
    const names = linkableTypes(ont).map((t) => t.name);
    expect(names).toContain("supersedes");
    expect(names).toContain("conflicts_with");
    // `membership` already marks the edges this project says are not knowledge, and they are also
    // the two with the worst failure mode — same_as merges two people on a guess.
    expect(names).not.toContain("works_on");
    expect(names).not.toContain("same_as");
    // entity types are not edges
    expect(names).not.toContain("fact");
  });

  it("follows the ontology rather than a hardcoded list", () => {
    const custom = [
      ...ont,
      { name: "caused_by", kind: "relation" as const, attrs: {} },
    ];
    expect(linkableTypes(custom).map((t) => t.name)).toContain("caused_by");
    expect(relateSystemPrompt(custom)).toContain("caused_by");
  });
});

describe("keepLinkable", () => {
  const item = (over: Record<string, unknown> = {}) => ({
    from: "r1",
    to: "r2",
    type: "supersedes",
    because: "the later record retracts the earlier enthusiasm",
    ...over,
  });

  it("keeps a well-formed edge between two records it was given", () => {
    expect(keepLinkable([item()], refs, ont)).toHaveLength(1);
  });

  // The check that earns its place. A backwards supersedes does not read as wrong — it reads as a
  // confident history in which the person returned to what they had already abandoned, and a
  // reviewer sees a plausible sentence rather than an obvious mistake.
  it("drops a supersedes that runs older → newer", () => {
    expect(keepLinkable([item({ from: "r2", to: "r1" })], refs, ont)).toEqual(
      [],
    );
  });

  it("drops a supersedes between records the source gave no order for", () => {
    const same: Ref[] = [
      { ...refs[0], order: 1 },
      { ...refs[1], order: 1 },
    ];
    expect(keepLinkable([item()], same, ont)).toEqual([]);
  });

  // Direction is only checked where direction means something; conflicts_with is symmetric.
  it("does not impose an order on a symmetric edge", () => {
    expect(
      keepLinkable(
        [item({ type: "conflicts_with", from: "r2", to: "r1" })],
        refs,
        ont,
      ),
    ).toHaveLength(1);
  });

  it("drops an edge naming a record it was never given — the hallucinated-id case", () => {
    expect(keepLinkable([item({ to: "r9" })], refs, ont)).toEqual([]);
    expect(
      keepLinkable([item({ to: "01JQRS7XKX3M4N5P6Q7R8S9T0V" })], refs, ont),
    ).toEqual([]);
  });

  it("drops a self-link and an edge type the ontology does not offer", () => {
    expect(keepLinkable([item({ from: "r1", to: "r1" })], refs, ont)).toEqual(
      [],
    );
    expect(keepLinkable([item({ type: "same_as" })], refs, ont)).toEqual([]);
    expect(
      keepLinkable([item({ type: "invented_by_the_model" })], refs, ont),
    ).toEqual([]);
  });

  it("drops malformed proposals without losing the good ones beside them", () => {
    const items = [
      item(),
      null,
      "a string",
      item({ from: 42 }),
      item({ type: null }),
      {},
    ];
    expect(keepLinkable(items, refs, ont)).toHaveLength(1);
  });

  it("returns nothing when the response was not an array at all", () => {
    expect(keepLinkable(null, refs, ont)).toEqual([]);
    expect(keepLinkable({ links: [item()] }, refs, ont)).toEqual([]);
  });

  it("keeps the edge when the model gave no reason, rather than dropping it", () => {
    // A missing rationale is a worse review experience, not an unsafe edge.
    expect(
      keepLinkable([item({ because: undefined })], refs, ont)[0].because,
    ).toBe("");
  });
});

describe("refsFor", () => {
  const entity = (id: string, at: string): Entity =>
    ({
      id,
      type: "fact",
      attributes: { statement: "a claim with no id in its text" },
      provenance: { actor: "a", origin: "cli", occurred_at: at },
    }) as unknown as Entity;

  it("hands the model short handles and maps them back to ids", () => {
    const { refs: got, byRef } = refsFor(
      [entity("01JQRS7XKX3M4N5P6Q7R8S9T0V", "2026-01-01T00:00:00Z")],
      (e) => String(e.attributes.statement),
      () => 0,
    );
    // A 26-character id is a string the model has to copy exactly, and one wrong character is an
    // edge pointing at nothing.
    expect(got[0].ref).toBe("r1");
    expect(JSON.stringify(got)).not.toContain("01JQRS7XKX3M4N5P6Q7R8S9T0V");
    expect(byRef.get("r1")?.id).toBe("01JQRS7XKX3M4N5P6Q7R8S9T0V");
  });
});

describe("rankOf", () => {
  const rec = (id: string, at: string, ext?: string): Entity =>
    ({
      id,
      type: "fact",
      attributes: ext ? { external_id: ext } : {},
      provenance: { actor: "a", origin: "cli", occurred_at: at },
    }) as unknown as Entity;

  // The case that started this: 34 records extracted from one conversation all carried the same
  // millisecond, because ingest stamped its own clock. Position within the source is the only order
  // such a corpus has, and it is real — later in a transcript is later.
  it("orders same-instant records by their position in the source", () => {
    const t = "2026-08-12T13:00:28.878Z";
    const records = [
      rec("c", t, "raw:doc.md#10"),
      rec("a", t, "raw:doc.md#2"),
      rec("b", t, "raw:doc.md#9"),
    ];
    const rank = rankOf(records);
    // #10 after #9 — the id is compared as a number, not as text, or "10" would sort before "9".
    expect(rank(records[1])).toBeLessThan(rank(records[2]));
    expect(rank(records[2])).toBeLessThan(rank(records[0]));
  });

  it("lets a real source time win over position", () => {
    const records = [
      rec("late", "2026-06-01T00:00:00Z", "raw:doc.md#1"),
      rec("early", "2026-01-01T00:00:00Z", "raw:doc.md#99"),
    ];
    const rank = rankOf(records);
    expect(rank(records[1])).toBeLessThan(rank(records[0]));
  });
});

describe("makeFetchRelater", () => {
  it("is null when unconfigured, so the caller refuses instead of reporting no links", () => {
    expect(makeFetchRelater({}, ont)).toBeNull();
    expect(makeFetchRelater({ YOKE_LLM_URL: "x" }, ont)).toBeNull();
  });

  it("does not call the model for fewer than two records", async () => {
    const original = globalThis.fetch;
    let called = 0;
    globalThis.fetch = (async () => {
      called++;
      return { ok: false, status: 500 };
    }) as unknown as typeof fetch;
    try {
      const relate = makeFetchRelater(
        { YOKE_LLM_URL: "https://x", YOKE_LLM_MODEL: "m" },
        ont,
      ) as NonNullable<ReturnType<typeof makeFetchRelater>>;
      expect(await relate([refs[0]])).toEqual([]);
      expect(called).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("grounds what comes back, dropping the edge the model invented", async () => {
    const body = JSON.stringify([
      { from: "r1", to: "r2", type: "supersedes", because: "real" },
      { from: "r2", to: "r1", type: "supersedes", because: "backwards" },
      {
        from: "r1",
        to: "r7",
        type: "conflicts_with",
        because: "no such record",
      },
    ]);
    const enc = new TextEncoder();
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      body: {
        async *[Symbol.asyncIterator]() {
          yield enc.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: body } }] })}\n\ndata: [DONE]\n\n`,
          );
        },
      },
    })) as unknown as typeof fetch;
    try {
      const relate = makeFetchRelater(
        { YOKE_LLM_URL: "https://x", YOKE_LLM_MODEL: "m" },
        ont,
      ) as NonNullable<ReturnType<typeof makeFetchRelater>>;
      const got = await relate(refs);
      expect(got).toHaveLength(1);
      expect(got?.[0].because).toBe("real");
    } finally {
      globalThis.fetch = original;
    }
  });

  // The relater shares `makeJsonCaller` with the extractor, so it inherits the completion cap. Pinned
  // here because the failure it prevents — a degenerate generation burning the whole timeout on every
  // attempt — costs the same on this path, and a second request body would drift away from it.
  it("caps its completion the same way the extractor does", async () => {
    const original = globalThis.fetch;
    const bodies: string[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return { ok: false, status: 500 };
    }) as unknown as typeof fetch;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const env = {
        YOKE_LLM_URL: "https://x",
        YOKE_LLM_MODEL: "m",
        YOKE_LLM_RETRIES: "0",
      };
      const relate = (e: Record<string, string>) =>
        makeFetchRelater(e, ont) as NonNullable<
          ReturnType<typeof makeFetchRelater>
        >;
      await relate(env)(refs);
      await relate({ ...env, YOKE_LLM_MAX_TOKENS: "9000" })(refs);
      expect(bodies.map((b) => JSON.parse(b).max_tokens)).toEqual([4000, 9000]);
    } finally {
      globalThis.fetch = original;
      spy.mockRestore();
    }
  });

  it("returns null rather than [] when the call failed, so 'none' and 'no answer' differ", async () => {
    const original = globalThis.fetch;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    globalThis.fetch = (async () => ({
      ok: false,
      status: 500,
    })) as unknown as typeof fetch;
    try {
      const relate = makeFetchRelater(
        {
          YOKE_LLM_URL: "https://x",
          YOKE_LLM_MODEL: "m",
          YOKE_LLM_RETRIES: "0",
        },
        ont,
      ) as NonNullable<ReturnType<typeof makeFetchRelater>>;
      expect(await relate(refs)).toBeNull();
    } finally {
      globalThis.fetch = original;
      spy.mockRestore();
    }
  });
});
