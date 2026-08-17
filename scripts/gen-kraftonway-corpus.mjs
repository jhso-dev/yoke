#!/usr/bin/env node
// Generate + load the Krafton-Way TEST corpus through the same commit gate and openStore path a person
// or an agent uses — the same evidence-of-the-port-abstraction property load-demo-corpus.mjs has.
//
//   node scripts/gen-kraftonway-corpus.mjs <db> [count] [--ns <ns>]
//
// Two layers, one DB, both through commit + PER-AUTHOR verify (so authorship survives — personas and
// the stale queue's owner routing read it; a single-actor bulk verify erases every author):
//   A. curated role files  scripts/kraftonway-corpus/{po,dev,pd,biz}.json  — semantically DISTINCT
//      records. The retrieval-quality + persona + governance slice. Referenced by the gold set.
//   B. programmatic bulk to <count> total. The SCALE slice: proves the loop plumbs at tens of
//      thousands — per-author persona resolution, review/stale queues fill, inject latency.
//
// ceiling: B is mechanical expansion over per-role subtopic pools with per-record concrete anchors
// (date/version/metric/seq). It tests scale/plumbing/persona, NOT retrieval-quality nuance — that is A's
// job, and why A exists as hand-authored files (see scripts/demo-corpus/README.md: a templated corpus
// is one where every query matches everything, measured 0/676 semantic pairs once already).
//
// YOKE_EMBED_URL/MODEL set  -> records embed inline (hybrid retrieval + dedup/contradiction detection).
// unset                     -> keyword-only corpus, complete minus the vector half. The run says which.
// All records carry origin "kraftonway-test"; the DB file is the isolation boundary, so the default ns
// is the shared one (pass --ns only to load into a shared multi-tenant DB).

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { commit } from "../dist/core/commit.js";
import { makeFetchEmbedder } from "../dist/core/embedding.js";
import { deprecate, verify } from "../dist/core/lifecycle.js";
import { seedOntology } from "../dist/core/ontology.js";
import { openStore } from "../dist/front/store.js";

// --- args ---------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const LOCAL = argv[0] ?? "./kraftonway.db";
// The isolation boundary is the DB FILE (a fresh dedicated file holds nothing else), so the default ns
// is the shared/default one — which lets the core evals (inject/listEntities take an explicit ns) and
// the CLI read it with no --ns. Pass --ns only when loading into a shared multi-tenant DB.
const nsFlag = argv.indexOf("--ns");
const NS = nsFlag >= 0 ? argv[nsFlag + 1] : null;
const COUNT = Number(argv.find((a, i) => i > 0 && /^\d+$/.test(a)) ?? 30000);

const A_DIR = fileURLToPath(new URL("kraftonway-corpus", import.meta.url));
const NOW = "2026-08-04T09:00:00.000Z";
const DAY = 86400000;
const iso = (daysAgo) =>
  new Date(Date.parse(NOW) - daysAgo * DAY).toISOString();
// Deterministic occurred_at spread. No Math.random: a reload must produce the same corpus.
const dateForKey = (key) => {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return iso(h % 3000); // spread across ~8 years so fact(180d)/decision(365d) TTLs straddle
};

// --- the real cast (persona anchors). Referenced by id from the role files; defined once here. -----
const CAST = [
  {
    id: "person:jang-byeonggyu",
    name: "장병규",
    role: "의장/창업자",
    team: "경영",
  },
  {
    id: "person:kim-changhan",
    name: "김창한",
    role: "PUBG 총괄/CEO",
    team: "제품",
  },
  {
    id: "person:kim-gangseok",
    name: "김강석",
    role: "공동창업/전 CEO",
    team: "경영",
  },
  {
    id: "person:park-yonghyun",
    name: "박용현",
    role: "개발본부장",
    team: "개발",
  },
  {
    id: "person:brendan-greene",
    name: "브렌든 그린",
    role: "크리에이티브 디렉터",
    team: "디자인",
  },
];
const ROLES = {
  po: {
    collab: { id: "collab:pubg-product", title: "PUBG 제품 기획·로드맵" },
    cast: ["person:kim-changhan", "person:jang-byeonggyu"],
  },
  dev: {
    collab: { id: "collab:pubg-eng", title: "PUBG 엔지니어링" },
    cast: ["person:park-yonghyun", "person:kim-changhan"],
  },
  pd: {
    collab: { id: "collab:pubg-design", title: "PUBG 게임 디자인" },
    cast: ["person:brendan-greene", "person:kim-changhan"],
  },
  biz: {
    collab: { id: "collab:krafton-corp", title: "크래프톤 사업·전략" },
    cast: [
      "person:jang-byeonggyu",
      "person:kim-gangseok",
      "person:kim-changhan",
    ],
  },
};

