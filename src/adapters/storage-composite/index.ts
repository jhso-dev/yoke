// storage-composite (v5.2) — knowledge in a remote backend, yoke's own bookkeeping in a local sqlite.
//
// This exists because of one fact about the interface above the port: `openStore` returns a
// `YokeStore`, and several of that interface's extension methods are synchronous — they were shaped
// by better-sqlite3, which is. A network-backed store cannot implement a synchronous signature. That,
// not a missing adapter, is the bar an adapter clears to be reachable from the CLI at all: a backend
// whose `loadOntology` has to be async does not satisfy `YokeStore`, so the synchronous read surface
// is what remains load-bearing.
//
// So a remote backend is COMPOSED rather than substituted, and the split is a decision rather than a
// workaround (SPEC "Remote backends"):
//
//   remote  entities, relations, search, neighbors, vectors, and the ontology
//   local   the audit trail (what THIS client was told) and API tokens (yoke's own credentials, which
//           do not belong in someone else's database)
//
// `loadOntology` stays synchronous by being served from a cache the async `init()` fills. It has to be
// remote — a shared graph with per-client schemas means two people validating against different
// schemas — and it has to be sync because 28 call sites read it inside synchronous code.
//
// ceiling: that cache is read once per init(). The CLI opens/inits/closes per command so every
// invocation is fresh; a long-running `yoke ui`/`serve` will not see an ontology another client
// changed. Add invalidation when it bites, not before.
//
// Delegation-as-composition is not new here: ShardedStorage already implements YokeStore by forwarding
// to member stores. This is the same shape with a different split.

import type { TypeDef } from "../../core/ontology.js";
import type { Entity, Relation } from "../../core/types.js";
import type {
  ListQuery,
  Page,
  StoragePort,
  TextQuery,
} from "../../ports/storage.js";
import type { YokeStore } from "../storage-sharded/index.js";
import type {
  AuditEvent,
  AuditQuery,
  SqliteStorage,
  TokenInfo,
} from "../storage-sqlite/index.js";

/** The remote half: a StoragePort plus async ontology methods. Structural, so any future remote
 * adapter (postgres was always the other candidate) satisfies it without importing this file. */
export interface RemoteStore extends StoragePort {
  saveOntology(defs: TypeDef[], ns?: string | null): Promise<void>;
  loadOntology(ns?: string | null): Promise<TypeDef[]>;
  renameType(from: string, to: string, ns?: string | null): Promise<number>;
}

/** Ontology cache key. The default namespace and a tenant namespace are different ontologies, and
 * `null` is not a usable Map key alongside strings. */
const nsKey = (ns?: string | null) => ns ?? "";

// `implements YokeStore` and not merely `StoragePort`: every extension this class claims is then
// checked against the interface, and the one it cannot provide (`listHistory` — synchronous, about
// remote rows) is optional there, so omitting it is a fact the type carries rather than a cast.
class CompositeStorage implements YokeStore {
  /** Present only when the remote backend has the capability, so `typeof store.similar === "function"`
   * still reflects reality — commit() and the conformance suite both branch on it. */
  similar?: (embedding: Float32Array, k: number) => Promise<Entity[]>;
  putEmbedding?: (e: Entity, opts?: { rebuild?: boolean }) => Promise<void>;
  /** Batch point read (v5.5). Forwarded conditionally like the two above, so `readEntities` sees the
   * REMOTE backend's capability rather than the composite's — a composite that always declared it
   * would turn one round trip per id into one round trip per id plus a wrapper. */
  getEntities?: (ids: string[]) => Promise<Entity[]>;

  /** Filled by init(), read synchronously by loadOntology. */
  private ontology = new Map<string, TypeDef[]>();

  constructor(
    private readonly remote: RemoteStore,
    /** Local sqlite for audit + tokens. Concrete rather than an interface: this half is the
     * sqlite-shaped extension surface, and pretending otherwise would invite someone to make it
     * pluggable when there is nothing to plug in. */
    private readonly local: SqliteStorage,
  ) {
    if (typeof remote.similar === "function") {
      // Bound through a non-optional local so the return type stays Promise<Entity[]>; the guard
      // above is what makes the assertion true.
      const impl = remote.similar.bind(remote);
      this.similar = (embedding, k) => impl(embedding, k);
    }
    if (typeof remote.putEmbedding === "function") {
      const impl = remote.putEmbedding.bind(remote);
      this.putEmbedding = (e, opts) => impl(e, opts);
    }
    if (typeof remote.getEntities === "function") {
      const impl = remote.getEntities.bind(remote);
      this.getEntities = (ids) => impl(ids);
    }
    // Conditional like the three above, and for the sharper reason: declaring the capability while the
    // remote lacks it would answer "not found" for an edge that exists.
    if (typeof remote.getRelation === "function") {
      const impl = remote.getRelation.bind(remote);
      this.getRelation = (id, version) => impl(id, version);
    }
  }

  getRelation?: StoragePort["getRelation"];

