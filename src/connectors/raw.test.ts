// raw connector tests. A temp dir mixing a .jsonl transcript, a .md doc and an ignored file, plus a
// stub extractor — no model is called. Covers the per-format text dispatch, what the transcript
// renderer drops, --since, --limit, and the round trip through the commit gate.

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteStorage } from "../adapters/storage-sqlite/index.js";
import { seedOntology } from "../core/ontology.js";
import type { Extracted } from "./extract.js";
import { ingest } from "./ingest.js";
import {
  chunkText,
  dedupeByQuote,
  type ExtractStats,
  lastTimestamp,
  makeRawConnector,
  renderTranscript,
  sourceTime,
  toText,
} from "./raw.js";

const rec = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;

const transcript =
  rec({ type: "mode", sessionId: "s1" }) +
  rec({
    type: "user",
    timestamp: "2026-08-01T00:00:00Z",
    message: { role: "user", content: "keep the chunking dumb, no NLP" },
  }) +
  rec({
    type: "assistant",
    timestamp: "2026-08-01T00:01:00Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "the user probably wants a rewrite" },
        { type: "text", text: "agreed — humans promote what matters" },
        { type: "tool_use", name: "Read", input: {} },
      ],
    },
  }) +
  rec({
    type: "user",
    timestamp: "2026-08-01T00:02:00Z",
    message: { role: "user", content: [{ type: "tool_result", content: "…" }] },
  }) +
  rec({
    type: "assistant",
    isSidechain: true,
    timestamp: "2026-08-01T00:03:00Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "subagent" }],
    },
  }) +
  "not json at all\n";

const doc =
  "# Postmortem\n\nthe cache purge order is Redis first, CDN second\n";

const dir = mkdtempSync(join(tmpdir(), "yoke-raw-"));
writeFileSync(join(dir, "a-session.jsonl"), transcript);
writeFileSync(join(dir, "b-postmortem.md"), doc);
writeFileSync(join(dir, "ignore.pdf"), "binary-ish");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ont = seedOntology();
const now = "2026-08-02T00:00:00Z";

/** Proposes one record per file, grounded in whatever it was handed. The model is never called. */
const stub = async (text: string): Promise<Extracted[]> => {
  const quote = text.split("\n").filter((l) => l.trim().length > 20)[0] ?? "";
  return [
    {
      type: "fact",
      attributes: { statement: `extracted: ${quote.slice(0, 40)}` },
      quote,
    },
  ];
};

describe("renderTranscript", () => {
  const text = renderTranscript(transcript);

  it("keeps user and assistant prose", () => {
    expect(text).toContain("user: keep the chunking dumb, no NLP");
    expect(text).toContain("assistant: agreed — humans promote what matters");
  });

  it("drops thinking, tool calls and tool results", () => {
    // A thinking block is the model's own reasoning; filing it as something a person recorded is
    // the impersonation the corpus exists to prevent.
    expect(text).not.toContain("probably wants a rewrite");
    expect(text).not.toContain("tool_use");
    expect(text).not.toContain("Read");
  });

  it("drops sidechains and unparseable lines", () => {
    expect(text).not.toContain("subagent");
    expect(text).not.toContain("not json at all");
  });

  it("survives a file with nothing readable in it", () => {
    expect(renderTranscript("")).toBe("");
    expect(renderTranscript("garbage\n{]\n")).toBe("");
  });
});

describe("toText", () => {
  it("renders a .jsonl transcript and passes prose through untouched", () => {
    expect(toText("s.jsonl", transcript)).toContain("user: keep the chunking");
    expect(toText("p.md", doc)).toBe(doc);
    expect(toText("p.txt", doc)).toBe(doc);
  });
});

describe("sourceTime", () => {
  const mtime = new Date("2020-01-01T00:00:00Z");

  it("prefers a transcript's own timestamps over the filesystem's", () => {
    // Copying a session forward must not make it look new.
    expect(sourceTime("s.jsonl", transcript, mtime)).toBe(
      "2026-08-01T00:03:00Z",
    );
  });

  it("falls back to mtime for material carrying no time of its own", () => {
    expect(sourceTime("p.md", doc, mtime)).toBe("2020-01-01T00:00:00.000Z");
    expect(sourceTime("s.jsonl", "garbage\n", mtime)).toBe(
      "2020-01-01T00:00:00.000Z",
    );
  });
});