// Cross-role INITIATIVES. The ROLES above are functional homes (one role each); these are the shared
// work items a real org collaborates on — PUBG pulled PO + designer + dev + business onto one bet. Each
// initiative's `people` span roles (works_on), and any A-layer record whose text matches `match` is
// attached (relates_to), so a briefing anchored on the initiative returns a CROSS-FUNCTIONAL set — the
// team-productivity value a per-department corpus cannot show.
const INITIATIVES = [
  {
    id: "collab:pubg",
    title:
      "배틀그라운드(PUBG) — 전사 크로스펑셔널 이니셔티브 (기획·디자인·엔지니어링·사업)",
    people: [
      "person:kim-changhan",
      "person:brendan-greene",
      "person:park-yonghyun",
      "person:jang-byeonggyu",
    ],
    match:
      /PUBG|배틀그라운드|배틀로열|플레이어언노운|얼리액세스|자기장|매치메이킹/i,
  },
  {
    id: "collab:tera-launch",
    title: "TERA 출시 (2011) — 개발·기획·사업 합동",
    people: [
      "person:park-yonghyun",
      "person:kim-gangseok",
      "person:jang-byeonggyu",
    ],
    match: /TERA|테라/i,
  },
  {
    id: "collab:portfolio-pivot",
    title: "블루홀 2.0 포트폴리오 피벗 — 사업·제품 합동",
    people: [
      "person:jang-byeonggyu",
      "person:kim-gangseok",
      "person:kim-changhan",
    ],
    match: /포트폴리오|블루홀 ?2\.0|블루홀2|지노게임즈|하나의 걸작|단일 대작/i,
  },
  {
    id: "collab:ipo-2021",
    title: "크래프톤 코스피 IPO (2021) — 사업·경영 합동",
    people: [
      "person:jang-byeonggyu",
      "person:kim-changhan",
      "person:kim-gangseok",
    ],
    match: /IPO|상장|공모가|코스피|리브랜딩|크래프톤 개명/i,
  },
];

// --- open store, seed ontology + bootstrap actor ------------------------------------------------
for (const s of ["", "-wal", "-shm"]) rmSync(LOCAL + s, { force: true });
const embedder = makeFetchEmbedder(process.env);
const vectors = (await embedder("probe")) !== null;
console.log(
  vectors
    ? `embedder: ${process.env.YOKE_EMBED_MODEL} — vectors on`
    : "embedder: none — keyword-only corpus (set YOKE_EMBED_URL for hybrid)",
);
console.log(`ns=${NS ?? "(default)"}  target=${COUNT} records  db=${LOCAL}`);

const store = await openStore({ db: LOCAL }, process.env);
await store.init();
const ontology = seedOntology();
await store.saveOntology(ontology);

if (!(await store.getEntity("yoke:system"))) {
  const at = "2025-01-01T00:00:00.000Z";
  const { entity } = await commit(
    store,
    ontology,
    { type: "person", attributes: { name: "yoke" } },
    { actor: "yoke:system", origin: "seed", occurred_at: at },
    at,
    { existingId: "yoke:system" },
  );
  await verify(store, [entity.id], "yoke:system", at);
}

const commitRec = async (input, actor, at, existingId) => {
  const { entity } = await commit(
    store,
    ontology,
    input,
    { actor, origin: "kraftonway-test", occurred_at: at },
    at,
    { embedder, existingId, ns: NS },
  );
  return entity.id;
};
const rel = (type, from, to, actor, at) =>
  commitRec({ type, attributes: {}, from, to }, actor, at);

const c = {
  people: 0,
  collab: 0,
  aRecords: 0,
  bRecords: 0,
  relations: 0,
  draft: 0,
  stale: 0,
  deprecated: 0,
  conflictPairs: 0,
};

// The confirm time for a given state. decision expires at 365d, fact at 180d; "stale" is computed at
// read time from last_confirmed, never stored — so we confirm in the past and let the ontology decide.
const confirmAt = (type, state) =>
  state === "stale" ? iso(type === "decision" ? 400 : 200) : NOW;
