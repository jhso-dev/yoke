// relate: a model proposes the EDGES between records that are already stored.
//
// Why this is not part of `connect raw`. A relation names two entities by id, and an id only exists
// after the gate has accepted the entity — so a connector, whose whole job is to produce input for
// the gate, cannot make one. Running afterwards over what landed is not a workaround for that; it is
// the only order the data allows, and it buys two things:
//
//   - relations can be re-derived without paying for extraction again, which is what makes tuning
//     this affordable at all (extraction of one corpus is hours; relating it is minutes);
//   - it works on records from any connector, not just raw material a model read.
//
// Why it is worth doing. "A relation is knowledge in its own right" is in this project's own
// terminology, and until now the only path that could produce one was a person typing `yoke link`.
// Measured against PersonaMem, where 13 of 19 questions ask how a claim changed and why: yoke filed
// both halves of a preference reversal — the enthusiasm and the "I stopped, because it got
// repetitive" — as two unrelated facts, and the store held zero `conflicts_with`. The trajectory was
// present and unsayable.

import type { TypeDef } from "../core/ontology.js";
import type { Entity } from "../core/types.js";
import type { StoragePort } from "../ports/storage.js";
import { makeJsonCaller } from "./extract.js";

type Env = Record<string, string | undefined>;

/**
 * One record as the model sees it. `ref` is a short local handle — see `refsFor`.
 *
 * `at` is what the source said and is shown to the model; `order` is the caller's ranking of the
 * same records and is what the direction check uses. They are separate because they answer
 * different questions. A conversation extracted into records has an order — later in the file is
 * later — but no per-record clock, and manufacturing timestamps from positions would put invented
 * precision into `occurred_at`, which `--as-of` reads as fact. Ranking costs nothing and claims
 * nothing beyond what the source actually shows.
 */
export interface Ref {
  ref: string;
  type: string;
  text: string;
  at: string;
  order: number;
}

/** A proposed edge, in the model's own vocabulary: local refs, not ids. */
export interface Proposed {
  from: string;
  to: string;
  type: string;
  because: string;
}

export type Relater = (records: Ref[]) => Promise<Proposed[] | null>;

/**
 * Which relation types a model may propose.
 *
 * The same rule as the entity menu, one flag over: `membership` already marks the edges this project
 * says are not knowledge (`works_on`, `same_as` carry it and explain why). Those two are also the
 * pair with the worst failure mode — `same_as` merges two people on a guess — so the flag that keeps
 * them out of a briefing keeps them out of a model's reach for the same reason.
 *
 * `authored_by` survives the filter and is harmless in practice: both endpoints must be records in
 * the batch, and `person` is structural, so no extracted record can be one.
 */
export function linkableTypes(ontology: TypeDef[]): TypeDef[] {
  return ontology.filter((t) => t.kind === "relation" && !t.membership);
}

export function relationMenu(ontology: TypeDef[]): string {
  return linkableTypes(ontology)
    .map((t) => `- ${t.name}${t.symmetric ? " (symmetric)" : ""}`)
    .join("\n");
}

/**
 * Records as short handles. The model never sees a ULID.
 *
 * Two reasons, and the second is the one that matters: a 26-character id is 8 tokens the model has
 * to copy exactly, and a single wrong character is an edge pointing at nothing. `r1` it can copy.
 * Ids are mapped back here, where a lookup either finds the record or the proposal is dropped.
 */
export function refsFor(
  entities: Entity[],
  summarize: (e: Entity) => string,
  order: (e: Entity) => number,
): { refs: Ref[]; byRef: Map<string, Entity> } {
  const refs: Ref[] = [];
  const byRef = new Map<string, Entity>();
  entities.forEach((e, i) => {
    const ref = `r${i + 1}`;
    byRef.set(ref, e);
    refs.push({
      ref,
      type: e.type,
      text: summarize(e),
      at: e.provenance.occurred_at,
      order: order(e),
    });
  });
  return { refs, byRef };
}

/**
 * Rank records the way their sources present them: by the time the source gave, then by the
 * external id, which for an ordered source ends in the record's position within it
 * (`raw:<file>#<n>`). Records with neither fall back to insertion order, which claims nothing.
 */
