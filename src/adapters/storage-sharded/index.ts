// storage-sharded (PLAN-V2 12.1) — ShardedStorage composes member StoragePorts behind ONE port.
// Core is untouched: sharding lives entirely behind the storage port (the ARCHITECTURE bet paying off).
//
// Routing:
//   - writes (putEntity/putRelation) route by the row's ns → its owner shard (default shard for
//     unlisted/null ns).
//   - point reads (getEntity, neighbors) fan out to every shard (ids are globally unique ULIDs):
//     getEntity returns the first non-null; neighbors concat-merges.
//   - search: ns-scoped → owner shard only; un-scoped → fan out and INTERLEAVE the per-shard ranked
//     lists before applying the limit (concatenating gave shard 0 the whole page).
//     Each member self-filters by ns (see the adapters), so isolation holds per shard.
//   - similar: fan out to members that have the capability, concat, re-rank the merged hits by cosine
//     to the query embedding, slice k. Exposed ONLY if at least one member implements it.
//
//   - enumeration (listEntities/listRelations): ns-scoped → owner shard; un-scoped → fan out and
//     merge by id. `after` is a global predicate over globally unique ULIDs, so no per-shard cursor
//     map is needed (see listMerged).
//
// The remaining extension surface (listHistory/ontology/audit/tokens) is the sqlite-shaped surface
// used by CLI/UI/serve. Audit + tokens live on the default shard (a single audit/token stream).
// ceiling: that surface assumes the default shard (and any ns owner it targets) is a sqlite
// backend. `ShardKind` is `"sqlite"` only, so the assumption cannot currently be violated — the note
// stays because it is the constraint a second shard kind would have to meet: a
// non-sqlite member participates in the core port, which since v5.0 includes enumeration, so the
// review queue and conflicts view work there too — but not in the sqlite-only extensions (no
// tokens, and its ontology methods are async). Give a tenant on a non-sqlite backend
// its own serve process if it needs audit/token features.
//
// Duplicate/contradiction detection stays intra-shard automatically: commit() calls this.similar,
// which here fans out across ALL capable shards — so a duplicate WARNING can cross shard boundaries
// (surfaced in CommitResult.duplicates, never auto-merged). The conflicts_with relation the gate may
// create carries the new entity's ns, so it lands in that entity's shard and neighbors() fan-out
// still resolves the foreign id. ns-isolation-sensitive deployments (where even seeing a peer
// tenant's near-duplicate is a leak) should give each tenant its own serve process.
// ceiling: cross-shard similar fan-out is the known ceiling. Upgrade path is an ns-aware
// `similar(embedding, k, ns?)` on the port — a StoragePort contract change, so it waits for a real
// deployment to need it rather than being made from here.

import { normalizeNs } from "../../core/namespace.js";
import { overlayOntology, type TypeDef } from "../../core/ontology.js";
import type { Entity, Relation } from "../../core/types.js";
import type {
  ListQuery,
  Page,
  StoragePort,
  TextQuery,
} from "../../ports/storage.js";
import { DEFAULT_SEARCH_LIMIT } from "../../ports/storage.js";
import type {
  AuditEvent,
  AuditQuery,
  TokenInfo,
} from "../storage-sqlite/index.js";
import { loadShardConfig, makeShard } from "./config.js";

export type { AuditEvent, AuditQuery, TokenInfo };

/** The full storage surface CLI/UI/serve rely on: the port plus the sqlite-shaped extension methods.
 *  SqliteStorage satisfies it structurally; ShardedStorage implements it by delegation. */
