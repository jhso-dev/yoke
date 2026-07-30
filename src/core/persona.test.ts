// persona tests — data is prepared through the real SqliteStorage(:memory:) + commit gate.
// personaQuery is a person-anchored inject, so these cases pin what that anchor must and must not
// pull in: authored knowledge yes, knowledge that merely touches the person no.
// renderPersonaSkill is snapshotted with a fixed fixture and a fixed now.

import { beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../adapters/storage-sqlite/index.js";
import { commit } from "./commit.js";
import { verify } from "./lifecycle.js";
import { seedOntology } from "./ontology.js";
import { personaQuery, renderPersonaSkill } from "./persona.js";
import type { Entity } from "./types.js";

const ont = seedOntology();
const now = "2026-07-12T00:00:00Z";

let port: SqliteStorage;
beforeEach(async () => {
  port = new SqliteStorage(":memory:");
  await port.init();
});

function prov(actor: string) {
  return { actor, origin: "cli", occurred_at: now };
}

async function add(
  type: string,
  attributes: Record<string, unknown>,
  actor: string,
) {
  const { entity } = await commit(
    port,
    ont,
    { type, attributes },
    prov(actor),
    now,
  );
  return entity.id;
}

describe("personaQuery", () => {
  it("collects verified knowledge the person authored and splits decision vs fact", async () => {
    const d = await add(
      "decision",
      { conclusion: "use SQLite", rationale: "zero-config" },
      "alex",
    );
    const f = await add("fact", { note: "ships fridays" }, "alex");
    await verify(port, [d, f], "alex", now);

    const res = await personaQuery(port, ont, "alex", now);
    expect(res.decisions.map((e) => e.id)).toEqual([d]);
    expect(res.facts.map((e) => e.id)).toEqual([f]);
  });

  it("collects via a hand-written authored_by relation (connector-ingested knowledge)", async () => {
    const f = await add("fact", { note: "connector fact" }, "connector");
    // authored_by: from=entity → to=person (the entity was authored by the person).
    await commit(
      port,
      ont,
      { type: "authored_by", attributes: {}, from: f, to: "alex" },
      prov("connector"),
      now,
    );
    await verify(port, [f], "admin", now); // promoted by a different actor — irrelevant to the anchor.

    const res = await personaQuery(port, ont, "alex", now);
    expect(res.facts.map((e) => e.id)).toEqual([f]);
  });

  it("keeps the original author's knowledge when someone else verifies it", async () => {
    const d = await add(
      "decision",
      { conclusion: "use FTS prefix", rationale: "korean suffix" },
      "alex",
    );
    await verify(port, [d], "admin", now); // promoted by someone else — authorship edge is unaffected.

    expect((await personaQuery(port, ont, "alex", now)).decisions).toHaveLength(
      1,
    );
    // ...and promoting is not authoring: it must not show up as the promoter's own judgment.
    expect((await personaQuery(port, ont, "admin", now)).decisions).toEqual([]);
  });

  it("excludes knowledge that merely touches the person (works_on, their own person record)", async () => {
    // The person record itself, filed by someone else → an authored_by OUT edge from alex.
    await commit(
      port,
      ont,
      { type: "person", attributes: { name: "Alex" } },
      prov("admin"),
      now,
      { existingId: "alex" },
    );
    const ws = await add("collaboration", { title: "PAY-42" }, "admin");
    await commit(
      port,
      ont,
      { type: "works_on", attributes: {}, from: "alex", to: ws },
      prov("admin"),
      now,
    );
    await verify(port, ["alex", ws], "admin", now);

    // Anchored on authored_by/'in' only — neither the collaboration nor admin leaks in as Alex's own.
    const res = await personaQuery(port, ont, "alex", now);
    expect([...res.decisions, ...res.facts]).toEqual([]);
  });

  it("filters the person's own records by query, without pulling org-wide matches in", async () => {
    const mine = await add("fact", { note: "we cache with redis" }, "alex");
    const theirs = await add(
      "fact",
      { note: "redis runs on port 6379" },
      "kim",
    );
    await verify(port, [mine, theirs], "alex", now);

    const res = await personaQuery(port, ont, "alex", now, { query: "redis" });
    expect(res.facts.map((e) => e.id)).toEqual([mine]);
    expect(
      (await personaQuery(port, ont, "alex", now, { query: "postgres" })).facts,
    ).toEqual([]);
  });

  it("excludes drafts (unverified)", async () => {
    await add("decision", { conclusion: "x", rationale: "y" }, "alex");
    const res = await personaQuery(port, ont, "alex", now);
    expect(res.decisions).toEqual([]);
    expect(res.facts).toEqual([]);
  });

  it("excludes verified-but-stale (TTL exceeded)", async () => {
    const f = await add("fact", { note: "aging" }, "alex"); // fact TTL = 180 days
    await verify(port, [f], "alex", now);
    const res = await personaQuery(port, ont, "alex", "2027-06-01T00:00:00Z");
    expect(res.facts).toEqual([]);
  });
});

describe("renderPersonaSkill", () => {
  it("renders a stable SKILL.md for a fixed fixture", () => {
    const person: Entity = {
      id: "alex",
      type: "person",
      version: 2,
      status: "verified",
      attributes: { name: "Alex" },
      last_confirmed: "2026-07-12T00:00:00Z",
      provenance: { actor: "yoke:system", origin: "cli", occurred_at: now },
    };
    const decision: Entity = {
      id: "01DECISION",
      type: "decision",
      version: 2,
      status: "verified",
      attributes: {
        conclusion: "use SQLite",
        rationale: "zero-config single file keeps the CLI simple",
      },
      last_confirmed: "2026-07-12T00:00:00Z",
      provenance: {
        actor: "alex",
        origin: "cli",
        occurred_at: "2026-07-01T00:00:00Z",
      },
    };
    const fact: Entity = {
      id: "01FACT",
      type: "fact",
      version: 1,
      status: "verified",
      attributes: { note: "team ships on Fridays" },
      last_confirmed: "2026-07-12T00:00:00Z",
      provenance: {
        actor: "alex",
        origin: "cli",
        occurred_at: "2026-07-02T00:00:00Z",
      },
    };
    const md = renderPersonaSkill(
      person,
      { decisions: [decision], facts: [fact] },
      "2026-07-12T12:00:00Z",
    );
    expect(md).toMatchInlineSnapshot(`
      "---
      name: persona-alex
      description: Persona grounded in Alex's recorded judgments and knowledge
      ---

      # Alex persona

      Generated: 2026-07-12T12:00:00Z
      Source knowledge (2): 01DECISION@v2, 01FACT@v1

      ## Guiding principles

      - zero-config single file keeps the CLI simple

      ## Decision record

      ### use SQLite
      - Rationale: zero-config single file keeps the CLI simple
      - Source: [decision:01DECISION@v2] alex, 2026-07-01T00:00:00Z

      ## Knowledge

      - team ships on Fridays — [fact:01FACT@v1] alex, 2026-07-02T00:00:00Z

      ## Instructions

      Do not answer without a citation. If it is not in the records above, answer "no record".
      Do not speak as if you were Alex; cite the records.
      "
    `);
  });
});