  async init(): Promise<void> {
    await Promise.all([this.remote.init(), this.local.init()]);
    await this.refreshOntology();
  }

  /** Re-read every namespace's ontology we know about, plus the default one. Called at init() and
   * after a write, so the synchronous reader never serves something this process has changed. */
  private async refreshOntology(): Promise<void> {
    const keys = new Set<string>([...this.ontology.keys(), ""]);
    for (const k of keys) {
      this.ontology.set(k, await this.remote.loadOntology(k === "" ? null : k));
    }
  }

  close(): void {
    this.remote.close();
    this.local.close();
  }

  // --- knowledge: straight through to the remote backend ------------------------------------------

  putEntity(e: Entity): Promise<void> {
    return this.remote.putEntity(e);
  }
  getEntity(id: string, version?: number): Promise<Entity | null> {
    return this.remote.getEntity(id, version);
  }
  putRelation(r: Relation): Promise<void> {
    return this.remote.putRelation(r);
  }
  neighbors(
    id: string,
    relType?: string,
    dir?: "in" | "out",
  ): Promise<Relation[]> {
    return this.remote.neighbors(id, relType, dir);
  }
  search(q: TextQuery): Promise<Entity[]> {
    return this.remote.search(q);
  }
  /** Remote, like the knowledge it describes: the index key belongs to the database holding the rows
   * it keys, not to this client's local audit file. */
  getMeta(key: string): Promise<string | null> {
    return this.remote.getMeta(key);
  }
  setMeta(key: string, value: string): Promise<void> {
    return this.remote.setMeta(key, value);
  }
  listEntities(q: ListQuery): Promise<Page<Entity>> {
    return this.remote.listEntities(q);
  }
  listRelations(q: ListQuery): Promise<Page<Relation>> {
    return this.remote.listRelations(q);
  }

  // --- ontology: remote, with a synchronous reader over a cache -----------------------------------

  async saveOntology(defs: TypeDef[], ns?: string | null): Promise<void> {
    await this.remote.saveOntology(defs, ns);
    // Ensure the key exists so refresh picks it up even for a namespace seen for the first time.
    if (!this.ontology.has(nsKey(ns))) this.ontology.set(nsKey(ns), []);
    await this.refreshOntology();
  }

  loadOntology(ns?: string | null): TypeDef[] {
    return this.ontology.get(nsKey(ns)) ?? [];
  }

  async renameType(
    from: string,
    to: string,
    ns?: string | null,
  ): Promise<number> {
    const n = await this.remote.renameType(from, to, ns);
    // A rename changes the declaration too, so the cache is stale until this runs.
    await this.refreshOntology();
    return n;
  }

  // --- audit + tokens: the local sqlite -----------------------------------------------------------

  logAudit(event: AuditEvent): void {
    this.local.logAudit(event);
  }
  listAudit(q?: AuditQuery): AuditEvent[] {
    return this.local.listAudit(q);
  }
  createToken(spec: { name: string; scopes: string[]; created_at: string }): {
    token: string;
  } {
    return this.local.createToken(spec);
  }
  verifyToken(secret: string): { name: string; scopes: string[] } | null {
    return this.local.verifyToken(secret);
  }
  revokeToken(name: string): boolean {
    return this.local.revokeToken(name);
  }
  listTokens(): TokenInfo[] {
    return this.local.listTokens();
  }

  // --- deliberately absent / refused --------------------------------------------------------------

  /**
   * NOT implemented, and that is the contract.
   *
   * `listHistory` is synchronous and it is about entities, which are remote. Callers use
   * `listVersions(port, id)` (core/lifecycle.ts), which feature-detects this extension and otherwise
   * walks `getEntity(id, version)` — a port method, therefore async. Declaring it here and throwing
   * would be worse: `listVersions` probes for the property, so a present-but-throwing method would
   * break the fallback it is supposed to trigger.
   */
  // listHistory: intentionally not declared.

  /** A file copy of a database this process does not own. The remote backend's own snapshot tooling
   * does this, and pretending otherwise would produce a backup missing the knowledge. */
  async backupTo(_dest: string): Promise<void> {
    throw new Error(
      "backup is not available on a remote backend: the knowledge lives in the remote database, " +
        "so use that database's own snapshot tooling. The local sqlite holds only this client's " +
        "audit trail and tokens.",
    );
  }

  /** Same reason as backupTo — an export that silently covered only the local half would be worse
   * than an error, because it would look like a complete one. */
  async exportUntil(_ts: string, _destPath: string): Promise<void> {
    throw new Error(
      "export is not available on a remote backend: the knowledge lives in the remote database. " +
        "Use its own tooling, or run the export against a local sqlite deployment.",
    );
  }
}

/** `listHistory` is optional on `YokeStore` precisely so this composite can omit it, which is why
 * there is no cast here: the gap is in the type, where a reader meets it. */
export function makeCompositeStore(
  remote: RemoteStore,
  local: SqliteStorage,
): YokeStore {
  return new CompositeStorage(remote, local);
}