export interface YokeStore extends StoragePort {
  /** async since v5.2: a remote backend writes over a network, and a synchronous
   * fire-and-forget would discard the error (SPEC "Remote backends"). */
  saveOntology(defs: TypeDef[], ns?: string | null): Promise<void>;
  loadOntology(ns?: string | null): TypeDef[];
  /** OPTIONAL: synchronous, and it is about entity rows — which on a remote backend are across a
   * network, so `storage-composite` genuinely cannot provide it. Callers feature-detect through
   * core's `listVersions`, which falls back to walking `getEntity(id, version)`. */
  listHistory?(id: string): Entity[];
  /** async since v5.2: it rewrites entity rows, and on a remote backend those are across a network. */
  renameType(from: string, to: string, ns?: string | null): Promise<number>;
  logAudit(event: AuditEvent): void;
  listAudit(q?: AuditQuery): AuditEvent[];
  createToken(spec: { name: string; scopes: string[]; created_at: string }): {
    token: string;
  };
  verifyToken(secret: string): { name: string; scopes: string[] } | null;
  revokeToken(name: string): boolean;
  listTokens(): TokenInfo[];
  backupTo(dest: string): Promise<void>;
  exportUntil(ts: string, destPath: string): Promise<void>;
  /**
   * Whether the underlying file's pages are readable — `"ok"`, or the engine's complaint.
   *
   * Optional, because it is a physical-storage question and a remote backend has no single file to ask
   * about. A caller that gets `undefined` has learned nothing and must not treat that as a failure.
   */
  integrityCheck?(): string;
}

export interface ShardMember {
  name: string;
  store: StoragePort;
  namespaces: string[];
  isDefault: boolean;
}

/** Partial view for feature-detecting the extension methods on a member typed as a bare StoragePort. */
type ExtStore = Partial<YokeStore>;

