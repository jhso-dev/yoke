// persona 테스트 — 실제 SqliteStorage(:memory:) + commit 게이트로 데이터 준비.
// 수집: actor 매칭 / authored_by / draft·stale 제외 / decision·fact 분류.
// renderPersonaSkill은 고정 fixture + 고정 now로 스냅샷.

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
    // 같은 actor로 verify → provenance.actor 매칭 유지.
    await verify(port, [d, f], "nathen", now);

    const res = await personaQuery(port, ont, "nathen", now);
    expect(res.decisions.map((e) => e.id)).toEqual([d]);
    expect(res.facts.map((e) => e.id)).toEqual([f]);
  });

  it("collects via authored_by relation even when verify actor differs", async () => {
    const f = await add("fact", { note: "connector fact" }, "connector");
    // authored_by: from=entity → to=person (entity가 person에 의해 작성됨).
    await commit(
      port,
      ont,
      { type: "authored_by", attributes: {}, from: f, to: "nathen" },
      prov("connector"),
      now,
    );
    await verify(port, [f], "admin", now); // 다른 actor로 승격 — (b) 경로는 무관.

    const res = await personaQuery(port, ont, "nathen", now);
    expect(res.facts.map((e) => e.id)).toEqual([f]);
  });

  it("keeps original author's entities even when someone else verifies (history-wide actor match)", async () => {
    const d = await add(
      "decision",
      { conclusion: "use FTS prefix", rationale: "korean suffix" },
      "nathen",
    );
    await verify(port, [d], "admin", now); // 타인 승격 — v1 이력의 원저자로 매칭돼야 한다.

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
    const f = await add("fact", { note: "aging" }, "nathen"); // fact TTL = 180일
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
      description: Nathen의 기록된 판단·지식 기반 persona
      ---

      # Nathen persona

      생성 시각: 2026-07-12T12:00:00Z
      소스 지식 (2건): 01DECISION@v2, 01FACT@v1

      ## 판단 원칙

      - zero-config single file keeps the CLI simple

      ## 결정 기록

      ### use SQLite
      - 근거: zero-config single file keeps the CLI simple
      - 출처: [decision:01DECISION@v2] nathen, 2026-07-01T00:00:00Z

      ## 지식

      - team ships on Fridays — [fact:01FACT@v1] nathen, 2026-07-02T00:00:00Z

      ## 지시

      인용 없는 답변 금지. 위 기록에 없으면 '기록 없음'이라고 답하라.
      Nathen인 척 말하지 말고 기록을 인용하라.
      "
    `);
  });
});