const verifyAsAuthor = async (id, type, author, state) => {
  if (state === "draft") {
    c.draft++;
    return;
  }
  await verify(store, [id], author, confirmAt(type, state), NS);
  if (state === "stale") c.stale++;
};

// ================================================================================================
// A. curated role files
// ================================================================================================
const seededPeople = new Set();
const seedPerson = async (p) => {
  if (seededPeople.has(p.id)) return;
  await commitRec(
    {
      type: "person",
      attributes: { name: p.name, role: p.role ?? "", team: p.team ?? "" },
    },
    "person:steward",
    NOW,
    p.id,
  );
  seededPeople.add(p.id);
  c.people++;
};
const seededCollabs = new Set();
const seedCollab = async (col) => {
  if (seededCollabs.has(col.id)) return;
  await commitRec(
    { type: "collaboration", attributes: { title: col.title } },
    "person:steward",
    NOW,
    col.id,
  );
  seededCollabs.add(col.id);
  c.collab++;
};

await seedPerson({
  id: "person:steward",
  name: "지식 관리자",
  role: "Knowledge Steward",
  team: "Enablement",
});
for (const p of CAST) await seedPerson(p);
for (const r of Object.values(ROLES)) await seedCollab(r.collab);

const aFiles = existsSync(A_DIR)
  ? readdirSync(A_DIR)
      .filter((f) => /\.json$/.test(f))
      .sort()
  : [];
const roleFiles = []; // { role, collab, records, links, conflicts }
for (const f of aFiles) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(`${A_DIR}/${f}`, "utf8"));
  } catch (e) {
    console.error(`  SKIP ${f}: ${e.message}`);
    continue;
  }
  const role = doc.role ?? f.replace(/\.json$/, "");
  const collab = doc.collaboration ??
    ROLES[role]?.collab ?? { id: `collab:${role}`, title: role };
  await seedCollab(collab);
  for (const p of doc.people ?? []) {
    await seedPerson(p);
    await rel("works_on", p.id, collab.id, p.id, NOW);
    c.relations++;
  }
  roleFiles.push({
    role,
    collab,
    records: doc.records ?? [],
    links: doc.links ?? [],
    conflicts: doc.conflicts ?? [],
  });
}

// Cross-role initiatives: seed each and put its people (spanning roles) on it via works_on.
c.initiativeLinks = 0;
for (const ini of INITIATIVES) {
  await seedCollab({ id: ini.id, title: ini.title });
  for (const pid of ini.people) {
    await seedPerson(CAST.find((p) => p.id === pid) ?? { id: pid, name: pid });
    await rel("works_on", pid, ini.id, pid, NOW);
    c.relations++;
  }
}

// records + per-author verify + relates_to anchor
for (const rf of roleFiles) {
  const byKey = new Map();
  for (const r of rf.records) {
    const at =
      r.state === "stale" ? confirmAt(r.type, "stale") : dateForKey(r.key);
    const id = await commitRec(
      { type: r.type, attributes: r.attributes },
      r.author,
      at,
    );
    byKey.set(r.key, id);
    await verifyAsAuthor(id, r.type, r.author, r.state ?? "verified");
    await rel("relates_to", id, rf.collab.id, r.author, at);
    c.relations++;
    // Attach to every cross-role initiative this record's text is about, so the initiative's briefing
    // draws from all four role files, not just one department.
    const text = JSON.stringify(r.attributes ?? {});
    for (const ini of INITIATIVES)
      if (ini.match.test(text)) {
        await rel("relates_to", id, ini.id, r.author, at);
        c.relations++;
        c.initiativeLinks++;
      }
    c.aRecords++;
  }
  for (const l of rf.links ?? []) {
    const from = byKey.get(l.from),
      to = byKey.get(l.to);
    if (!from || !to) continue;
    await rel(l.type, from, to, "person:steward", NOW);
    c.relations++;
    if (l.type === "supersedes") {
      await deprecate(store, [to], "person:steward", NOW, NS);
      c.deprecated++;
    }
  }
  for (const pair of rf.conflicts ?? []) {
    const ids = [];
    for (const side of [pair.a, pair.b]) {
      const at = iso((side.age_days ?? 30) + 5);
      const id = await commitRec(
        { type: side.type, attributes: side.attributes },
        side.author,
        at,
      );
      await verify(store, [id], side.author, iso(side.age_days ?? 30), NS);
      await rel("relates_to", id, rf.collab.id, side.author, at);
      c.relations++;
      ids.push(id);
    }
    await rel("conflicts_with", ids[0], ids[1], "person:steward", NOW);
    c.relations++;
    c.conflictPairs++;
  }
  console.log(
    `  A/${rf.role}: ${rf.records.length} records, ${(rf.conflicts ?? []).length} conflict pairs`,
  );
}