export function rankOf(records: Entity[]): (e: Entity) => number {
  const key = (e: Entity) =>
    `${e.provenance.occurred_at}\u0000${String(
      e.attributes.external_id ?? "",
    ).replace(/#(\d+)$/, (_m, n) => `#${String(n).padStart(9, "0")}`)}`;
  const ranked = [...records].sort((a, b) => key(a).localeCompare(key(b)));
  const at = new Map(ranked.map((e, i) => [e.id, i]));
  return (e: Entity) => at.get(e.id) ?? 0;
}

export function relateSystemPrompt(ontology: TypeDef[]): string {
  return [
    "r1 is a record from a knowledge base. The records after it are OLDER records about similar",
    "things. Say which of the older ones r1 is linked to, if any.",
    "",
    "Relation types. Use these names exactly — any other name is discarded:",
    relationMenu(ontology),
    "",
    "Return ONLY a JSON array, and nothing else. No prose, no code fence. Each item:",
    '{ "from": "r1", "to": "<older ref>", "type": "<relation type>", "because": "<one sentence>" }',
    "",
    "Rules:",
    "1. `from` is always r1. Use only the refs you were given, and never link a record to itself.",
    "2. `supersedes` means r1 REPLACES the older record — the same subject, and r1 is now what is",
    "   true. Someone who liked something and later stopped gives a supersedes.",
    "3. `conflicts_with` is for two records that cannot both be true now, where neither is clearly",
    "   the replacement — a disagreement rather than a change of mind.",
    "4. Link only what is genuinely connected. Two records about the same broad topic are not linked",
    "   just for that. [] is the right answer whenever nothing here is truly connected, and it is a",
    "   common answer.",
    "5. `because` says what makes the link true, in one sentence, from the records themselves.",
    "",
    "Answer with the JSON array immediately. Do not explain your reasoning first.",
  ].join("\n");
}

/**
 * Drop proposals that cannot be committed, before anything is written.
 *
 * The entity extractor's safety net is the quote check — a record nobody said is dropped. A relation
 * has no single source span to quote, so the equivalent has to be structural, and there are three
 * checks worth having:
 *
 *   - **both endpoints exist**, which is what makes a model's ref a real id rather than a wish;
 *   - **the type was offered**, so a run cannot invent an edge the ontology does not declare;
 *   - **`supersedes` runs later → earlier**, against the caller's ranking rather than the stored
 *     timestamps (see `Ref.order`). This is the one that earns its place. A backwards supersedes
 *     does not read as wrong — it reads as a confident history in which the person went back to
 *     what they had already abandoned, and that is worse than a missing edge, because a reviewer
 *     sees a plausible sentence rather than an obvious mistake. The order is already known, so the
 *     direction is checkable in code and does not need to be trusted.
 */
export function keepLinkable(
  raw: unknown,
  refs: Ref[],
  ontology: TypeDef[],
): Proposed[] {
  if (!Array.isArray(raw)) return [];
  const offered = new Set(linkableTypes(ontology).map((t) => t.name));
  const rank = new Map(refs.map((r) => [r.ref, r.order]));
  const out: Proposed[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { from, to, type, because } = item as Record<string, unknown>;
    if (typeof from !== "string" || typeof to !== "string") continue;
    if (typeof type !== "string" || !offered.has(type)) continue;
    if (from === to) continue;
    if (!rank.has(from) || !rank.has(to)) continue;
    // A later record replaces an earlier one, never the other way round. Records the source gives
    // no order for rank equal, and are dropped rather than guessed at.
    if (
      type === "supersedes" &&
      !((rank.get(from) as number) > (rank.get(to) as number))
    )
      continue;
    out.push({
      from,
      to,
      type,
      because: typeof because === "string" ? because : "",
    });
  }
  return out;
}