/** Cosine similarity; -Infinity when an operand embedding is missing (sorts such hits last). */
function cosine(a: Float32Array, b?: Float32Array): number {
  if (!b) return Number.NEGATIVE_INFINITY;
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const PER_SHARD = (op: string) =>
  new Error(
    `${op} is a per-shard operation: run it against each shard's own db (see its --db path)`,
  );

export class ShardedStorage implements YokeStore {
  private readonly defaultShard: ShardMember;

  // Present only when at least one member supports it (assigned in the constructor) — so `typeof
  // port.similar` / `"similar" in port` reflect the real capability (commit() and conformance rely on it).
  similar?: (embedding: Float32Array, k: number) => Promise<Entity[]>;

  // C4: present only when EVERY member supports it, so `typeof port.withCriticalSection` reflects the
  // real capability that ingest feature-detects (ingest.ts) and conformance pins. A sharded store
  // routes one ns's writes to one shard, but the section is handed a bare `fn` with no ns, so we
  // cannot know up front which shard it touches. So we take the write lock on EVERY member (nested,
  // in member order) around `fn`: two concurrent ingests both block on the first member's
  // `BEGIN IMMEDIATE`, so mutual exclusion holds cross-process, and each member's nested
  // putEntity/putRelation becomes a savepoint that commits or rolls back with the section.
  withCriticalSection?: <T>(fn: () => Promise<T>) => Promise<T>;

  constructor(private readonly members: ShardMember[]) {
    const def = members.find((m) => m.isDefault);
    if (!def)
      throw new Error("sharded storage needs exactly one default shard");
    this.defaultShard = def;
    if (members.some((m) => typeof m.store.similar === "function")) {
      this.similar = (embedding, k) => this.similarImpl(embedding, k);
    }
    // Exposed only when every member can serialize — a section that skipped an unlockable member
    // would not actually wrap writes routed there. ceiling: locking all shards serializes ingest
    // across ALL namespaces, not just the section's own ns, and holds N write locks for `fn`'s
    // duration. Correct but coarse. Upgrade path: an ns-scoped `withCriticalSection(fn, ns?)` on the
    // port that locks only the owner shard — a StoragePort contract change, deferred until a sharded
    // deployment's ingest throughput needs it.
    if (
      members.every((m) => typeof m.store.withCriticalSection === "function")
    ) {
      this.withCriticalSection = (fn) => this.critSecImpl(fn);
    }
  }

  /** Nest each member's critical section so `fn` runs inside all of them (see the field comment). */
  private critSecImpl<T>(fn: () => Promise<T>): Promise<T> {
    const nest = (i: number): Promise<T> =>
      i >= this.members.length
        ? fn()
        : // biome-ignore lint/style/noNonNullAssertion: exposed only when every member has it.
          this.members[i].store.withCriticalSection!(() => nest(i + 1));
    return nest(0);
  }

  /** The shard owning ns: the one listing it, else the default shard (null/unlisted ns → default). */
  private ownerOf(ns?: string | null): ShardMember {
    const n = normalizeNs(ns);
    if (n !== null) {
      const owner = this.members.find((m) => m.namespaces.includes(n));
      if (owner) return owner;
    }
    return this.defaultShard;
  }

  async init(): Promise<void> {
    await Promise.all(this.members.map((m) => m.store.init()));
  }

  close(): void {
    for (const m of this.members) m.store.close();
  }

  async putEntity(e: Entity): Promise<void> {
    await this.ownerOf(e.ns).store.putEntity(e);
  }

  /** Routed by ns like every other write — which is why the port method takes the entity rather than a
   * bare id. Optional-chained: a member backend without vector support simply indexes nothing. */
  async putEmbedding(e: Entity, opts?: { rebuild?: boolean }): Promise<void> {
    await this.ownerOf(e.ns).store.putEmbedding?.(e, opts);
  }

  async putRelation(r: Relation): Promise<void> {
    await this.ownerOf(r.ns).store.putRelation(r);
  }

  async getEntity(id: string, version?: number): Promise<Entity | null> {
    const results = await Promise.all(
      this.members.map((m) => m.store.getEntity(id, version)),
    );
    return results.find((e) => e !== null) ?? null;
  }

  /** Point read, fanned out like `getEntity`: ids are globally unique, so the first hit is the answer. */
  async getRelation(id: string, version?: number): Promise<Relation | null> {
    const results = await Promise.all(
      this.members.map((m) => m.store.getRelation?.(id, version) ?? null),
    );
    return results.find((r) => r != null) ?? null;
  }

  async neighbors(
    id: string,
    relType?: string,
    dir?: "in" | "out",
  ): Promise<Relation[]> {
    const groups = await Promise.all(
      this.members.map((m) => m.store.neighbors(id, relType, dir)),
    );
    return groups.flat();
  }

  async search(q: TextQuery): Promise<Entity[]> {
    if (normalizeNs(q.ns) !== null) return this.ownerOf(q.ns).store.search(q);
    const groups = await Promise.all(
      this.members.map((m) => m.store.search(q)),
    );
    // Each shard returns ITS best first (SPEC search clause 6). Concatenating and slicing gave
    // shard 0 the whole page and shard 1 nothing, so a record could be the best match in the
    // namespace and never appear. Interleaving takes shard 0's best, then shard 1's best, and so on,
    // so every shard's head is represented in the merged head.
    //
    // ceiling: this is not a globally ranked merge, because `search` returns entities and not
    // scores — there is nothing to merge ON. Round-robin is the best available approximation, and it
    // is exact for one shard, which is every deployment until someone shards. Upgrade path: a scored
    // search on the port, a contract change worth making when a sharded corpus needs it.
    const merged: Entity[] = [];
    for (let i = 0; groups.some((g) => i < g.length); i++)
      for (const g of groups) if (i < g.length) merged.push(g[i]);
    return merged.slice(0, q.limit ?? DEFAULT_SEARCH_LIMIT);
  }

  listEntities(q: ListQuery): Promise<Page<Entity>> {
    return this.listMerged(q, (m) => m.store.listEntities(q));
  }

  listRelations(q: ListQuery): Promise<Page<Relation>> {
    return this.listMerged(q, (m) => m.store.listRelations(q));
  }

  /**
   * ns-scoped goes to the owner shard and its cursor is that shard's cursor. Un-scoped fans out.
   *
   * No per-shard cursor map is needed, and that is not an accident: `id > after` is a GLOBAL
   * predicate over globally unique ULIDs, so each member returns its own smallest matching rows and
   * the global smallest `limit` are necessarily inside the union. Merge, sort, slice.
   * ceiling: over-fetch is (members − 1) × limit rows per page — bounded, and the price of not
   * tracking a cursor per shard. Revisit only if a deployment has enough shards for that to matter.
   */
  private async listMerged<T extends { id: string }>(
    q: ListQuery,
    fetch: (m: { store: StoragePort }) => Promise<Page<T>>,
  ): Promise<Page<T>> {
    if (normalizeNs(q.ns) !== null) return fetch(this.ownerOf(q.ns));
    const pages = await Promise.all(this.members.map((m) => fetch(m)));
    const merged = pages
      .flatMap((p) => p.items)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (q.limit === undefined || merged.length <= q.limit) {
      // Even when the merge fits, a member may still have more rows behind its own cursor.
      const next = pages.some((p) => p.next !== null)
        ? (merged.at(-1)?.id ?? null)
        : null;
      return { items: merged, next };
    }
    const items = merged.slice(0, q.limit);
    return { items, next: items[items.length - 1].id };
  }

  private async similarImpl(
    embedding: Float32Array,
    k: number,
  ): Promise<Entity[]> {
    const capable = this.members.filter(
      (m) => typeof m.store.similar === "function",
    );
    const groups = await Promise.all(
      // biome-ignore lint/style/noNonNullAssertion: filtered to members with similar above.
      capable.map((m) => m.store.similar!(embedding, k)),
    );
    const hits = groups.flat();
    hits.sort(
      (a, b) => cosine(embedding, b.embedding) - cosine(embedding, a.embedding),
    );
    return hits.slice(0, k);
  }

  // --- Extension surface (delegation). ns-scoped → owner shard; un-scoped → fan-out concat. ---

  async saveOntology(defs: TypeDef[], ns?: string | null): Promise<void> {
    await (this.ownerOf(ns).store as ExtStore).saveOntology?.(defs, ns);
  }

  /**
   * The effective ontology for a namespace — core's `overlayOntology`, with the two halves read from
   * two different shards: the DEFAULT shard holds the shared (null-ns) base, the owner shard holds the
   * tenant's own defs. The overlay belongs here rather than in `yoke init` for the reason core's doc
   * gives: a backend answering `loadOntology(ns)` its own way leaks through the store surface.
   *
   * When the owner IS the default shard, its own overlay already returned both halves and re-setting
   * them changes nothing.
   */
  loadOntology(ns?: string | null): TypeDef[] {
    const load = (m: ShardMember, n: string | null | undefined): TypeDef[] =>
      (m.store as ExtStore).loadOntology?.(n) ?? [];
    const shared = load(this.defaultShard, null);
    if (normalizeNs(ns) === null) return shared;
    return overlayOntology(shared, load(this.ownerOf(ns), ns));
  }

  listHistory(id: string): Entity[] {
    return this.members.flatMap(
      (m) => (m.store as ExtStore).listHistory?.(id) ?? [],
    );
  }

  /** Every member renames its own rows — a vocabulary change is not per-shard the way a backup file
   * is, and leaving one shard on the old name is exactly the split a rename exists to prevent. */
  async renameType(
    from: string,
    to: string,
    ns?: string | null,
  ): Promise<number> {
    const counts = await Promise.all(
      this.members.map(
        async (m) =>
          (await (m.store as ExtStore).renameType?.(from, to, ns)) ?? 0,
      ),
    );
    return counts.reduce((n, c) => n + c, 0);
  }

  // Audit + tokens: a single stream on the default shard.
  logAudit(event: AuditEvent): void {
    (this.defaultShard.store as ExtStore).logAudit?.(event);
  }

  listAudit(q?: AuditQuery): AuditEvent[] {
    return (this.defaultShard.store as ExtStore).listAudit?.(q) ?? [];
  }

  createToken(spec: { name: string; scopes: string[]; created_at: string }): {
    token: string;
  } {
    return (this.defaultShard.store as YokeStore).createToken(spec);
  }

  verifyToken(secret: string): { name: string; scopes: string[] } | null {
    return (this.defaultShard.store as ExtStore).verifyToken?.(secret) ?? null;
  }

  revokeToken(name: string): boolean {
    return (this.defaultShard.store as ExtStore).revokeToken?.(name) ?? false;
  }

  listTokens(): TokenInfo[] {
    return (this.defaultShard.store as ExtStore).listTokens?.() ?? [];
  }

  // Physical durability is inherently per-file — there is no meaningful composite backup.
  async backupTo(): Promise<void> {
    throw PER_SHARD("backup");
  }

  async exportUntil(): Promise<void> {
    throw PER_SHARD("export");
  }
}

/** Build a ShardedStorage from a config file: validate, instantiate every member adapter. */
export async function makeShardedStorage(
  configPath: string,
): Promise<ShardedStorage> {
  const config = loadShardConfig(configPath);
  const members: ShardMember[] = await Promise.all(
    config.shards.map(async (s) => ({
      name: s.name,
      namespaces: s.namespaces ?? [],
      isDefault: s.default === true,
      store: await makeShard(s),
    })),
  );
  return new ShardedStorage(members);
}
