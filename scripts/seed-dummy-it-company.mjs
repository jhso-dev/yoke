#!/usr/bin/env node
// A synthetic corpus generated in code — fast, no data files, English, and every record built from a
// small set of sentence skeletons. That last property is a real limit and it is measured: 0 of 676
// pairs in it are semantically related while lexically different (docs/RESEARCH.md), so retrieval
// changes are invisible against it. Use `scripts/load-demo-corpus.mjs` when the corpus is what is
// under test; use this one when you just need rows.

import { unlinkSync } from "node:fs";
import { commit } from "../dist/core/commit.js";
import { verify } from "../dist/core/lifecycle.js";
import { seedOntology } from "../dist/core/ontology.js";
import { openStore } from "../dist/front/store.js";

// Was an absolute path into another machine's home directory, so the no-argument form wrote nowhere.
const db = process.argv[2] ?? "./dummy-yoke.db";
const now = "2026-07-31T00:00:00.000Z";

for (const suffix of ["", "-wal", "-shm"]) {
  try {
    unlinkSync(db + suffix);
  } catch {}
}

const collaborations = [
  {
    id: "collab:platform-reliability",
    title: "Platform reliability and secure infrastructure",
    focus: "platform reliability",
  },
  {
    id: "collab:product-api-mobile",
    title: "Product API, frontend, and mobile experience",
    focus: "customer-facing product delivery",
  },
  {
    id: "collab:data-ml-intelligence",
    title: "Data, analytics, ML, and experimentation",
    focus: "trusted data and model operations",
  },
  {
    id: "collab:enterprise-enablement",
    title: "Enterprise customer onboarding and enablement",
    focus: "enterprise adoption and support readiness",
  },
  {
    id: "collab:workflow-release-quality",
    title: "Workflow product launch and release quality",
    focus: "workflow launch quality",
  },
];

const people = [
  [
    "person:platform-manager",
    "Mina Park",
    "Platform Engineering Manager",
    "Platform Engineering",
    0,
  ],
  ["person:sre-lead", "Daniel Kim", "Site Reliability Engineer", "SRE", 0],
  [
    "person:infra-engineer",
    "Alex Rivera",
    "Infrastructure Engineer",
    "Cloud Infrastructure",
    0,
  ],
  [
    "person:secops-lead",
    "Priya Shah",
    "Security Operations Lead",
    "Security Operations",
    0,
  ],
  [
    "person:frontend-engineer",
    "Hannah Lee",
    "Senior Frontend Engineer",
    "Product Engineering",
    1,
  ],
  [
    "person:backend-engineer",
    "Owen Brooks",
    "Staff Backend Engineer",
    "Platform Services",
    1,
  ],
  [
    "person:api-architect",
    "Sofia Rodriguez",
    "Principal API Architect",
    "Developer Platform",
    1,
  ],
  [
    "person:mobile-engineer",
    "Ethan Lee",
    "Senior Mobile Engineer",
    "Mobile Experience",
    1,
  ],
  [
    "person:data-engineer",
    "Maya Chen",
    "Senior Data Engineer",
    "Data Platform",
    2,
  ],
  [
    "person:ml-platform",
    "Ravi Patel",
    "Machine Learning Platform Engineer",
    "ML Platform",
    2,
  ],
  [
    "person:analytics-manager",
    "Elena Garcia",
    "Analytics Manager",
    "Business Intelligence",
    2,
  ],
  [
    "person:data-scientist",
    "Jonas Kim",
    "Product Data Scientist",
    "Experimentation",
    2,
  ],
  [
    "person:success-engineer",
    "Grace Choi",
    "Customer Success Engineer",
    "Customer Success Engineering",
    3,
  ],
  [
    "person:support-ops",
    "Daniel Cho",
    "Support Operations Manager",
    "Support Operations",
    3,
  ],
  [
    "person:sales-engineer",
    "Arjun Mehta",
    "Sales Engineer",
    "Solutions Engineering",
    3,
  ],
  [
    "person:docs-lead",
    "Sofia Alvarez",
    "Onboarding and Documentation Lead",
    "Customer Enablement",
    3,
  ],
  [
    "person:eng-manager",
    "Maya Morgan",
    "Engineering Manager",
    "Workflow Engineering",
    4,
  ],
  [
    "person:product-manager",
    "Daniel Ortiz",
    "Senior Product Manager",
    "Workflow Product",
    4,
  ],
  ["person:designer", "Priya Nair", "Product Designer", "Experience Design", 4],
  [
    "person:qa-release",
    "Alex Morgan",
    "QA and Release Manager",
    "Quality Engineering",
    4,
  ],
].map(([id, name, role, team, collab]) => ({ id, name, role, team, collab }));

