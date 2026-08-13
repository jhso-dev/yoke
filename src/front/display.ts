// Presentation shared by the two front adapters. Not core: core deals in records, and how a record
// reads to a person is a front-tier concern (CLAUDE.md invariant 1 — core imports no adapter, and this
// imports only core types).
//
// This file exists because there were two copies of summarize(). The CLI's had a bug fix the web's did
// not — connector-ingested rows summarised as their idempotency key ("rdb:table:1") instead of their
// knowledge — so every web screen showed the defect the CLI had already fixed. One copy, one fix.

import type { WithheldStats } from "../core/inject.js";
import { effectiveStatus } from "../core/lifecycle.js";
import type { TypeDef } from "../core/ontology.js";
import type { Entity, Relation, Status } from "../core/types.js";
import { readEntities } from "../ports/storage.js";
import type { YokeStore } from "./store.js";

/**
 * The status to SHOW for a record: the stored one, unless the type's TTL has expired it.
 *
 * `stale` is computed at read time and never stored (core/lifecycle), so a surface that prints the
 * stored column tells the reader "verified" about a record injection refuses to serve. Reproduced on
 * one record across four commands: `yoke get` and `yoke list` said verified, `yoke review --stale`
 * listed it as aged out, `yoke overview` counted it stale, and `yoke inject` withheld it. A person
 * checking whether their knowledge is live reads `get` and concludes it is.
 *
 * The web tier has always done this (`row()` in ui/server.ts, whose comment describes exactly this
 * hazard). It was fixed there and nowhere else — the same one-copy argument this file was created for.
 *
 * Relations pass through: nothing filters on an edge's status, and no relation type declares a TTL, so
 * computing freshness for one would invent a distinction the rest of the product does not make
 * (`ceiling:` in core/lifecycle on relation promotion).
 */
export function shownStatus(
  e: Entity | Relation,
  ontology: TypeDef[],
  now: string,
): Status {
  return "from" in e ? e.status : effectiveStatus(e, ontology, now);
}

/** A person's display name: the `name` attribute by convention, else the first string attribute.
 * The seed ontology declares `person` with no required attrs, so this is a convention, not a schema
 * guarantee — hence the fallback and the `undefined` when there is nothing readable. */
export function personName(e: Entity, ontology: TypeDef[]): string | undefined {
  const named = e.attributes.name;
  if (typeof named === "string" && named) return named;
  return summarize(e, ontology) || undefined;
}

/**
 * actor id → display name, memoized for one call.
 *
 * Moved here from the web tier, which was the only surface doing it. `yoke list`, `yoke review`,
 * `review --stale`, `yoke history` and the injected citation all printed the raw actor, so a corpus
 * whose authors are person records — which is what `--actor <person-id>` and every seeded corpus
 * produce — rendered a wall of ULIDs on exactly the commands a person reads for meaning. One copy, for
 * the reason this file exists.
 *
 * `provenance.actor` is "a person entity id or agent identifier" (core/types.ts), so half the time
 * it is a ULID that means nothing to a reader. Resolution lives HERE, in the front tier, and never
 * in `citation()`: the citation is the audit pointer and an id is what makes it one — names are not
 * unique and they change, so a renamed person must not rewrite history.
 *
 * A profile DID eventually say these reads matter (v5.5). `prefetch` resolves a whole response's
 * actors in one batch read, because the memo only helps when authors repeat and in a real corpus they
 * do not: an anchored graph at depth 3 spent **1,595 of its 1,715** port calls here, one per distinct
 * author, and the traversal it was blamed on accounted for 117.
 */
export function makeActorNames(store: YokeStore, ontology: TypeDef[]) {
  const seen = new Map<string, string | undefined>();
  const remember = (e: Entity) =>
    seen.set(e.id, e.type === "person" ? personName(e, ontology) : undefined);
  /** Resolve every actor these rows name, in one read. Ids that resolve to nothing — or to something
   * that is not a person — are memoized as "no name", which is what the point read would conclude. */
  const prefetch = async (
    rows: Array<{ provenance: { actor: string } }>,
  ): Promise<void> => {
    const missing = [...new Set(rows.map((r) => r.provenance.actor))].filter(
      (id) => !seen.has(id),
    );
    if (missing.length === 0) return;
    for (const id of missing) seen.set(id, undefined);
    for (const e of await readEntities(store, missing)) remember(e);
  };
  const nameOf = async (actorId: string): Promise<string | undefined> => {
    if (!seen.has(actorId)) {
      // EVERY actor is looked up, including ids containing a colon. A colon looks like a machine
      // actor ('yoke:system', 'connector:github-pr'), but a person's id is whatever created it and
      // `scripts/seed-dummy-it-company.mjs` — this repo's own corpus generator — mints
      // `person:platform-manager`, so skipping those would render every seeded author as a slug on
      // the exact surface that exists to keep ids away from readers. The real guard is the type check
      // in `remember`. Cost: one memoized point read per distinct machine actor per request.
      const e = await store.getEntity(actorId);
      if (e) remember(e);
      else seen.set(actorId, undefined);
    }
    return seen.get(actorId);
  };
  return { nameOf, prefetch };
}

