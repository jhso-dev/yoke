// persona tests — data is prepared through the real SqliteStorage(:memory:) + commit gate.
// Collection: actor match / authored_by / draft & stale exclusion / decision vs fact classification.
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
  it("collects verified entities authored by actor and splits decision vs fact", async () => {
    const d = await add(
      "decision",
      { conclusion: "use SQLite", rationale: "zero-config" },
      "nathen",
    );
    const f = await add("fact", { note: "ships fridays" }, "nathen");
    // Verify with the same actor → keeps the provenance.actor match.
    await verify(port, [d, f], "nathen", now);

    const res = await personaQuery(port, ont, "nathen", now);
    expect(res.decisions.map((e) => e.id)).toEqual([d]);
    expect(res.facts.map((e) => e.id)).toEqual([f]);
  });

  it("collects via authored_by relation even when verify actor differs", async () => {
    const f = await add("fact", { note: "connector fact" }, "connector");
    // authored_by: from=entity → to=person (the entity was authored by the person).
    await commit(
      port,
      ont,
      { type: "authored_by", attributes: {}, from: f, to: "nathen" },
      prov("connector"),
      now,
    );
    await verify(port, [f], "admin", now); // promoted by a different actor — irrelevant to path (b).

    const res = await personaQuery(port, ont, "nathen", now);
    expect(res.facts.map((e) => e.id)).toEqual([f]);
  });

  it("keeps original author's entities even when someone else verifies (history-wide actor match)", async () => {
    const d = await add(
      "decision",
      { conclusion: "use FTS prefix", rationale: "korean suffix" },
      "nathen",
    );
    await verify(port, [d], "admin", now); // promoted by someone else — must still match the original author in the v1 history.

    const res = await personaQuery(port, ont, "nathen", now);
    expect(res.decisions.map((e) => e.id)).toEqual([d]);
  });

  it("excludes drafts (unverified)", async () => {
    await add("decision", { conclusion: "x", rationale: "y" }, "nathen");
    const res = await personaQuery(port, ont, "nathen", now);
    expect(res.decisions).toEqual([]);
    expect(res.facts).toEqual([]);
  });

  it("excludes verified-but-stale (TTL exceeded)", async () => {
    const f = await add("fact", { note: "aging" }, "nathen"); // fact TTL = 180 days
    await verify(port, [f], "nathen", now);
    const res = await personaQuery(port, ont, "nathen", "2027-06-01T00:00:00Z");
    expect(res.facts).toEqual([]);
  });
});

describe("renderPersonaSkill", () => {
  it("renders a stable SKILL.md for a fixed fixture", () => {
    const person: Entity = {
      id: "nathen",
      type: "person",
      version: 2,
      status: "verified",
      attributes: { name: "Nathen" },
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
        actor: "nathen",
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
        actor: "nathen",
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
      name: persona-nathen
      description: Persona grounded in Nathen's recorded judgments and knowledge
      ---

      # Nathen persona

      Generated: 2026-07-12T12:00:00Z
      Source knowledge (2): 01DECISION@v2, 01FACT@v1

      ## Guiding principles

      - zero-config single file keeps the CLI simple

      ## Decision record

      ### use SQLite
      - Rationale: zero-config single file keeps the CLI simple
      - Source: [decision:01DECISION@v2] nathen, 2026-07-01T00:00:00Z

      ## Knowledge

      - team ships on Fridays — [fact:01FACT@v1] nathen, 2026-07-02T00:00:00Z

      ## Instructions

      Do not answer without a citation. If it is not in the records above, answer "no record".
      Do not speak as if you were Nathen; cite the records.
      "
    `);
  });
});