const practices = [
  "owner, escalation path, and recovery steps",
  "staging validation before production rollout",
  "structured logs with request correlation identifiers",
  "least-privilege access for operational systems",
  "documented rollback criteria before launch",
  "customer-safe status updates during incidents",
  "schema and API compatibility checks",
  "data freshness and quality gates",
  "feature flags with owners and removal dates",
  "runbooks that include symptoms and mitigations",
  "service metrics covering latency, errors, and throughput",
  "synthetic data in shared test environments",
  "accessibility checks for user-facing workflows",
  "auditable approval records for risky changes",
  "capacity review before expected traffic increases",
  "dependency review for licenses and vulnerabilities",
  "post-incident actions with owners and due dates",
  "customer impact notes in release communication",
  "versioned contracts for integrations and events",
  "support handoffs with evidence and next action",
  "privacy review before storing sensitive attributes",
  "performance testing with production-like workloads",
  "business metric definitions in a shared catalog",
  "training material for new workflow owners",
  "dashboard links for operational visibility",
  "retry limits with jitter for remote calls",
  "documented success criteria for pilots",
  "configuration validation at startup",
  "quarterly cleanup of stale dashboards and flags",
  "explicit assumptions in planning documents",
];

function knowledgeFor(person) {
  return practices.map((practice, i) => {
    const area = collaborations[person.collab].focus;
    if (i % 5 === 2) {
      return {
        type: "decision",
        attributes: {
          conclusion: `${person.team} uses ${practice} for ${area}.`,
          rationale: `${person.role} needs this so agents can give consistent operational guidance for ${person.team}.`,
          rejected_alternatives: [
            `Leaving ${practice} as informal tribal knowledge`,
            `Handling ${area} through one-off Slack decisions`,
          ],
        },
      };
    }
    return {
      type: "fact",
      attributes: {
        statement: `${person.team}: ${practice} is required when ${person.role.toLowerCase()} work affects ${area}.`,
      },
    };
  });
}

const collaborationKnowledge = collaborations.flatMap((c, ci) =>
  Array.from({ length: 10 }, (_, i) => ({
    actor: people.find((p) => p.collab === ci).id,
    scope: c.id,
    type: i % 4 === 0 ? "decision" : "fact",
    attributes:
      i % 4 === 0
        ? {
            conclusion: `${c.title} keeps shared decisions in yoke before cross-team handoff ${i + 1}.`,
            rationale: `The collaboration spans multiple teams and needs a single governed context for ${c.focus}.`,
            rejected_alternatives: [
              "Keeping context only in meeting notes",
              "Relying on the latest chat thread for decisions",
            ],
          }
        : {
            statement: `${c.title}: collaboration note ${i + 1} defines ownership, readiness signal, and next action for ${c.focus}.`,
          },
  })),
);

async function add(store, ontology, input, actor, existingId, scope) {
  const prov = { actor, origin: "dummy-seed", occurred_at: now };
  const { entity } = await commit(store, ontology, input, prov, now, {
    existingId,
  });
  await verify(store, [entity.id], "dummy:reviewer", now);
  if (scope) {
    await commit(
      store,
      ontology,
      { type: "relates_to", attributes: {}, from: entity.id, to: scope },
      prov,
      now,
    );
  }
  return entity.id;
}

const store = await openStore({ db }, {});
await store.init();
const ontology = seedOntology();
await store.saveOntology(ontology);

await add(
  store,
  ontology,
  {
    type: "person",
    attributes: {
      name: "Yoke System",
      role: "System actor",
      team: "Automation",
    },
  },
  "yoke:system",
  "yoke:system",
);

for (const c of collaborations) {
  await add(
    store,
    ontology,
    { type: "collaboration", attributes: { title: c.title } },
    "dummy:seed",
    c.id,
  );
}

for (const p of people) {
  await add(
    store,
    ontology,
    {
      type: "person",
      attributes: { name: p.name, role: p.role, team: p.team },
    },
    "dummy:people",
    p.id,
  );
  const _rel = await commit(
    store,
    ontology,
    {
      type: "works_on",
      attributes: {},
      from: p.id,
      to: collaborations[p.collab].id,
    },
    { actor: p.id, origin: "dummy-seed", occurred_at: now },
    now,
  );
  for (const k of knowledgeFor(p)) {
    await add(
      store,
      ontology,
      { type: k.type, attributes: k.attributes },
      p.id,
      undefined,
      collaborations[p.collab].id,
    );
  }
}

for (const k of collaborationKnowledge) {
  await add(
    store,
    ontology,
    { type: k.type, attributes: k.attributes },
    k.actor,
    undefined,
    k.scope,
  );
}

const token = store.createToken({
  name: "admin",
  scopes: ["read", "write", "verify"],
  created_at: now,
}).token;

const entities = await store.listEntities({ limit: 1000 });
const relations = await store.listRelations({ limit: 5000 });
store.close();

console.log(
  JSON.stringify(
    {
      db,
      token,
      people: entities.items.filter((e) => e.type === "person").length - 1,
      collaborations: entities.items.filter((e) => e.type === "collaboration")
        .length,
      knowledge:
        entities.items.filter((e) => e.type === "fact").length +
        entities.items.filter((e) => e.type === "decision").length,
      relations: relations.items.length,
    },
    null,
    2,
  ),
);
