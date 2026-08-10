// English is the source of truth: every other locale is typed as `typeof en`, so a missing or
// misspelled key is a compile error rather than a string that silently renders as its own key.
//
// Deliberately NOT `as const`. Const-asserting would make each value its own literal type and
// `typeof en` would then demand that ko say "loading…" too — the check would be on the values
// instead of the keys, which is the opposite of what a translation file needs.
//
// Keys are grouped by screen. Where a sentence carries an argument (why a cap is not knowledge
// loss, why a roster is not knowledge), the argument stays in the string; shortening it for
// translation convenience would delete the reason a reader trusts the screen.

export const en = {
  common: {
    loading: "loading…",
    none: "none",
    close: "Close",
    create: "Create",
    creating: "Creating…",
    saving: "Saving…",
    verify: "Verify",
    reconfirm: "Re-confirm",
    verifyHint: "promote a record or re-confirm a stale one",
    deprecate: "Deprecate",
    /** Shown after retiring a record, above the records that declared they rest on it. Says what to DO
     * with the list — a heading that only named the relationship would leave a reader looking at links. */
    downstream: (n: number) =>
      `${n} ${n === 1 ? "record rests" : "records rest"} on what you just retired — re-examine:`,
    link: "Link",
    linking: "Linking…",
    expand: "Expand",
    browse: "browse",
    graph: "graph",
    openRecord: "Open record",
    openInGraph: "Open in graph",
    openAsRecord: "Open as record",
    notInNamespace: "not in this namespace",
    notFound: "not found in this namespace",
    required: "required by the ontology",
    draftNotice: "saved as a draft and must be verified",
    copyFull: "click to copy",
    copy: "Copy",
    copied: "Copied",
    // The date-time picker. "Any time" is the unset state of a FILTER — absence of a bound, not a
    // missing value, so it must not read like an error or a placeholder to fill.
    anyTime: "Any time",
    timeOfDay: "time",
    clear: "Clear",
    type: "type",
    status: "status",
    actor: "actor",
    record: "record",
    source: "source",
    relation: "relation",
    relations: "relations",
    direction: "direction",
    attributes: "attributes",
    title: "title",
    version: "v",
    when: "when",
    action: "action",
    detail: "detail",
    otherEnd: "other end",
    prev: "Previous",
    next: "Next",
    page: (page: number, pages: number, total: number) =>
      `Page ${page} of ${pages} · ${total} total`,
  },
  nav: {
    review: "review",
    conflicts: "conflicts",
    ontology: "ontology",
    persona: "persona",
    collaboration: "collaboration",
    browse: "browse",
    inject: "inject",
    graph: "graph",
    audit: "audit",
    tokens: "tokens",
    screens: "screens",
    openMenu: "Open navigation",
    closeMenu: "Close navigation",
  },
  theme: {
    label: "theme",
    system: "system",
    light: "light",
    dark: "dark",
  },
  home: {
    eyebrow: "collaboration knowledge shared by the team",
    heading: "Keep every teammate working from the same Context",
    lede: "For every project, YOKE brings its people, decisions, facts, resources, and terms into one place so the team can share the same information.",
    cards: {
      collaboration: {
        title: "Collaborate",
        body: "Create a shared Context for each project, used by both the team and its agents. See participants, linked knowledge, and a briefing of the current state in one place.",
      },
      govern: {
        title: "Govern",
        body: "Review and verify records. Re-confirm stale records and retire those that are no longer used.",
      },
      inject: {
        title: "Inject",
        body: "Enter a query to see the knowledge and source citations an agent will receive.",
      },
      graph: {
        title: "Explore",
        body: "Move through people, facts, decisions, resources, terms, and collaborations as a graph.",
      },
      share: {
        title: "Share",
        body: "Create a token with the required permission scope, then share a login URL with teammates or test users.",
      },
    },
  },
  chrome: {
    connecting: "connecting…",
    readOnly: "read-only",
    readOnlyHint:
      "This is a read-only replica. Changes are saved to the primary",
    namespaceHint: "tenant namespace",
    signOut: "Sign out",
    signIn: "Sign in",
    ungated: "ungated",
    authedAs: (actor: string) => `authenticated as ${actor}`,
    signOutHint:
      "Clears only the credential stored in this browser. Revoke the token with `yoke token revoke`",
    ungatedHint: "Local single-user mode does not require a credential",
    summary: "summary",
  },
  create: {
    newRecord: "New record",
    draftNotice:
      "Saved as a draft and must be verified, just like a record committed by an agent.",
    pickType: "pick a type",
    noAttrs:
      "This type has no declared attributes, so the record will be created without them.",
    duplicates: (n: number, names: string) =>
      `Created, but ${n} similar record${n > 1 ? "s" : ""} already exist: ${names}`,
    // Not "no duplicates found" — nothing was compared. The distinction is the point.
    notChecked:
      "Created. Nothing was compared against it: this workspace has no embedding provider configured, so duplicate detection did not run.",
  },
  review: {
    heading: "Review queue",
    lede: "Review drafts that have not been verified. They are not injected into an agent until a person promotes them.",
    selectAll: "Select all",
    empty: "no drafts are waiting for review",
    draftCount: (n: number) => `${n} draft(s)`,
    // The two queues. Named for what a record in each needs, not for its status: a draft was never
    // trusted, a stale record was and has aged out, and the same Verify button means something
    // different in each — so the tab has to make which queue you are in unmissable.
    tabDrafts: "Never verified",
    tabStale: "Aged out",
    staleLede:
      "These were verified, then passed their type's freshness window. They stopped being injected the moment they aged out, and nobody was told — that is what this screen is for. Verify re-confirms one as still true; Deprecate retires it.",
    staleEmpty: "no verified records have aged out",
    // Bounded walk, so say what it covered. A bare count reads as a corpus-wide number.
    staleScanned: (n: number, scanned: number) =>
      `${n} aged out among the ${scanned} verified record(s) examined`,
    staleMore: "more records left to examine",
    // The consumption signal the queue is ordered by. "injected" is the audit trail's own verb —
    // inject and persona rows naming this record — not page views.
    injectedHead: "injected",
    injectedTimes: (n: number) => `${n}×`,
    // The point of the screen: a stale record's fix is a person, so name them.
    // The number needs a unit. It rendered as "노태경 7, 오태민 5, …" — a name and a naked integer,
    // which a reader has to guess at, and the heading is the one place to say it once instead of
    // repeating it thirty times.
    staleOwners:
      "Ask these people to re-confirm — the number is how many aged-out records each of them recorded:",
    staleOwnerCount: (n: number) => `${n}`,
  },
  browse: {
    heading: "Browse",
    lede: "View every record in this namespace, oldest first. Find records that are unlinked, stale, or still waiting for review.",
    allTypes: "all types",
    anyStatus: "any status",
    shown: (n: number, more: boolean) =>
      `${n} shown${more ? " (more available)" : ""}`,
    noMatch: "no records match this filter",
    search: "Search text in records",
    searchHint:
      "the same full-text search yoke itself falls back to — records with their status, never an answer",
    clear: "Clear",
    noSearchMatch: "no records match that text",
    searchTruncated: (limit: number) =>
      `showing the first ${limit} matches. Search returns a bounded set, not the whole corpus — narrow the text, or use yoke inject for what an agent would receive.`,
  },
  entity: {
    noId: "No record ID was provided. Select a record from",
    noTextAttributes: "(no text attributes)",
    provenance: "provenance",
    recordedBy: "recorded by",
    origin: "origin",
    occurredAt: "occurred at",
    lastConfirmed: "last confirmed",
    citation: "citation",
    versionHistory: "version history",
    storedStatus: "stored status",
    standsAlone: "this record has no links",
    otherRecordId: "other record id",
    swapDirection: "swap which end this record is",
    pointsAt: "points at the other record",
    isPointedAt: "is pointed at",
    copyId: "click to copy",
  },
  collaboration: {
    heading: "Collaborations",
    headingOne: "Collaboration",
    lede: "View the people and knowledge linked to one collaboration. Set its scope to make agents prioritize this collaboration's context.",
    newOne: "New collaboration",
    all: "all collaborations",
    emptyList:
      "No collaborations yet. Create one above or ask an agent to create one with yoke_use_scope",
    people: "people in this collaboration",
    peopleNote:
      "The participant list is not knowledge about the collaboration, so it is not included in the briefing",
    noMembers: "No participants yet. Select someone above or run",
    person: "person",
    addSomeone: "add someone…",
    addToWork: "Add to this work",
    everyoneAdded: "everyone recorded is already on this",
    readJudgment: "read their recorded judgment",
    briefing: "the briefing an agent receives",
    briefingNote:
      "Shows the verified records returned by inject(scope), most recently confirmed first. This preview is recorded in the audit log",
    briefingEmpty: "no knowledge is linked to this collaboration",
    attached: "linked records",
    attachedNote:
      "The record points to this collaboration. Deprecating the collaboration does not change its linked records",
    attachedEmpty:
      "No linked records. Records captured with --scope will appear here",
    truncated: (shown: number, total: number, rest: number) =>
      `Showing ${shown} of ${total} records in this collaboration, most recently confirmed first. Records not shown are still available. A specific question searches all knowledge while prioritizing this collaboration's records. (${rest} not shown)`,
  },
  conflicts: {
    heading: "Conflicts",
    lede: "Review verified records that contradict each other. yoke keeps both and does not decide which one is correct. Deprecate one record, or keep both when the disagreement itself matters.",
    empty: "no contradictions recorded",
    alreadyRetired: "Already retired",
  },
  ontology: {
    heading: "Ontology",
    lede: "View the entity and relation types used in this namespace. A * marks a required attribute. The TTL sets how long a verified record stays fresh before it is excluded from injection. Schema records are not knowledge, so they have no citations.",
    entityTypes: "entity types",
    relationTypes: "relation types",
    freshness: "freshness (ttl)",
    neverStale: "never goes stale",
    days: (n: number) => `${n} days`,
    declare: "Declare a type",
    declareNote:
      "Saving an existing name adds a new version. This uses the same append-only process as yoke ontology add-type.",
    name: "name",
    kind: "kind",
    entity: "entity",
    relation: "relation",
    attrsHint: "— comma separated, * = required",
    ttlHint: "— days, blank = never goes stale",
    saveType: "Save type",
    maintenance: "maintenance",
    maintenanceNote: "Repairs apply to the entire namespace",
    backfill: "Backfill authorship",
    backfillHint:
      "Recreate authored_by edges for records committed before the system created them automatically",
    backfillDone: (scanned: number, created: number) =>
      `scanned ${scanned} records, added ${created} authorship edges`,
    renameFrom: "rename from",
    attrsExample: "title*, owner",
    renamePlaceholder: "rename a type…",
    newName: "new name",
    rename: "Rename",
    renameHint:
      "Changes the type name in its declaration, stored rows, and history",
    renameDone: (from: string, to: string, rows: number) =>
      `renamed ${from} to ${to} — ${rows} rows rewritten`,
  },
  persona: {
    heading: "Persona",
    lede: "View the verified knowledge authored by one person. When an agent asks how that person would decide, it receives their records and sources. It does not generate text in their voice.",
    headingOne: "Persona",
    all: "All personas",
    emptyList:
      "No one has recorded any knowledge yet. A persona becomes available after someone commits a record",
    search: "Search their records",
    noMatch: "none of this person's records match the search",
    matched: (shown: number, total: number) => `${shown} of ${total} match`,
    exportHint: (id: string) => `yoke persona ${id} --out ./skills`,
    decisions: "guiding decisions",
    noDecisions: "this person has not recorded any decisions",
    otherKnowledge: "other knowledge",
  },
  inject: {
    heading: "Injection preview",
    ledeBefore: "See what an agent will receive for this query. A real ",
    ledeAfter:
      " call uses the same filters, order, and citations. Stale and deprecated records are always excluded.",
    queryPlaceholder: "what is the agent working on?",
    scopePlaceholder: "scope (collaboration or person id, optional)",
    run: "Preview",
    includeDraft: "include drafts",
    prompt: "Enter a query. To view a context briefing, enter only its scope",
    draftsIncluded:
      "Drafts are shown so you can see what is waiting for review. They are not sent to an agent.",
    wouldBeInjected: "would be injected",
    scopeNote: (id: string) => `scope: ${id} (prioritized, not isolated)`,
    truncated: (shown: number, total: number) =>
      `Showing ${shown} of ${total}. An agent receives the same results and a note to ask a more specific question for the rest. Raise the limit to preview more.`,
    empty:
      "No verified knowledge matches this query, so nothing will be sent to the agent",
    // As-of. Labelled as a question about the past rather than as a filter, because that is what it
    // answers, and banner-flagged whenever it is on: a historical result that looked like a current
    // one would be worse than not offering this at all.
    asOf: "As of",
    asOfHint:
      "Answer as if it were this moment: each record is rewound to the version current then, and freshness is judged against that date",
    asOfClear: "Now",
    asOfActive: (when: string) =>
      `Historical view: this is what the query would have injected on ${when}, not what it injects now.`,
    asOfCeiling:
      "Candidates still come from today's search index, so a record whose text was rewritten since may be missing. What changed in the past is mostly status, which this does account for.",
  },
  graph: {
    heading: "Graph",
    ledeAnchored:
      "View connections up to two steps from the selected record. Click a node to center it and expand its neighbors.",
    lede: "View every record and relation in this namespace. Click a node to center it and expand its neighbors.",
    wholeNamespace: "Whole namespace",
    counts: (nodes: number, links: number) =>
      `${nodes} nodes · ${links} relations`,
    legend:
      "Arrows point to an edge's target · dashed lines are non-knowledge relations (authorship, membership)",
    empty: "no records to display in this namespace",
    nodes: "nodes",
    nodesNote: "Navigate the same data with a keyboard or screen reader",
    expanded: (nodes: number, links: number) =>
      `+${nodes} records, +${links} relations`,
    expandedNothing: "already drawn — nothing new one step from this record",
  },
  audit: {
    heading: "Audit",
    lede: "Track knowledge reads and governance actions in an append-only log. Filters apply only to the records currently loaded. To view the full history, use ",
    ledeAfter: ".",
    since: "since",
    sinceHint: "your local time",
    allActions: "all actions",
    allActors: "all actors",
    shown: (shown: number, loaded: number) => `${shown} of ${loaded} loaded`,
    empty: "no audit events in this window",
    nothing: "nothing",
    more: (n: number) => `${n} more`,
    meaning: {
      inject: "an agent received knowledge",
      inject_preview: "a human previewed what an agent would receive",
      persona: "a person's recorded judgment was read",
      verify: "records were promoted",
      deprecate: "records were retired",
      rename_type: "an ontology type was renamed in every stored row",
      read: "a record was opened in full — attributes, versions, relations",
      search: "someone queried for text and received matching records",
    } as Record<string, string>,
  },
  tokens: {
    heading: "Tokens",
    lede: "Manage API tokens for browser sharing and remote access. A secret is shown only when its token is created. Revoke the token by name to end access.",
    create: "Create token",
    name: "name",
    namePlaceholder: "friend-readonly",
    scopes: "scopes",
    scopesHint: "comma separated",
    created: "Token created",
    createdNote: "Save it now. yoke stores only the hash.",
    secret: "secret",
    shareUrl: "share URL",
    empty: "no tokens",
    revoke: "Revoke",
  },
  login: {
    heading: "Sign in",
    lede: "Enter an issued API token or OIDC id_token. yoke does not store passwords.",
    token: "token",
    credential: "credential",
    checking: "Checking…",
    submit: "Sign in",
    rejected: "credential rejected",
    noTokenBefore:
      "If you do not have a token, run this command on the yoke server:",
    noTokenAfter:
      "This scope allows draft promotion. verify is a governance permission that must be granted separately.",
    addPrefix: "For promoting drafts:",
  },
  errors: {
    forbiddenHint:
      "This credential lacks the scope required for this action. Issue one with: yoke token create --scopes read,verify",
  },
};
