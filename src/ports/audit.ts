// The audit ledger's port. Separate from StoragePort because it is a different shape of data with a
// different access pattern: append-only, read as "the most recent N", never joined against knowledge.
//
// It also has its own ADDRESS. `YOKE_AUDIT_URL` names where the trail goes; unset, it goes to the
// knowledge store. The rule is the same wherever yoke runs — there is no "local writes here, a server
// writes there", because a trail that follows the process rather than the corpus answers a different
// question on every machine that reads it.
//
// Asynchronous, and that is the whole reason this is a port at all: the knowledge store's extension
// methods were shaped by better-sqlite3 and are synchronous, which no network-backed ledger can
// implement. Every method here returns a promise so a backend is free to be one.

/** One ledger row. 'who saw what when' (ENTERPRISE.md) — inject/persona reads at the front tier. */
export interface AuditEvent {
  actor: string;
  action: string;
  detail: string;
  at: string;
  /** Tenant namespace the read/action happened in. Omitted = the default shared namespace.
   * Without it an audit viewer would show every tenant's queries to every tenant. */
  ns?: string | null;
  /** The records this event handed to an AGENT, as data.
   *
   * `detail` renders the same ids for a person to read; this is what the ledger counts, and the two
   * are written from one call so they cannot disagree. Present on a delivery (`inject`, `persona`)
   * and absent on everything else — `inject_preview`, `read` and `search` record a human governing,
   * which is a different question from what agents are being fed. */
  ids?: string[];
  /** The working context the delivery was anchored on, when it was. */
  anchor?: string;
  /** Set when the delivery answered as of a past instant. It still counts as consumption — an agent
   * did receive these records — but it says nothing about whether the reader holds the CURRENT
   * version, so it must not advance the reader's delivery clock. */
  asOf?: string;
}

/** Read filter. Most-recent-N window: `limit` takes the newest rows, returned oldest-first.
 * `since`/`until` are both inclusive — a person picking an end day means through that instant. */
export interface AuditQuery {
  since?: string;
  until?: string;
  ns?: string | null;
  limit?: number;
}

/** What one reader already holds — the two facts `inject --unseen` is built on. */
export interface Delivered {
  /** id → the instant this reader was last handed the record, over every working context. A version
   * committed at or before it is one the reader already has. As-of deliveries are absent: they
   * handed an old version and say nothing about the current one. */
  lastHanded: Map<string, string>;
  /** One working context: the instant of its most recent delivery (the `since` bound of an unseen
   * read), and every record it has handed over — the set whose changes it is told about. */
  anchored: { last?: string; ids: Set<string> };
}

export interface AuditPort {
  init(): Promise<void>;
  /** Append one event, and — when it carries `ids` — record the delivery it describes. One write:
   * a ledger where the trail and what it implies could disagree is not a ledger.
   *
   * Callers treat a rejection as best-effort on reads and fatal on writes: a mutation nobody can
   * account for is worse than a failed mutation (see `bestEffortAudit`). */
  logAudit(event: AuditEvent): Promise<void>;
  /** Events oldest-first, filtered by ns and the optional bounds. */
  listAudit(q?: AuditQuery): Promise<AuditEvent[]>;

  /** id → how many times an agent has been handed that record. Over the WHOLE history, not a window:
   * this is the governance signal the stale queue orders by, and a count that silently stops at some
   * row number is a different number wearing the same name. */
  consumption(q: {
    ns?: string | null;
    ids: string[];
  }): Promise<Map<string, number>>;

  /** What `actor` already holds, and `anchor`'s own delivery clock.
   *
   * ceiling: `lastHanded` is every record ever delivered to this reader in this namespace — the size
   * of what they hold, which is the question being asked, not the size of the trail. If a reader's
   * held set ever grows past what one read should carry, narrow this to the ids a caller is about to
   * judge; do not put a row limit back on it. */
  delivered(q: {
    ns?: string | null;
    actor: string;
    anchor: string;
  }): Promise<Delivered>;

  close(): void;
}
