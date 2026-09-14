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
}

/** Read filter. Most-recent-N window: `limit` takes the newest rows, returned oldest-first.
 * `since`/`until` are both inclusive — a person picking an end day means through that instant. */
export interface AuditQuery {
  since?: string;
  until?: string;
  ns?: string | null;
  limit?: number;
}

export interface AuditPort {
  init(): Promise<void>;
  /** Append one event. Callers treat a rejection as best-effort on reads and fatal on writes — a
   * mutation nobody can account for is worse than a failed mutation (see `bestEffortAudit`). */
  logAudit(event: AuditEvent): Promise<void>;
  /** Events oldest-first, filtered by ns and the optional bounds. */
  listAudit(q?: AuditQuery): Promise<AuditEvent[]>;
  close(): void;
}