/** Keys that are bookkeeping, never the knowledge. A connector puts external_id first. */
const NOT_CONTENT = new Set([
  "external_id",
  "author",
  "topic",
  "key",
  "status",
]);

/**
 * The compact one-line reading of a record, ≤60 chars.
 *
 * Attribute ORDER as WRITTEN is caller-controlled, so "first string value" is not good enough: a
 * decision committed as `{topic, conclusion, rationale}` summarised as its topic, which made three
 * unrelated decisions all read "caching". Attribute order as DECLARED is not caller-controlled — it
 * is the ontology saying which attribute carries the meaning — so the first declared string that the
 * record actually has wins.
 *
 * Declared order, not required-ness. Required-ness was the rule until `fact` declared `{title,
 * statement}`: `statement` is the required one (it is all the capture path can promise), so every
 * hand-filed fact started summarising as the first 60 characters of its body — "## 개요\n2026-07-14
 * 새벽, 주 결제대행사…" instead of its title. What a type declares FIRST is what it wants read.
 *
 * Falls back to the first string that is not bookkeeping, then to "".
 */
export function summarize(
  entity: { type: string; attributes: Record<string, unknown> },
  ontology: TypeDef[],
): string {
  const def = ontology.find((t) => t.name === entity.type);
  if (def) {
    for (const [key, spec] of Object.entries(def.attrs)) {
      if (spec.type !== "string") continue;
      const val = entity.attributes[key];
      if (typeof val === "string" && val) return val.slice(0, 60);
    }
  }
  for (const [key, val] of Object.entries(entity.attributes)) {
    if (NOT_CONTENT.has(key)) continue;
    if (typeof val === "string" && val) return val.slice(0, 60);
  }
  // Everything was bookkeeping: better to show it than to render nothing at all.
  for (const val of Object.values(entity.attributes)) {
    if (typeof val === "string" && val) return val.slice(0, 60);
  }
  return "";
}

/** A ULID exactly, anchored — the shape a token has to be to name a record. Shared with the audit
 * route, which resolves these for reading, so the two cannot disagree about what looks like an id. */
export const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * The `detail` string for an injection audit row: `<subject tokens> -> <ids>` (SPEC "HTTP API").
 *
 * Three adapters were building this by hand — the CLI, the MCP server and the injection preview — and
 * only the query was ever in it, so the trail could not tell an anchored injection from an unscoped
 * one. That is the number that decides the retrieval design (docs/RESEARCH.md), and it was not being
 * recorded by any of the three.
 *
 * The subject is a token list, newest fact first: anchor, then `@`-prefixed as-of instant, then the
 * query text. A ULID token names a record and the audit screen resolves it; `@`-prefixing the
 * timestamp keeps it from being read as query text. An empty query yields just the anchor, which is
 * what a briefing is.
 */
export function injectDetail(
  ids: string[],
  opts?: { query?: string; scope?: string; asOf?: string },
): string {
  const subject = [
    opts?.scope,
    opts?.asOf ? `@${opts.asOf}` : undefined,
    opts?.query,
  ]
    .filter((t): t is string => !!t)
    .join(" ");
  return `${subject} -> ${ids.join(" ")}`;
}

/**
 * `injectDetail` read back: which workload shape one injection row was.
 *
 * This is the read side of the measurement that clause exists for. The ratio of anchored (a relation
 * hop) and as-of (a clock) reads to plain lookups is what decides whether graph expansion is worth
 * building on, and docs/RESEARCH.md §5 says it must come out of the trail rather than a guess — the
 * write side has been recording it since v5.2 and nothing read it.
 *
 * `asOf` is orthogonal, not a fourth shape: a historical read is still one of the three.
 */
export function injectShape(detail: string): {
  shape: "anchored" | "briefing" | "plain";
  asOf: boolean;
} {
  const tokens = (detail.split(" -> ")[0] ?? "").split(" ").filter(Boolean);
  const anchored = ULID.test(tokens[0] ?? "");
  const rest = tokens.slice(anchored ? 1 : 0);
  const asOf = !!rest[0]?.startsWith("@");
  const query = rest.slice(asOf ? 1 : 0);
  return {
    shape: anchored ? (query.length ? "anchored" : "briefing") : "plain",
    asOf,
  };
}