describe("lastTimestamp", () => {
  it("finds the newest timestamp", () => {
    expect(lastTimestamp(transcript)).toBe("2026-08-01T00:03:00Z");
  });

  it("is undefined when there is none", () => {
    expect(lastTimestamp("garbage\n")).toBeUndefined();
  });
});

describe("makeRawConnector", () => {
  let port: SqliteStorage;

  beforeEach(async () => {
    port = new SqliteStorage(":memory:");
    await port.init();
  });

  it("reads every readable format and ignores the rest", async () => {
    const items = [];
    for await (const item of makeRawConnector({
      dir,
      extract: stub,
    }).pull())
      items.push(item);
    expect(items.map((i) => i.externalId)).toEqual([
      "raw:a-session.jsonl#0",
      "raw:b-postmortem.md#0",
    ]);
  });

  it("ingests as drafts, with the quote filed beside each record", async () => {
    const res = await ingest(
      port,
      ont,
      makeRawConnector({ dir, extract: stub }),
      "tester",
      now,
    );
    expect(res).toEqual({ added: 2, updated: 0, skipped: 0 });

    const [e] = await port.search({ text: "Redis" });
    expect(e.status).toBe("draft");
    expect(e.attributes.external_id).toBe("raw:b-postmortem.md#0");
    expect(e.attributes.sources).toBe(
      'raw:b-postmortem.md — "the cache purge order is Redis first, CDN second"',
    );
    expect(e.provenance.origin).toBe("connector:raw");
  });

  it("adds nothing on a re-run", async () => {
    const c = makeRawConnector({ dir, extract: stub });
    await ingest(port, ont, c, "tester", now);
    expect(await ingest(port, ont, c, "tester", now)).toEqual({
      added: 0,
      updated: 0,
      skipped: 2,
    });
  });

  it("skips material older than --since without calling the model", async () => {
    // The .md carries no time of its own, so age it via mtime the way --since will read it.
    const old = new Date("2020-01-01T00:00:00Z");
    utimesSync(join(dir, "b-postmortem.md"), old, old);
    let called = 0;
    const counting = async () => {
      called++;
      return [];
    };
    await ingest(
      port,
      ont,
      makeRawConnector({ dir, extract: counting }),
      "tester",
      now,
      "2026-08-02T00:00:00Z",
    );
    expect(called).toBe(0);
  });

  it("honours --limit as a cost guard", async () => {
    let called = 0;
    const counting = async () => {
      called++;
      return [];
    };
    await ingest(
      port,
      ont,
      makeRawConnector({ dir, extract: counting, limit: 1 }),
      "tester",
      now,
    );
    expect(called).toBe(1);
  });

  // Chunks are extracted concurrently, so they finish out of order. The records must not: dedupe
  // keeps the first proposal of a quote, and a file whose records depend on which call returned
  // first would extract differently on every run.
  it("files chunks in source order however the calls finish", async () => {
    const solo = mkdtempSync(join(tmpdir(), "yoke-order-"));
    // Every token is distinct, so a chunk has exactly one place it could have come from.
    const body = `user: ${Array.from({ length: 800 }, (_, i) => `w${i}`).join(" ")}`;
    writeFileSync(join(solo, "long.md"), body);
    // Earlier chunks answer LAST, which is the ordering a pool can produce and a loop never can.
    // Each record is labelled with where its chunk starts in the source, so the yielded sequence
    // says directly whether the file was read front to back.
    let call = 0;
    const backwards = async (chunk: string) => {
      await new Promise((r) => setTimeout(r, Math.max(0, 40 - call++ * 10)));
      const at = body.indexOf(chunk);
      return [
        {
          type: "fact",
          attributes: { statement: String(at) },
          quote: `${at}-${chunk.slice(0, 20)}`,
        },
      ];
    };
    const offsets: number[] = [];
    for await (const item of makeRawConnector({
      dir: solo,
      extract: backwards,
      chunkChars: 1_000,
      concurrency: 4,
    }).pull())
      offsets.push(Number(item.attributes.statement));
    rmSync(solo, { recursive: true, force: true });
    expect(offsets.length).toBeGreaterThan(3);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  });

  // Windows STEP by size − overlap, so the cap reaches far less text than chunks × size. Counting
  // it the wrong way leaves a whole band of file sizes truncated with nothing said about it.
  it("says so when the chunk cap stopped short of the end", async () => {
    const solo = mkdtempSync(join(tmpdir(), "yoke-cap-"));
    writeFileSync(join(solo, "long.md"), "x".repeat(5_000));
    const said: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((m: unknown) => void said.push(String(m)));
    for await (const _ of makeRawConnector({
      dir: solo,
      extract: async () => [],
      chunkChars: 100,
    }).pull());
    spy.mockRestore();
    rmSync(solo, { recursive: true, force: true });
    expect(said.join("\n")).toContain("the tail was not extracted");
  });

  // The two zeroes a caller has to tell apart: an endpoint that went off the network reports the
  // same "nothing extracted" as a model that read the material and found no claims in it.
  it("counts failed calls separately from empty ones", async () => {
    const down: ExtractStats = { calls: 0, failures: 0 };
    await ingest(
      port,
      ont,
      makeRawConnector({ dir, extract: async () => null, stats: down }),
      "tester",
      now,
    );
    expect(down.calls).toBeGreaterThan(0);
    expect(down.failures).toBe(down.calls);

    const quiet: ExtractStats = { calls: 0, failures: 0 };
    await ingest(
      port,
      ont,
      makeRawConnector({ dir, extract: async () => [], stats: quiet }),
      "tester",
      now,
    );
    expect(quiet.calls).toBe(down.calls);
    expect(quiet.failures).toBe(0);
  });

  // The hole the sweep exists to fill: a burst outage kills the calls in flight, and the chunk they
  // were carrying is silently absent from the file afterwards. A chunk nobody read gets one more
  // offer once the rest of the file is done.
  it("re-offers the chunks whose call died, and files what comes back", async () => {
    const seen = new Set<string>();
    // Dies the first time it sees a chunk, answers the second — the burst, then the recovery.
    const flaky = async (text: string) => {
      if (!seen.has(text)) {
        seen.add(text);
        return null;
      }
      return stub(text);
    };

    const swept: ExtractStats = { calls: 0, failures: 0 };
    expect(
      await ingest(
        port,
        ont,
        makeRawConnector({ dir, extract: flaky, stats: swept }),
        "tester",
        now,
      ),
    ).toEqual({ added: 2, updated: 0, skipped: 0 });
    // One call counted per chunk, and nothing left unread.
    expect(swept.calls).toBe(2);
    expect(swept.failures).toBe(0);
  });

  it("treats an unavailable extractor as 'found nothing', not a crash", async () => {
    const res = await ingest(
      port,
      ont,
      makeRawConnector({ dir, extract: async () => null }),
      "tester",
      now,
    );
    expect(res).toEqual({ added: 0, updated: 0, skipped: 0 });
  });
});

