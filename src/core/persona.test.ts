// persona tests — data is prepared through the real SqliteStorage(:memory:) + commit gate.
// personaQuery is a person-anchored inject, so these cases pin what that anchor must and must not
// pull in: authored knowledge yes, knowledge that merely touches the person no.
// renderPersonaSkill is snapshotted with a fixed fixture and a fixed now.

import { beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../adapters/storage-sqlite/index.js";
import { commit } from "./commit.js";
import { deprecate, verify } from "./lifecycle.js";
import { seedOntology } from "./ontology.js";
import {
  checkPersonaSources,
  parsePersonaSources,
  personaQuery,
  renderPersonaSkill,
} from "./persona.js";
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

  // One person, several records (v5.6). Two source systems mapping the same colleague is the case
  // that actually occurs, and before `same_as` a persona built from either record was half that
  // person's judgment presented as all of it.
  describe("same_as: one person, several records", () => {
    /** alias --same_as--> canonical, filed through the gate like any other claim. */
    async function link(from: string, to: string) {
      await commit(
        port,
        ont,
        { type: "same_as", attributes: {}, from, to },
        prov("admin"),
        now,
      );
    }

    it("unions the knowledge of every record that is the same person", async () => {
      const fromRdb = await add("fact", { note: "deploys on fridays" }, "a-hr");
      const fromNotes = await add(
        "fact",
        { note: "owns the gateway" },
        "a-git",
      );
      await verify(port, [fromRdb, fromNotes], "admin", now);
      await link("a-git", "a-hr");

      // Asked about EITHER record, the answer is the whole person — the direction of the link is for
      // whoever reads it, not for the resolver.
      for (const anchor of ["a-hr", "a-git"]) {
        const res = await personaQuery(port, ont, anchor, now);
        expect(res.facts.map((e) => e.id).sort()).toEqual(
          [fromRdb, fromNotes].sort(),
        );
      }
    });

    it("terminates on a cycle and does not repeat a record", async () => {
      const f = await add("fact", { note: "one fact, three records" }, "a1");
      await verify(port, [f], "admin", now);
      // a1 -> a2 -> a3 -> a1. A visited set is the only thing between this and a hang.
      await link("a1", "a2");
      await link("a2", "a3");
      await link("a3", "a1");

      const res = await personaQuery(port, ont, "a2", now);
      expect(res.facts.map((e) => e.id)).toEqual([f]); // reached transitively, exactly once
    });

    // Namespace isolation of the closure itself is in identity.test.ts: through persona it would be
    // vacuous, since inject re-filters candidates by ns and the leak never reaches this assertion.

    it("keeps the alias out of the briefing anchored on the person", async () => {
      // `same_as` is marked membership: the person's OTHER record is not a finding about them.
      const f = await add("fact", { note: "real knowledge" }, "b1");
      await verify(port, [f], "admin", now);
      await link("b2", "b1");
      const b2 = await commit(
        port,
        ont,
        { type: "person", attributes: { name: "B, from the other system" } },
        prov("admin"),
        now,
      );
      await verify(port, [b2.entity.id], "admin", now);

      const res = await personaQuery(port, ont, "b1", now);
      expect(res.facts.map((e) => e.id)).toEqual([f]);
    });
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

// ── --check: auditing an exported snapshot (v5.8) ──────────────────────────────────────────────────
// The export has carried `id@vN` since v1 and nothing read it back, so "a stale snapshot can be
// identified" was a person diffing two files. Each case below isolates ONE cause: a fixture that is
// simultaneously stale and outdated proves nothing about either, since one verdict masks the other.

describe("parsePersonaSources", () => {
  it("round-trips renderPersonaSkill's header", async () => {
    const d = await add(
      "decision",
      { conclusion: "use SQLite", rationale: "zero-config" },
      "alex",
    );
    const f = await add("fact", { note: "ships fridays" }, "alex");
    await verify(port, [d, f], "alex", now);
    // The real person record, so this round-trips what the CLI actually writes.
    await commit(
      port,
      ont,
      { type: "person", attributes: { name: "Alex" } },
      prov("admin"),
      now,
      { existingId: "alex" },
    );
    const person = (await port.getEntity("alex")) as Entity;
    const md = renderPersonaSkill(
      person,
      await personaQuery(port, ont, "alex", now),
      now,
    );

    const header = parsePersonaSources(md);
    expect(header.recognized).toBe(true);
    expect(header.unparsed).toEqual([]);
    // v2: the gate writes v1 as a draft and verify appends the verified row.
    expect(header.sources).toEqual([
      { id: d, version: 2 },
      { id: f, version: 2 },
    ]);
  });

  it("reports an unreadable token instead of dropping it, and a foreign file as unrecognized", () => {
    const bad = parsePersonaSources("Source knowledge (2): 01AAA@v1, 01BBB");
    expect(bad.sources).toEqual([{ id: "01AAA", version: 1 }]);
    expect(bad.unparsed).toEqual(["01BBB"]);
    expect(parsePersonaSources("# just a readme").recognized).toBe(false);
    expect(parsePersonaSources("Source knowledge (0): (none)")).toEqual({
      sources: [],
      unparsed: [],
      recognized: true,
    });
  });

  it("keeps a namespace-prefixed id whole (the id, not the version, holds the colon)", () => {
    expect(
      parsePersonaSources("Source knowledge (1): acme:01AAA@v3").sources,
    ).toEqual([{ id: "acme:01AAA", version: 3 }]);
  });
});

describe("checkPersonaSources", () => {
  /** A verified fact, exported at its current version. */
  async function exported(
    type = "fact",
    attrs: Record<string, unknown> = { note: "ships fridays" },
  ) {
    const id = await add(type, attrs, "alex");
    const [row] = await verify(port, [id], "alex", now);
    return { id, version: row.version };
  }

  it("all current → ok", async () => {
    const src = await exported();
    const [c] = await checkPersonaSources(port, ont, [src], now);
    expect(c.verdict).toBe("ok");
    // Enough of the record travels back for a caller to label it. Core does not render the label —
    // picking the attribute that means something needs the ontology-aware `summarize`, which is front
    // tier, and core imports no adapter.
    expect(c.attributes).toEqual({ note: "ships fridays" });
    expect(c.type).toBe("fact");
  });

  it("a newer version → outdated, and names both versions", async () => {
    const src = await exported();
    // Re-commit bumps the version AND resets status to draft, so verify again — otherwise the verdict
    // would be `draft` and this case would silently stop testing version drift.
    const { entity } = await commit(
      port,
      ont,
      { type: "fact", attributes: { note: "ships thursdays now" } },
      prov("alex"),
      now,
      { existingId: src.id },
    );
    await verify(port, [entity.id], "alex", now);

    const [c] = await checkPersonaSources(port, ont, [src], now);
    expect(c.verdict).toBe("outdated");
    expect(c.version).toBe(src.version);
    expect(c.current).toBe(src.version + 2);
  });

  it("past its TTL → stale, while a longer-lived type beside it stays ok", async () => {
    const fact = await exported();
    const decision = await exported("decision", {
      conclusion: "use SQLite",
      rationale: "zero-config",
    });
    // fact ttl_days 180, decision 365 — one instant that separates them.
    const later = "2027-06-01T00:00:00Z";
    const checks = await checkPersonaSources(
      port,
      ont,
      [fact, decision],
      later,
    );
    expect(checks.map((c) => c.verdict)).toEqual(["stale", "ok"]);
  });

  it("retired → deprecated", async () => {
    const src = await exported();
    await deprecate(port, [src.id], "alex", now);
    const [c] = await checkPersonaSources(port, ont, [src], now);
    expect(c.verdict).toBe("deprecated");
  });

  it("something supersedes it → superseded, outranking the version bump it also has", async () => {
    const src = await exported();
    const replacement = await exported();
    await commit(
      port,
      ont,
      {
        type: "supersedes",
        attributes: {},
        from: replacement.id,
        to: src.id,
      },
      prov("alex"),
      now,
    );
    // Also move its version, so this asserts the PRECEDENCE and not merely that one branch fires:
    // without the supersedes lookup the verdict is `outdated`, which is the wrong thing to hand a
    // reader when a replacement exists.
    const { entity } = await commit(
      port,
      ont,
      { type: "fact", attributes: { note: "superseded wording" } },
      prov("alex"),
      now,
      { existingId: src.id },
    );
    await verify(port, [entity.id], "alex", now);

    const [c] = await checkPersonaSources(port, ont, [src], now);
    expect(c.verdict).toBe("superseded");
  });

  it("not in this namespace → missing (neighbors takes no ns, so the filter is here)", async () => {
    const { entity } = await commit(
      port,
      ont,
      { type: "fact", attributes: { note: "tenant fact" } },
      prov("alex"),
      now,
      { ns: "acme" },
    );
    await verify(port, [entity.id], "alex", now);
    const src = { id: entity.id, version: 2 };

    expect(
      (await checkPersonaSources(port, ont, [src], now, { ns: "acme" }))[0]
        .verdict,
    ).toBe("ok");
    // Same id, default ns: present in storage, absent from this reader's world.
    expect((await checkPersonaSources(port, ont, [src], now))[0].verdict).toBe(
      "missing",
    );
  });
});