/**
 * id → how many times an agent has received that record: the `inject` and `persona` audit rows,
 * counted over whatever window of events the caller hands in.
 *
 * This is the governance signal the stale queue orders by. A record agents consumed 47 times last
 * month and one nothing has touched since it was verified both age out the same day; the person
 * re-confirming should meet the first one first. The audit trail already held the answer — every
 * inject/persona row names the ids it returned — so this is an aggregation, not new bookkeeping.
 *
 * `inject_preview`, `read` and `search` are deliberately NOT counted: those record a human governing,
 * and the question here is what AGENTS are being told.
 *
 * Structural event type rather than the adapter's AuditEvent, so this file keeps importing only core.
 * The `detail` grammar is `subject -> id id …` (see `injectDetail`); the ids side is taken from the
 * LAST arrow, since a query in the subject may contain anything.
 */
export function consumptionCounts(
  events: Array<{ action: string; detail: string }>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.action !== "inject" && e.action !== "persona") continue;
    const arrow = e.detail.lastIndexOf(" -> ");
    if (arrow === -1) continue;
    for (const id of e.detail.slice(arrow + 4).split(" ")) {
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Most-consumed first, ties in the caller's order (for the stale queue: scan order, so the result is
 * deterministic). Sorting happens WITHIN the returned page — the scan cursor pages by position, not
 * by rank, so `next` is unaffected.
 *
 * ceiling: within-page ordering only. A globally most-consumed-first queue needs the whole scan
 * before the first row is shown; do that when a corpus is measured with more stale records than fit
 * on one page AND the tail actually matters.
 */
export function rankByConsumption<T extends { id: string }>(
  items: T[],
  counts: Map<string, number>,
): Array<T & { injections: number }> {
  return items
    .map((e, i) => ({ e, i, injections: counts.get(e.id) ?? 0 }))
    .sort((a, b) => b.injections - a.injections || a.i - b.i)
    .map(({ e, injections }) => ({ ...e, injections }));
}

/**
 * An empty injection, said in words: what matched, and why none of it could be handed over.
 *
 * Adapter-neutral on purpose — no command names. Three surfaces phrased this differently (the CLI
 * explained drafts and nothing else, MCP said "no verified knowledge found for: <query>", the web
 * said nothing), and the reason a reader needs is the same on all three. A surface with one next
 * action worth naming appends it; the clause itself travels unchanged.
 */
export function describeWithheld(w: WithheldStats): string {
  const parts: string[] = [];
  if (w.draft > 0) parts.push(`${w.draft} awaiting review`);
  if (w.stale > 0) parts.push(`${w.stale} past its freshness window`);
  if (w.deprecated > 0) parts.push(`${w.deprecated} retired`);
  // Names the remedy, because unlike the others there is nothing to do: the replacement is already in
  // the corpus and answers on its own merits. A reader told only "withheld" would go looking for a
  // record to re-confirm.
  if (w.superseded > 0)
    parts.push(`${w.superseded} replaced by newer knowledge`);
  // Named at length because this is the reason a reader acts wrongly on: verifying it changes nothing.
  if (w.structural > 0)
    parts.push(
      `${w.structural} naming something knowledge is attached to (never injectable as knowledge)`,
    );
  const total = w.draft + w.stale + w.deprecated + w.structural + w.superseded;
  return `${total} match(es) withheld: ${parts.join(", ")}`;
}

/**
 * The governance act that retired a record, read back from the trail: who, when, and why if anyone
 * said. The LAST deprecate naming this id wins — a record can be retired, re-verified and retired
 * again, and the current status is explained by the most recent act, not the first.
 *
 * `ceiling:` scans the namespace's audit rows rather than querying by id, because the trail is a log
 * with no index on the records a row mentions. It is bounded by the deprecate rows in one namespace,
 * which is the count of governance acts rather than of knowledge — add an index when a corpus has
 * enough retirements for this to be felt.
 */
export function retirementOf(
  store: YokeStore,
  id: string,
  ns: string | null,
): { actor: string; at: string; reason?: string } | undefined {
  const rows = store.listAudit({ ns });
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.action !== "deprecate") continue;
    if (!r.detail.split(" ").includes(id)) continue;
    return { actor: r.actor, at: r.at, ...(r.note ? { reason: r.note } : {}) };
  }
  return undefined;
}