describe("chunkText", () => {
  it("returns one window when the text already fits", () => {
    expect(chunkText("short", 100)).toEqual(["short"]);
  });

  it("overlaps windows so a claim on a boundary belongs to one of them", () => {
    const text = "abcdefghij";
    const parts = chunkText(text, 4, 1);
    // step = size - overlap = 3
    expect(parts).toEqual(["abcd", "defg", "ghij", "j"]);
    // every adjacent pair shares a character — that is what stops a boundary claim being lost
    for (let i = 1; i < parts.length; i++)
      expect(text.indexOf(parts[i])).toBeLessThan(
        text.indexOf(parts[i - 1]) + parts[i - 1].length,
      );
  });

  it("covers the whole text", () => {
    const text = "x".repeat(1000) + "END";
    expect(chunkText(text, 100, 10).join("")).toContain("END");
  });
});

describe("dedupeByQuote", () => {
  it("keeps the first of two proposals citing the same span", () => {
    const items = [
      { quote: "the same sentence", attributes: { statement: "one wording" } },
      { quote: "the  same\n sentence", attributes: { statement: "another" } },
      { quote: "a different sentence", attributes: { statement: "three" } },
    ];
    const kept = dedupeByQuote(items);
    expect(kept).toHaveLength(2);
    expect(kept[0].attributes.statement).toBe("one wording");
  });

  it("drops empty quotes", () => {
    expect(dedupeByQuote([{ quote: "  " }])).toEqual([]);
  });
});