// synthetic people pool per role (cast + file people), for B authorship
const peopleByRole = {};
for (const [role, def] of Object.entries(ROLES))
  peopleByRole[role] = [...def.cast];
for (const rf of roleFiles) {
  if (!peopleByRole[rf.role]) peopleByRole[rf.role] = [];
  const pool = peopleByRole[rf.role];
  for (const p of rf.records) if (!pool.includes(p.author)) pool.push(p.author);
}
// ensure each role has enough authors even with no A files: mint synthetic teammates
for (const [role, def] of Object.entries(ROLES)) {
  const pool = peopleByRole[role];
  let i = pool.length;
  while (pool.length < 12) {
    const id = `person:${role}-syn${i}`;
    await seedPerson({
      id,
      name: `${role.toUpperCase()} 팀원${i}`,
      role: `${role} 담당`,
      team: `${role}팀`,
    });
    await rel("works_on", id, def.collab.id, id, NOW);
    c.relations++;
    pool.push(id);
    i++;
  }
}

// ================================================================================================
// B. programmatic bulk to COUNT total
// ================================================================================================
// Per-role subtopic pools give retrieval separability at the subtopic level; per-record concrete
// anchors (index-derived metric, version, year, seq) keep records distinct.
const SUBTOPICS = {
  po: [
    "로드맵 우선순위",
    "BM/수익화 스코프",
    "얼리액세스 범위",
    "글로벌 출시 순서",
    "e스포츠/서킷",
    "시즌 패스",
    "크로스플랫폼",
    "콘솔 이식",
    "지역별 요금제",
    "라이브 이벤트",
    "커뮤니티 피드백 반영",
    "리텐션 개선",
  ],
  dev: [
    "매치메이킹",
    "안티치트",
    "서버 리전 확장",
    "클라이언트 최적화",
    "네트워크 동기화",
    "빌드 파이프라인",
    "로그/텔레메트리",
    "결제 연동",
    "크래시 리포팅",
    "레벨 스트리밍",
    "물리 엔진",
    "부하 테스트",
    "핫픽스 배포",
    "디도스 대응",
  ],
  pd: [
    "자기장 밸런스",
    "무기 밸런스",
    "루팅 분포",
    "맵 밀도",
    "이동 속도",
    "차량 밸런스",
    "사운드 디자인",
    "미니맵 UX",
    "인벤토리 UX",
    "티어/랭크 설계",
    "튜토리얼",
    "관전 모드",
  ],
  biz: [
    "투자 유치",
    "M&A 검토",
    "조직 개편",
    "번레이트 관리",
    "퍼블리싱 계약",
    "지역 파트너십",
    "IP 라이선싱",
    "IPO 준비",
    "지분 구조",
    "리스크/법무",
    "채용 계획",
    "IR 커뮤니케이션",
  ],
};
const YEARS = [2011, 2013, 2015, 2016, 2017, 2018, 2019, 2020, 2021];

