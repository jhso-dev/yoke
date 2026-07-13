// storage-sharded (PLAN-V2 12.1) — ShardedStorage composes member StoragePorts behind ONE port.
// Core is untouched: sharding lives entirely behind the storage port (the ARCHITECTURE bet paying off).
//
// Routing:
//   - writes (putEntity/putRelation) route by the row's ns → its owner shard (default shard for
//     unlisted/null ns).
//   - point reads (getEntity, neighbors) fan out to every shard (ids are globally unique ULIDs):
//     getEntity returns the first non-null; neighbors concat-merges.
//   - search: ns-scoped → owner shard only; un-scoped → fan out, concat, apply q.limit post-merge.
//     Each member self-filters by ns (see the adapters), so isolation holds per shard.
//   - similar: fan out to members that have the capability, concat, re-rank the merged hits by cosine
//     to the query embedding, slice k. Exposed ONLY if at least one member implements it.
//
// The extension surface (listByStatus/listByActor/listHistory/listRelationsByType/ontology/audit/
// tokens) is the sqlite-shaped surface used by CLI/UI/serve. ns-scoped calls go to the owner shard;
// un-scoped listing calls fan out (feature-detected via typeof — kuzu/qdrant members simply skip).
// Audit + tokens live on the default shard (a single audit/token stream).
// ponytail: the extension surface assumes the default shard (and any ns owner it targets) is a
// sqlite backend. A kuzu/qdrant member participates in the core port but not in the sqlite-only
// extensions (it has no listByStatus/tokens, and its ontology methods are async). Give a tenant on a
// non-sqlite backend its own serve process if it needs review/audit/token features.
//
// Duplicate/contradiction detection stays intra-shard automatically: commit() calls this.similar,
// which here fans out across ALL capable shards — so a duplicate WARNING can cross shard boundaries
// (surfaced in CommitResult.duplicates, never auto-merged). The conflicts_with relation the gate may
// create carries the new entity's ns, so it lands in that entity's shard and neighbors() fan-out
// still resolves the foreign id. ns-isolation-sensitive deployments (where even seeing a peer
// tenant's near-duplicate is a leak) should give each tenant its own serve process.
// ponytail: cross-shard similar fan-out is the known ceiling. Upgrade path is an ns-aware
// `similar(embedding, k, ns?)` on the port — a supervisor-approved StoragePort contract change we do
// NOT make here (ports/storage.ts is off-limits for this task).

import { normalizeNs } from "../../core/namespace.js";
import type { TypeDef } from "../../core/ontology.js";
import type { Entity, Relation } from "../../core/types.js";
import type { StoragePort, TextQuery } from "../../ports/storage.js";
import type { AuditEvent, TokenInfo } from "../storage-sqlite/index.js";
import { loadShardConfig, makeShard } from "./config.js";

export type { AuditEvent, TokenInfo };

/** The full storage surface CLI/UI/serve rely on: the port plus the sqlite-shaped extension methods.
 *  SqliteStorage satisfies it structurally; ShardedStorage implements it by delegation. */
export interface YokeStore extends StoragePort {
  saveOntology(defs: TypeDef[], ns?: string | null): void;
  loadOntology(ns?: string | null): TypeDef[];
  listByStatus(status: string, ns?: string | null): Entity[];
  listByActor(actor: string, ns?: string | null): Entity[];
  listRelationsByType(type: string): Relation[];
  listHistory(id: string): Entity[];
  logAudit(event: AuditEvent): void;
  listAudit(since?: string): AuditEvent[];
  createToken(spec: { name: string; scopes: string[]; created_at: string }): {
    token: string;
  };
  verifyToken(secret: string): { name: string; scopes: string[] } | null;
  revokeToken(name: string): boolean;
  listTokens(): TokenInfo[];
  backupTo(dest: string): Promise<void>;
  exportUntil(ts: string, destPath: string): Promise<void>;
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

  constructor(private readonly members: ShardMember[]) {
    const def = members.find((m) => m.isDefault);
    if (!def)
      throw new Error("sharded storage needs exactly one default shard");
    this.defaultShard = def;
    if (members.some((m) => typeof m.store.similar === "function")) {
      this.similar = (embedding, k) => this.similarImpl(embedding, k);
    }
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

  async putRelation(r: Relation): Promise<void> {
    await this.ownerOf(r.ns).store.putRelation(r);
  }

  async getEntity(id: string, version?: number): Promise<Entity | null> {
    const results = await Promise.all(
      this.members.map((m) => m.store.getEntity(id, version)),
    );
    return results.find((e) => e !== null) ?? null;
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
    const merged = groups.flat();
    return q.limit === undefined ? merged : merged.slice(0, q.limit);
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

  saveOntology(defs: TypeDef[], ns?: string | null): void {
    (this.ownerOf(ns).store as ExtStore).saveOntology?.(defs, ns);
  }

  loadOntology(ns?: string | null): TypeDef[] {
    const target =
      normalizeNs(ns) !== null ? this.ownerOf(ns) : this.defaultShard;
    return (target.store as ExtStore).loadOntology?.(ns) ?? [];
  }

  listByStatus(status: string, ns?: string | null): Entity[] {
    if (normalizeNs(ns) !== null)
      return (
        (this.ownerOf(ns).store as ExtStore).listByStatus?.(status, ns) ?? []
      );
    return this.members.flatMap(
      (m) => (m.store as ExtStore).listByStatus?.(status, ns) ?? [],
    );
  }

  listByActor(actor: string, ns?: string | null): Entity[] {
    if (normalizeNs(ns) !== null)
      return (
        (this.ownerOf(ns).store as ExtStore).listByActor?.(actor, ns) ?? []
      );
    return this.members.flatMap(
      (m) => (m.store as ExtStore).listByActor?.(actor, ns) ?? [],
    );
  }

  listRelationsByType(type: string): Relation[] {
    return this.members.flatMap(
      (m) => (m.store as ExtStore).listRelationsByType?.(type) ?? [],
    );
  }

  listHistory(id: string): Entity[] {
    return this.members.flatMap(
      (m) => (m.store as ExtStore).listHistory?.(id) ?? [],
    );
  }

  // Audit + tokens: a single stream on the default shard.
  logAudit(event: AuditEvent): void {
    (this.defaultShard.store as ExtStore).logAudit?.(event);
  }

  listAudit(since?: string): AuditEvent[] {
    return (this.defaultShard.store as ExtStore).listAudit?.(since) ?? [];
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
