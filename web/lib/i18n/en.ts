// English is the source of truth: every other locale is typed as `typeof en`, so a missing or
// misspelled key is a compile error rather than a string that silently renders as its own key.
//
// Deliberately NOT `as const`. Const-asserting would make each value its own literal type and
// `typeof en` would then demand that ko say "loading…" too — the check would be on the values
// instead of the keys, which is the opposite of what a translation file needs.
//
// Keys are grouped by screen, and the values are the sentences the screens already shipped — this
// file is an extraction, not a rewrite. Where a sentence carries an argument (why a cap is not
// knowledge loss, why a roster is not knowledge) the argument is the string; shortening it for
// translation convenience would delete the reason a reader trusts the screen.

export const en = {
  common: {
    loading: "loading…",
    none: "none",
    close: "close",
    cancel: "cancel",
    create: "create",
    creating: "creating…",
    save: "save",
    saving: "saving…",
    verify: "verify",
    reconfirm: "re-confirm",
    verifyHint: "promote, or re-confirm a stale record",
    deprecate: "deprecate",
    link: "link",
    linking: "linking…",
    expand: "expand",
    browse: "browse",
    graph: "graph",
    openRecord: "open record",
    openInGraph: "open in graph",
    openAsRecord: "open as record",
    notInNamespace: "not in this namespace",
    notFound: "not found in this namespace",
    required: "required by the ontology",
    draftNotice: "enters as a draft and needs a verify",
    copyFull: "click to copy",
    type: "type",
    status: "status",
    actor: "actor",
    record: "record",
    records: "records",
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
    screens: "screens",
  },
  chrome: {
    connecting: "connecting…",
    readOnly: "read-only",
    readOnlyHint: "read replica: writes go to the primary",
    namespaceHint: "tenant namespace",
    signOut: "sign out",
    signIn: "sign in",
    ungated: "ungated",
    authedAs: (actor: string) => `authenticated as ${actor}`,
    signOutHint:
      "clears this browser's credential; revoke the token itself with `yoke token revoke`",
    ungatedHint: "local single-user mode — no credential required",
    select: "select",
    summary: "summary",
  },
  create: {
    pickType: "pick a type",
    noAttrs: "This type declares no attributes — it will be created with none.",
    duplicates: (n: number, names: string) =>
      `Created, but ${n} similar record${n > 1 ? "s" : ""} already exist: ${names}`,
  },
  review: {
    heading: "Review queue",
    lede: "Everything staged and not yet believed. Nothing here reaches an agent: drafts are withheld from injection until a human promotes them.",
    selectAll: "select all",
    empty: "no drafts — the queue is clear",
    draftCount: (n: number) => `${n} draft(s)`,
  },
  browse: {
    heading: "Browse",
    lede: "Every record in this namespace, newest last. Use it to see the shape of what you have — orphans, stale corners, drafts nobody reviewed.",
    newRecord: "new record",
    allTypes: "all types",
    anyStatus: "any status",
    shown: (n: number, more: boolean) =>
      `${n} shown${more ? " (more available)" : ""}`,
    noMatch: "nothing matches that filter",
    prev: "← previous",
    next: "next →",
  },
  entity: {
    noId: "no id — reach this screen from",
    noTextAttributes: "(no text attributes)",
    provenance: "provenance",
    recordedBy: "recorded by",
    origin: "origin",
    occurredAt: "occurred at",
    lastConfirmed: "last confirmed",
    citation: "citation",
    versionHistory: "version history",
    storedStatus: "stored status",
    standsAlone: "none — this record stands alone",
    otherRecordId: "other record id",
    swapDirection: "swap which end this record is",
    pointsAt: "points at the other record",
    isPointedAt: "is pointed at",
    copyId: "click to copy",
  },
  collaboration: {
    heading: "Collaborations",
    headingOne: "Collaboration",
    lede: "One thing being worked on together, and the people and knowledge attached to it. Anchoring an injection here is what makes an agent answer from this work's context first.",
    newOne: "new collaboration",
    all: "all collaborations",
    emptyList:
      "none yet — create one above, or let an agent do it via yoke_use_scope",
    people: "people on this work",
    peopleNote:
      "shown here and deliberately NOT in the briefing — a roster is not knowledge about the work",
    noMembers: "nobody linked yet — pick someone above, or run",
    person: "person",
    addSomeone: "add someone…",
    addToWork: "add to this work",
    everyoneAdded: "everyone recorded is already on this",
    readJudgment: "read their recorded judgment",
    briefing: "the briefing an agent receives",
    briefingNote:
      "exactly what inject(scope) returns — verified only, freshest first, audited as a preview",
    briefingEmpty: "nothing in this work's context yet",
    attached: "attached records",
    attachedNote:
      "← points here: the record carries the link, this work does not contain it. Deprecating this work leaves every one of them untouched",
    attachedEmpty:
      "none — knowledge attaches here when it is captured with --scope",
    truncated: (shown: number, total: number, rest: number) =>
      `showing ${shown} of ${total} records on this work, most recently confirmed first. The rest are not lost — an agent reaches them by asking a specific question, which searches everything with this work's records first. (${rest} not shown)`,
  },
  conflicts: {
    heading: "Conflicts",
    lede: "Verified records that contradict each other. yoke keeps both and never picks a winner — deprecate one side, or leave them coexisting, which is a real answer when the disagreement is the knowledge.",
    empty: "no contradictions recorded",
    alreadyRetired: "already retired",
    deprecateSide: "deprecate this side",
  },
  ontology: {
    heading: "Ontology",
    lede: "The entity and relation types this namespace recognises. A * marks a required attribute; the TTL is how long a verified record of that type stays fresh before it is withheld again. These are schema records, not knowledge, so they carry no citation.",
    entityTypes: "entity types",
    relationTypes: "relation types",
    freshness: "freshness (ttl)",
    neverStale: "never goes stale",
    days: (n: number) => `${n} days`,
    declare: "declare a type",
    declareNote:
      "An existing name saves a new version — the same append-only migration yoke ontology add-type performs.",
    name: "name",
    kind: "kind",
    entity: "entity",
    relation: "relation",
    attrsHint: "— comma separated, * = required",
    ttlHint: "— days, blank = never goes stale",
    saveType: "save type",
    maintenance: "maintenance",
    maintenanceNote:
      "namespace-wide repairs — the same two commands, same effects",
    backfill: "backfill authorship",
    backfillHint:
      "re-derive authored_by edges for records committed before the gate made them",
    backfillDone: (scanned: number, created: number) =>
      `scanned ${scanned} records, added ${created} authorship edges`,
    renameFrom: "rename from",
    attrsExample: "title*, owner",
    renamePlaceholder: "rename a type…",
    newName: "new name",
    rename: "rename",
    renameHint:
      "rewrites the declaration and every stored row, history included",
    renameDone: (from: string, to: string, rows: number) =>
      `renamed ${from} to ${to} — ${rows} rows rewritten`,
  },
  persona: {
    heading: "Persona",
    lede: "The verified knowledge a person authored — what an agent receives when it asks how they would decide. Their records with their sources, never text written in their voice.",
    choose: "choose a person…",
    filter: "filter their records",
    exportHint: (id: string) => `export: yoke persona ${id} --out ./skills`,
    prompt: "pick a person to see the judgment they have on record",
    decisions: "guiding decisions",
    noDecisions:
      "no decisions on record — the bottleneck for a persona is capture, not query",
    otherKnowledge: "other knowledge",
  },
  inject: {
    heading: "Injection preview",
    ledeBefore:
      "Exactly what an agent receives for this query — same filter, same order, same citations as a real ",
    ledeAfter:
      " call. Stale and deprecated records never appear, whatever you ask for.",
    queryPlaceholder: "what is the agent working on?",
    scopePlaceholder: "scope (collaboration or person id, optional)",
    run: "preview",
    includeDraft: "include drafts",
    prompt: "enter a query, or a scope on its own for that context's briefing",
    draftsIncluded:
      "Drafts included. An agent would NOT receive these — they are shown labelled so you can see what is waiting for review.",
    wouldBeInjected: "would be injected",
    scopeNote: (id: string) => `scope: ${id} (leads, does not imprison)`,
    truncated: (shown: number, total: number) =>
      `showing ${shown} of ${total} — an agent gets the same page, plus a note telling it to ask a specific question for the rest. Raise the limit to preview more.`,
    empty:
      "nothing verified matches — an agent would get nothing for this query",
  },
  graph: {
    heading: "Graph",
    ledeAnchored:
      "Two hops out from one record. Double-click any node to expand from it.",
    lede: "Every record and relation in this namespace. Double-click a node to pull in its neighbours.",
    wholeNamespace: "whole namespace",
    counts: (nodes: number, links: number) =>
      `${nodes} nodes · ${links} relations`,
    legend:
      "arrows point at an edge's target · dashed = not knowledge (authorship, membership)",
    empty: "nothing to draw in this namespace",
    nodes: "nodes",
    nodesNote:
      "same data, keyboard-navigable — the canvas above is not reachable by screen readers",
  },
  audit: {
    heading: "Audit",
    lede: "The append-only trail of knowledge read and governance performed. Filtering here narrows the loaded window, not the whole history — use ",
    ledeAfter: " to walk all of it.",
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
    } as Record<string, string>,
  },
  login: {
    heading: "Sign in",
    lede: "Paste an API token or an OIDC id_token. yoke never stores a password — this is a credential you already minted.",
    token: "token",
    credential: "credential",
    checking: "checking…",
    submit: "sign in",
    rejected: "credential rejected",
    noTokenBefore: "No token yet? On the server running yoke:",
    noTokenAfter:
      " to that scope list to allow promoting drafts — verify is the governance permission, so it is granted, never assumed.",
    addPrefix: "Add ",
  },
  errors: {
    forbiddenHint:
      "this credential lacks the scope for that action. Mint one with: yoke token create --scopes read,verify",
  },
};