const roleKeys = Object.keys(ROLES);
const bTarget = Math.max(0, COUNT - c.aRecords);
const prevByAuthorTopic = new Map(); // for occasional supersedes chains
const perRole = Object.fromEntries(roleKeys.map((r) => [r, 0]));
let made = 0;
const t0 = Date.now();
for (let i = 0; made < bTarget; i++) {
  const role = roleKeys[i % roleKeys.length];
  const def = ROLES[role];
  // Per-role counter, NOT i: role and i share a period, so keying subtopic/author off i leaves some
  // (role, subtopic) pairs never generated. k cycles each role through all its subtopics and authors.
  const k = perRole[role]++;
  const pool = peopleByRole[role];
  const author = pool[k % pool.length];
  const subs = SUBTOPICS[role];
  const sub = subs[k % subs.length];
  const year = YEARS[(k * 3) % YEARS.length];
  const seq = 100 + (k % 900);
  const metric = 1 + ((k * 37 + role.length) % 9800); // distinct-ish number per record
  const version = `v${1 + (k % 6)}.${k % 20}`;
  const rtypeRoll = k % 10;
  const type =
    rtypeRoll < 5
      ? "decision"
      : rtypeRoll < 8
        ? "fact"
        : rtypeRoll < 9
          ? "term"
          : "resource";
  const stateRoll = k % 20;
  const state = stateRoll < 3 ? "draft" : stateRoll < 6 ? "stale" : "verified";
  const key = `b-${role}-${i}`;
  const at = state === "stale" ? confirmAt(type, "stale") : dateForKey(key);

  let attributes;
  if (type === "decision") {
    attributes = {
      conclusion: `[${year}] ${sub} 관련 결정 #${seq}: ${sub}의 기준값을 ${metric}로 확정하고 ${version} 빌드에 반영한다. (${role} 워크스트림, 합성 테스트 레코드)`,
      rationale: `${sub}에 대한 ${year}년 시점 데이터에서 지표가 ${metric} 부근일 때 목표를 가장 잘 만족했다. 대안들은 운영 비용·리스크·일정 측면에서 이 결정보다 열위였다. 본 레코드는 크래프톤 스토리를 묘사한 합성 테스트 데이터이며 수치는 예시값이다.`,
      rejected_alternatives: [
        `${sub} 기준값을 ${metric * 2}로 두는 안 — 비용/리스크 과다로 기각`,
        `${sub}를 ${version} 범위에서 제외하는 안 — 목표 미달로 기각`,
      ],
    };
  } else if (type === "fact") {
    attributes = {
      title: `[${year}] ${sub} 관측 #${seq}`,
      statement: `${year}년 ${sub} 관련 지표가 ${metric}로 측정됐고 ${version} 배포 이후 변동 폭이 관찰됐다. (${role}, 합성 테스트 데이터, 수치는 예시)`,
    };
  } else if (type === "term") {
    attributes = {
      title: `${sub} (${role} 용어 #${seq})`,
      statement: `${sub}: ${role} 도메인에서 ${sub}가 의미하는 바에 대한 정의. 기준 지표 축은 ${metric} 단위로 관리한다. (합성 테스트 정의)`,
    };
  } else {
    attributes = {
      title: `${sub} 문서 #${seq}`,
      statement: `${year} ${sub} 관련 내부 문서 포인터 (${version}). 합성 테스트 리소스.`,
      url: `https://example.test/kraftonway/${role}/${sub}/${seq}`,
    };
  }

  const id = await commitRec({ type, attributes }, author, at);
  await verifyAsAuthor(id, type, author, state);
  await rel("relates_to", id, def.collab.id, author, at);
  c.relations++;

  // occasional supersedes chain: a later verified decision supersedes the same author+subtopic's prior
  if (type === "decision" && state === "verified") {
    const ck = `${author}|${sub}`;
    const prev = prevByAuthorTopic.get(ck);
    if (prev && i % 7 === 0) {
      await rel("supersedes", id, prev, author, at);
      c.relations++;
      await deprecate(store, [prev], author, at, NS);
      c.deprecated++;
    }
    prevByAuthorTopic.set(ck, id);
  }
  c.bRecords++;
  made++;
  if (made % 2000 === 0)
    console.log(
      `  B: ${made}/${bTarget}  (${Math.round(made / ((Date.now() - t0) / 1000))}/s)`,
    );
}

// The roster and anchors are not knowledge under review — leaving them draft would fill the review
// queue with rows nobody is meant to act on. Verify as steward (people/collabs have no author to erase).
for (const type of ["person", "collaboration"]) {
  const { items } = await store.listEntities({
    type,
    status: "draft",
    ns: NS,
    limit: 5000,
  });
  if (items.length)
    await verify(
      store,
      items.map((e) => e.id),
      "person:steward",
      NOW,
      NS,
    );
}

const token = store.createToken({
  name: "admin",
  scopes: ["read", "write", "verify"],
  created_at: NOW,
}).token;
store.close();
console.log(
  `\n${JSON.stringify({ ...c, total: c.aRecords + c.bRecords, vectors, ns: NS, token, db: LOCAL }, null, 2)}`,
);