/**
 * How many earlier records one newer record is asked about.
 *
 * A first version handed the model thirty records and asked which of them were linked. It does not
 * work, and the reason is worth writing down: the models doing this are reasoning models, and the
 * pairs they have to consider grow with the square of the batch. Measured on `gemma-4-26b-a4b-qat`
 * — 2 records: 437 tokens, a correct answer in 7s. 6 records with a 4,000-token ceiling: every one
 * of those tokens spent in `reasoning_content`, `content` still empty, 61s. 30 records unbounded:
 * fifteen minutes to a timeout, three times over, nothing returned. The cost was never the prompt,
 * which is a kilobyte; it was asking one call to weigh 435 pairs.
 *
 * So the question is asked the other way round. Each record is offered against the handful of
 * earlier records that FTS says resemble it, which is both cheaper and better targeted — a
 * `supersedes` holds between records about the same thing, and that is exactly what search finds.
 * It also removes the ceiling the batch version had: a claim reversed much later than its original
 * is now still offered beside it, because they are neighbours in content rather than in position.
 *
 * YOKE_RELATE_NEIGHBOURS overrides.
 */
const DEFAULT_NEIGHBOURS = 5;

export function neighbourCount(env: Env): number {
  return Number(env.YOKE_RELATE_NEIGHBOURS) > 0
    ? Number(env.YOKE_RELATE_NEIGHBOURS)
    : DEFAULT_NEIGHBOURS;
}

/** One record, and the earlier records worth asking about it. `anchor` is always `refs[0]`. */
export interface Group {
  anchor: Entity;
  refs: Ref[];
  byRef: Map<string, Entity>;
}

/**
 * Pair each record with earlier records that resemble it.
 *
 * Only EARLIER ones: `supersedes` runs newer → older, so an anchor is asked what it might replace,
 * never what might replace it. That halves the pairs considered and gives the question a direction
 * before the model sees it.
 *
 * A record whose search finds nothing is skipped rather than sent — a call that can only answer
 * "nothing is linked" is a call not worth making.
 */
export async function groupsFor(
  port: StoragePort,
  records: Entity[],
  summarize: (e: Entity) => string,
  ns: string | null | undefined,
  neighbours: number,
): Promise<Group[]> {
  const byId = new Map(records.map((e) => [e.id, e]));
  const rank = rankOf(records);
  const groups: Group[] = [];
  for (const anchor of records) {
    const text = summarize(anchor);
    if (!text.trim()) continue;
    const hits = await port.search({
      text,
      ns: ns ?? undefined,
      limit: neighbours * 4,
    });
    const earlier = hits
      .map((h) => byId.get(h.id))
      .filter(
        (e): e is Entity =>
          e !== undefined && e.id !== anchor.id && rank(e) < rank(anchor),
      )
      .slice(0, neighbours);
    if (earlier.length === 0) continue;
    const { refs, byRef } = refsFor([anchor, ...earlier], summarize, rank);
    groups.push({ anchor, refs, byRef });
  }
  return groups;
}

/**
 * A fetch Relater. Null when unconfigured, exactly as the extractor is — the caller refuses rather
 * than reporting a clean run over no links.
 */
export function makeFetchRelater(
  env: Env,
  ontology: TypeDef[],
): Relater | null {
  const call = makeJsonCaller(env, "relating");
  if (!call) return null;
  const system = relateSystemPrompt(ontology);
  return async (records: Ref[]): Promise<Proposed[] | null> => {
    if (records.length < 2) return [];
    const user = records
      .map((r) => `${r.ref} [${r.type}] (${r.at}) ${r.text}`)
      .join("\n");
    const items = await call(system, user);
    return items === null ? null : keepLinkable(items, records, ontology);
  };
}

/** The stored records a relating run considers, oldest first so `supersedes` has a direction to find. */
export async function candidates(
  port: StoragePort,
  ns: string | null | undefined,
  limit: number,
): Promise<Entity[]> {
  const { items } = await port.listEntities({ ns: ns ?? undefined });
  return items
    .filter((e: Entity) => e.status === "verified" || e.status === "draft")
    .sort((a: Entity, b: Entity) =>
      a.provenance.occurred_at.localeCompare(b.provenance.occurred_at),
    )
    .slice(0, limit);
}
