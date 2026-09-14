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

/** One ledger row as the trail stores and returns it. 'who saw what when' (ENTERPRISE.md).
 *
 * The delivered ids are NOT here: they are counted into the delivery ledger by the same write and
 * read back through `consumption`/`delivered`/`lastHanded`, so a row is never re-parsed for them. */
export interface AuditRow {
  actor: string;
  action: string;
  detail: string;
  at: string;
  /** Tenant namespace the read/action happened in. Omitted = the default shared namespace.
   * Without it an audit viewer would show every tenant's queries to every tenant. */
  ns?: string | null;
}

/** What may be appended. A union, and `action` is the discriminant, because the ids are not optional
 * decoration on a delivery — they ARE the delivery. A route that writes `inject` without them stops
 * the ledger counting for that route and nothing fails, so the type refuses the shape instead. */
export type AuditEvent =
  | (AuditRow & {
      /** A DELIVERY: an agent was handed these records. */
      action: "inject" | "persona";
      /** The records this event handed to an AGENT, as data.
       *
       * `detail` renders the same ids for a person to read; this is what the ledger counts, and the
       * two are written from one call so they cannot disagree. */
      ids: string[];
      /** The working context the delivery was anchored on, when it was. */
      anchor?: string;
      /** Set when the delivery answered as of a past instant. It still counts as consumption — an
       * agent did receive these records — but it says nothing about whether the reader holds the
       * CURRENT version, so it must not advance the reader's delivery clock. */
      asOf?: string;
    })
  | (AuditRow & {
      /** A person governing, or a mutation that has to be accountable. Not a delivery: it may carry
       * no ids, because what agents are being fed is a different question from what people click. */
      action:
        | "inject_preview"
        | "read"
        | "search"
        | "overview"
        | "verify"
        | "deprecate"
        | "rename_type";
      ids?: never;
      anchor?: never;
      asOf?: never;
    });

/** Read filter. Most-recent-N window: `limit` takes the newest rows, returned oldest-first.
 * `since`/`until` are both inclusive — a person picking an end day means through that instant. */
export interface AuditQuery {
  since?: string;
  until?: string;
  ns?: string | null;
  limit?: number;
}

/** One working context, for one reader: the instant of its most recent delivery (the `since` bound
 * of an unseen read), and every record it has handed over — the set whose changes it is told about. */
export interface Delivered {
  last?: string;
  ids: Set<string>;
}

export interface AuditPort {
  init(): Promise<void>;
  /** Append one event, and — when it is a delivery — record the delivery it describes. One write:
   * a ledger where the trail and what it implies could disagree is not a ledger.
   *
   * Callers treat a rejection as best-effort on reads and fatal on writes: a mutation nobody can
   * account for is worse than a failed mutation (see `bestEffortAudit`). */
  logAudit(event: AuditEvent): Promise<void>;
  /** Rows oldest-first, filtered by ns and the optional bounds. */
  listAudit(q?: AuditQuery): Promise<AuditRow[]>;

  /** id → how many times an agent has been handed that record. Over the WHOLE history, not a window:
   * this is the governance signal the stale queue orders by, and a count that silently stops at some
   * row number is a different number wearing the same name. */
  consumption(q: {
    ns?: string | null;
    ids: string[];
  }): Promise<Map<string, number>>;

  /** One working context's own delivery clock and held set — bounded by that context, not by the
   * trail. As-of deliveries are absent from both: they handed a version that is not current. */
  delivered(q: {
    ns?: string | null;
    actor: string;
    anchor: string;
  }): Promise<Delivered>;

  /** id → the instant this reader was last handed that record, over every working context. A version
   * committed at or before it is one the reader already has.
   *
   * Point lookups: only the ids asked for come back, and an id never delivered is absent rather than
   * present with an empty clock. As-of deliveries never appear — they handed an old version and say
   * nothing about the current one. */
  lastHanded(q: {
    ns?: string | null;
    actor: string;
    ids: string[];
  }): Promise<Map<string, string>>;

  close(): void;
}
