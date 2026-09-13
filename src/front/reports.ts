// The reports: `yoke audit --shape | --roi | --pulse` and `yoke persona --check`.
//
// They live behind the server, not in the CLI, because each walks the WHOLE corpus: the question
// they answer is about everything that is there, and paging that over HTTP to render it
// client-side would move a database scan across a network to no purpose. The CLI asks for a report
// and prints what comes back, which is also why the browser and the terminal cannot drift on what
// `--pulse` means.

import { BRIEFING_LIMIT, inject } from "../core/inject.js";
import { atOrBefore } from "../core/lifecycle.js";
import type { TypeDef } from "../core/ontology.js";
import {
  checkPersonaAnchor,
  checkPersonaSources,
  parsePersonaSources,
} from "../core/persona.js";
import { changedOf, injectShape, summarize } from "./display.js";
import type { AuditEvent, YokeStore } from "./store.js";

/** Both shapes of one report: the lines a person reads, and the numbers `--json` carries. */
export interface Report {
  human: string;
  data: unknown;
}

/** `yoke audit --shape` — the workload composition of what models were actually given.
 *
 * Counts `inject` only: `inject_preview` is a human looking at a screen, and mixing the two would
 * answer "what do people click" when the question is "what do agents ask" (docs/RESEARCH.md §5).
 * The other actions are counted too but only as a skipped total, so the denominator is never silent. */
export function shapeReport(events: AuditEvent[]): Report {
  const counts = { anchored: 0, briefing: 0, plain: 0 };
  let asOf = 0;
  let previews = 0;
  let other = 0;
  for (const e of events) {
    if (e.action === "inject_preview") previews++;
    else if (e.action !== "inject") other++;
    else {
      const s = injectShape(e.detail);
      counts[s.shape]++;
      if (s.asOf) asOf++;
    }
  }
  const total = counts.anchored + counts.briefing + counts.plain;
  const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);
  const human = [
    `inject rows: ${total}`,
    ...Object.entries(counts).map(
      ([k, n]) => `  ${k.padEnd(9)} ${String(n).padStart(5)}  ${pct(n)}%`,
    ),
    `  as-of     ${String(asOf).padStart(5)}  ${pct(asOf)}%  (orthogonal — also counted above)`,
    `skipped: ${previews} inject_preview, ${other} other`,
  ].join("\n");
  return {
    human,
    data: { total, ...counts, asOf, skipped: { previews, other } },
  };
}

/** How soon after birth a superseded decision counts as relitigated rather than evolved. A reversal
 * inside this window means the decision did not hold long enough to have been settled — the failure
 * yoke exists to prevent. Chosen, not measured; --pulse reports the raw ages so a corpus can argue. */
const RELITIGATION_WINDOW_DAYS = 14;

/**
 * What a team's own numbers must be for the loop to pay for itself.
 *
 * Every term is either MEASURED off the trail or ASSUMED by the caller, and the two are never mixed
 * in the output: an efficiency figure whose inputs cannot be told apart is a vanity number. The
 * defaults below are starting points, not findings — `--assume k=v` replaces any of them, and the
 * report ends on the break-even value of whichever assumption the answer actually rests on, because
 * that is the sentence a team can check against itself.
 *
 * Savings and costs are both human-minutes over the window the audit query already bounds
 * (`--since`/`--until`), so the ratio is dimensionless and the window is the caller's to choose.
 */
const ROI_DEFAULTS: Record<string, number> = {
  // Deliberately pessimistic. A measurement that flatters the thing it measures is not worth
  // running: every default below sits at the low end of what a team would plausibly claim, so the
  // answer errs toward "not worth it" and a team that disagrees raises its own number on purpose.
  // How long until a teammate would have learned a decision WITHOUT this loop — the standup, the
  // thread they eventually read, the moment they ask. The dominant assumption, by design: it is what
  // yoke claims to collapse, so the report break-evens on it.
  baseline_hours: 24,
  // Of the people handed a decision, the share who would act inside that window (and so could act on
  // the old answer).
  act_rate: 0.3,
  // Minutes lost per hour of working from knowledge that has already changed.
  stale_minutes_per_hour: 1,
  // Of the recalls and reversals delivered mid-session, the share landing on work already underway.
  build_rate: 0.3,
  // Minutes to unwind work built on a decision that had already been reversed.
  unwind_minutes: 30,
  // Minutes of a person's attention per 1k tokens injected into their session.
  read_minutes_per_1k: 0.2,
  // Minutes to file one record by hand (what a connector or an agent files costs none).
  file_minutes: 1,
  // Minutes to re-confirm or retire one record from the queue.
  weed_minutes: 0.5,
};

/** `--assume k=v` — refuse anything not in the table, and anything that is not a number. */
function roiAssumptions(raw: string[] | undefined): Record<string, number> {
  const out = { ...ROI_DEFAULTS };
  for (const pair of raw ?? []) {
    const eq = pair.indexOf("=");
    const key = eq === -1 ? pair : pair.slice(0, eq);
    if (!(key in ROI_DEFAULTS))
      throw new Error(
        `unknown assumption: ${key} — one of ${Object.keys(ROI_DEFAULTS).join(", ")}`,
      );
    const value = Number(pair.slice(eq + 1));
    if (!Number.isFinite(value) || value < 0)
      throw new Error(
        `${key} must be a number 0 or more (got "${pair.slice(eq + 1)}")`,
      );
    out[key] = value;
  }
  return out;
}

/** `yoke audit --roi` — the efficiency question, with its assumptions in the open. */
export async function roiReport(
  store: YokeStore,
  ns: string | null | undefined,
  events: AuditEvent[],
  assume: string[] | undefined,
): Promise<Report> {
  const a = roiAssumptions(assume);

  // ---- measured: what the trail says happened ----
  // Delivery latency per record: from the version's own time to the instant an actor was handed it.
  // Only unseen deliveries count — a plain query is someone going to look, not the loop reaching them.
  const born = new Map<string, number>();
  const typeOf = new Map<string, string>();
  let after: string | undefined;
  const hand = { filed: 0, total: 0 };
  do {
    const page = await store.listEntities({ ns, after, limit: 1000 });
    for (const e of page.items) {
      const t = Date.parse(e.provenance.occurred_at);
      const prev = born.get(e.id);
      if (prev === undefined || t < prev) born.set(e.id, t);
      typeOf.set(e.id, e.type);
      if (e.version === 1) {
        hand.total++;
        const org = e.provenance.origin;
        if (org !== "lifecycle" && org !== "mcp" && !org.includes(":"))
          hand.filed++;
      }
    }
    after = page.next ?? undefined;
  } while (after);

  let delivered = 0;
  let interrupts = 0;
  let tokens = 0;
  const lags: number[] = [];
  let weeded = 0;
  for (const e of events) {
    if (e.action === "verify" || e.action === "deprecate") {
      weeded += e.detail.split(" ").filter(Boolean).length;
      continue;
    }
    if (e.action !== "inject") continue;
    const changed = changedOf(e.detail);
    const arrow = e.detail.lastIndexOf(" -> ");
    if (arrow === -1) continue;
    const ids = e.detail
      .slice(arrow + 4)
      .split(" ")
      .filter(Boolean);
    // Injected volume, as the tokens a session pays attention to. Summaries are what a delivery
    // carries, so the record's own text is the right unit; ~4 bytes per token, the same rough
    // conversion the briefing-cost measurements in docs/ADOPTION use.
    for (const id of ids) {
      const at = Date.parse(e.at);
      const b = born.get(id);
      // Decisions only. Propagation is the claim this product actually makes — the team's decision
      // flow reaching running sessions — and crediting every delivered record with "someone would
      // have needed this a day later" is the assumption doing all the work rather than the loop.
      // A fact delivered fast saves nobody anything unless they needed it in that window, and
      // nothing in the trail says they did.
      if (b !== undefined && at >= b && typeOf.get(id) === "decision")
        lags.push((at - b) / 3_600_000);
    }
    if (changed === undefined) continue; // an un-instrumented row says nothing about interrupts
    delivered += ids.length;
    interrupts += changed;
    tokens += ids.length * 60; // ceiling: a flat per-record estimate, not the rendered bytes
  }
  const median = (xs: number[]) =>
    xs.length === 0
      ? 0
      : [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];
  const lag = median(lags);

  // ---- the two sides, in minutes ----
  // Per delivery, never off the median: a record handed over LATER than the team would have learned
  // it anyway carries no propagation value, and averaging lets a backfill of old records — which is
  // most of what a first import delivers — collect credit for reaching people quickly. Clamped at
  // zero each, so the excluded ones stay visible as a count rather than sinking into an average.
  const gapsFor = (baselineHours: number) =>
    lags.reduce((sum, l) => sum + Math.max(0, baselineHours - l), 0);
  const inWindow = lags.filter((l) => l < a.baseline_hours).length;
  const propagation =
    gapsFor(a.baseline_hours) * a.act_rate * a.stale_minutes_per_hour;
  const rework = interrupts * a.build_rate * a.unwind_minutes;
  const saved = propagation + rework;
  const capture = hand.filed * a.file_minutes;
  const weeding = weeded * a.weed_minutes;
  const attention = (tokens / 1000) * a.read_minutes_per_1k;
  const cost = capture + weeding + attention;
  const ratio = cost === 0 ? null : saved / cost;
  // What baseline_hours would have to be for the loop to break even, holding everything else. The
  // one number a team can check against its own week: "would we really have known within N hours?"
  // Piecewise-linear in baseline_hours (each delivery joins as the window passes its own lag), so
  // solved numerically rather than algebraically. Null when no baseline inside a week can pay for it.
  const savedAt = (h: number) =>
    gapsFor(h) * a.act_rate * a.stale_minutes_per_hour + rework;
  let breakEven: number | null = null;
  if (savedAt(24 * 7) >= cost) {
    let lo = 0;
    let hi = 24 * 7;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (savedAt(mid) >= cost) hi = mid;
      else lo = mid;
    }
    breakEven = hi;
  }

  const r1 = (n: number) => Math.round(n * 10) / 10;
  const human = [
    `measured (${events.length} audit rows, ${hand.total} records)`,
    `  delivered            ${delivered} record-deliveries, ${interrupts} of them a recall/reversal`,
    `  decision deliveries  ${lags.length}; ${inWindow} arrived inside the assumed ${a.baseline_hours}h window, median lag ${r1(lag)}h (older ones earn nothing here)`,
    `  filed by hand        ${hand.filed} of ${hand.total} (the rest cost no one a keystroke)`,
    `  weeding actions      ${weeded} re-confirmations/retirements`,
    `assumed (--assume k=v)`,
    ...Object.entries(a).map(([k, n]) => `  ${k.padEnd(21)}${n}`),
    `minutes saved          ${r1(saved)}  (propagation ${r1(propagation)} + rework ${r1(rework)})`,
    `minutes spent          ${r1(cost)}  (capture ${r1(capture)} + weeding ${r1(weeding)} + attention ${r1(attention)})`,
    `  per decision reached ${inWindow === 0 ? "—" : `${r1(propagation / inWindow)} min`} — the number to sanity-check: is learning this that much sooner worth that?`,
    ratio === null
      ? "efficiency             — nothing was spent yet"
      : `efficiency             ${r1(ratio)}x at the assumptions above (>1 = returns more than it takes)`,
    rework >= cost
      ? `break-even             already covered by the recalls alone: ${r1(rework)} min of avoided ` +
        `rework against ${r1(cost)} min spent, before any propagation credit`
      : breakEven === null
        ? `break-even             does not pay for itself at any baseline under a week — the delivered ` +
          `decisions are too few or arrived too late`
        : `break-even             pays for itself once a teammate would otherwise have learned a ` +
          `decision later than ${r1(breakEven)}h (assumed ${a.baseline_hours}h)`,
  ].join("\n");
  return {
    human,
    data: {
      measured: {
        delivered,
        interrupts,
        lagHours: lag,
        deliveriesTimed: lags.length,
        deliveriesInWindow: inWindow,
        filedByHand: hand.filed,
        records: hand.total,
        weeded,
        rows: events.length,
      },
      assumed: a,
      saved: { propagation, rework, total: saved },
      spent: { capture, weeding, attention, total: cost },
      efficiency: ratio,
      breakEvenHours: breakEven,
    },
  };
}

/** `yoke audit --pulse` — is the collaboration loop actually working, from the trail and the corpus.
 *
 * Every ratio prints its denominator and what it skipped: rows written before an instrumentation
 * carry no signal for it and are counted as unjudgeable, never as zero — otherwise the metric
 * launders the absence of measurement into a verdict (the anchored-0% mistake, docs/RESEARCH.md). */
export async function pulseReport(
  store: YokeStore,
  ns: string | null | undefined,
  events: AuditEvent[],
  at: string,
  opts: { since?: string; scope?: string } = {},
): Promise<Report> {
  const sinceBound = opts.since;
  // Capture density: who is filing knowledge, at what rate. occurred_at is the knowledge's own
  // clock and survives transitions; a head whose origin is 'lifecycle' no longer says who CAPTURED
  // it, so it lands in unjudged rather than in a class it may not belong to.
  const cap = { human: 0, agent: 0, connector: 0, unjudged: 0 };
  let scanned = 0;
  let after: string | undefined;
  do {
    const page = await store.listEntities({ ns, after, limit: 1000 });
    for (const e of page.items) {
      if (sinceBound && atOrBefore(e.provenance.occurred_at, sinceBound))
        continue;
      scanned++;
      const org = e.provenance.origin;
      if (org === "lifecycle") cap.unjudged++;
      else if (org === "mcp") cap.agent++;
      else if (org.includes(":")) cap.connector++;
      else cap.human++;
    }
    after = page.next ?? undefined;
  } while (after);

  // Delivery interrupts: unseen rows carry changed=<n> — how often a delivery lands as a recall or
  // reversal (an interrupt) rather than as news. Rows without the token predate the instrumentation.
  let deliveries0 = 0;
  let interrupts = 0;
  let preToken = 0;
  for (const e of events) {
    if (e.action !== "inject") continue;
    const c = changedOf(e.detail);
    if (c === undefined) {
      if (injectShape(e.detail).shape === "briefing") preToken++;
      continue;
    }
    deliveries0++;
    if (c > 0) interrupts++;
  }

  // Recall reach: for every retirement, of the actors previously handed the record, how many were
  // handed the recall afterwards. Both halves read from the same inject rows the ledger reads.
  const handedBy = new Map<string, Array<{ actor: string; at: string }>>();
  for (const e of events) {
    if (e.action !== "inject") continue;
    const arrow = e.detail.lastIndexOf(" -> ");
    if (arrow === -1) continue;
    for (const id of e.detail.slice(arrow + 4).split(" "))
      if (id) {
        const l = handedBy.get(id) ?? [];
        l.push({ actor: e.actor, at: e.at });
        handedBy.set(id, l);
      }
  }
  let recallOwed = 0;
  let recallReached = 0;
  for (const e of events) {
    if (e.action !== "deprecate") continue;
    for (const id of e.detail.split(" ").filter(Boolean)) {
      const rows = handedBy.get(id) ?? [];
      const before = new Set(
        rows.filter((r) => atOrBefore(r.at, e.at)).map((r) => r.actor),
      );
      for (const actor of before) {
        if (actor === e.actor) continue; // the retirer needs no recall
        recallOwed++;
        if (rows.some((r) => r.actor === actor && !atOrBefore(r.at, e.at)))
          recallReached++;
      }
    }
  }

  // Relitigation: decisions whose supersedes edge arrived within the window of their birth.
  let superseded = 0;
  let relitigated = 0;
  {
    let cursor: string | undefined;
    do {
      const page = await store.listRelations({
        type: "supersedes",
        ns,
        after: cursor,
        limit: 1000,
      });
      for (const r of page.items) {
        const oldRec = await store.getEntity(r.to);
        if (oldRec?.type !== "decision") continue;
        superseded++;
        const ageDays =
          (Date.parse(r.provenance.occurred_at) -
            Date.parse(oldRec.provenance.occurred_at)) /
          86_400_000;
        if (ageDays >= 0 && ageDays <= RELITIGATION_WINDOW_DAYS) relitigated++;
      }
      cursor = page.next ?? undefined;
    } while (cursor);
  }

  // Briefing composition, when a scope is named: what an opening session actually sees.
  let brief: { total: number; decisions: number } | undefined;
  if (opts.scope) {
    const ontology = store.loadOntology(ns);
    const r = await inject(store, ontology, "", at, {
      scope: opts.scope,
      limit: BRIEFING_LIMIT,
      ns,
    });
    brief = {
      total: r.items.length,
      decisions: r.items.filter(
        (it) => it.entity.type === "decision" || it.entity.type === "term",
      ).length,
    };
  }

  const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);
  const human = [
    `capture (${sinceBound ? `since ${sinceBound}` : "all time"}): ${scanned} records`,
    `  human ${cap.human} · agent ${cap.agent} · connector ${cap.connector}` +
      ` · hands-free ${pct(cap.agent + cap.connector, scanned - cap.unjudged)}%` +
      ` (of ${scanned - cap.unjudged} judgeable; ${cap.unjudged} lifecycle-headed skipped)`,
    `deliveries: ${deliveries0} with interrupt instrumentation — ${interrupts} carried a recall/reversal` +
      ` (${pct(interrupts, deliveries0)}%); ${preToken} pre-instrumentation rows skipped`,
    `recall reach: ${recallReached}/${recallOwed} handed-before actors were handed the retirement`,
    `relitigation: ${relitigated}/${superseded} superseded decisions were reversed within ${RELITIGATION_WINDOW_DAYS}d of birth`,
    ...(brief
      ? [
          `briefing (${opts.scope}): ${brief.decisions}/${brief.total} decisions+terms in the opening page`,
        ]
      : []),
  ].join("\n");
  return {
    human,
    data: {
      capture: { ...cap, scanned, since: sinceBound ?? null },
      deliveries: { instrumented: deliveries0, interrupts, preToken },
      recall: { owed: recallOwed, reached: recallReached },
      relitigation: {
        superseded,
        relitigated,
        windowDays: RELITIGATION_WINDOW_DAYS,
      },
      ...(brief ? { briefing: brief } : {}),
    },
  };
}

/** A record in words, for a report a person is meant to act on — never a list of ULIDs. */
function label(
  e: { id: string; type?: string; attributes?: Record<string, unknown> },
  ontology: TypeDef[],
): string {
  if (e.type === undefined || e.attributes === undefined) return e.id;
  return `${summarize({ type: e.type, attributes: e.attributes }, ontology)}  [${e.type} ${e.id}]`;
}

/**
 * `yoke persona --check` — does an exported persona still cite knowledge that stands?
 *
 * The markdown is the CALLER's file (it lives wherever they exported it), so it arrives as text;
 * the corpus it cites is here. `ok` is what the CLI turns into an exit code — unparsed tokens are a
 * failure too, because a source that cannot be read is not a source that is fine.
 */
export async function personaCheckReport(
  store: YokeStore,
  ns: string | null | undefined,
  md: string,
  now: string,
): Promise<{ ok: boolean; human: string; data: unknown } | { error: string }> {
  const header = parsePersonaSources(md);
  if (!header.recognized)
    return { error: 'not an exported persona (no "Source knowledge" line)' };
  const ontology = store.loadOntology(ns);
  {
    const checks = await checkPersonaSources(
      store,
      ontology,
      header.sources,
      now,
      { ns },
    );
    const moved = checks.filter((c) => c.verdict !== "ok");
    const lines = checks.map(
      (c) =>
        // Verdict first, because a reader scans this column and stops at the first thing that is not ok.
        // Then the record in words: a report a person is meant to act on cannot be a list of ULIDs.
        `${c.verdict.padEnd(11)}${label(c, ontology)}${
          c.verdict === "outdated" ? `  (v${c.version} → v${c.current})` : ""
        }`,
    );
    if (header.unparsed.length > 0)
      lines.push(
        `unreadable  ${header.unparsed.join(", ")} — hand-edited header?`,
      );
    // The ANCHOR, not only the sources. `--check` reads the source list, and the anchor person is not
    // among it — so a SKILL.md whose person was `deprecate`d AFTER export audited green ("all current")
    // on a document about someone the org has retired. Gate on the anchor's current status too.
    //
    // `header.anchor` is `safeName(person.id)` (see PersonaHeader.anchor), which is lossless for the
    // ids in use (ULIDs) but mangles a punctuated id — `yoke:system` becomes `yoke-system`, which
    // resolves to nothing. So "missing" is ambiguous (a lossily-encoded anchor vs a truly absent one)
    // and is NOT treated as a failure; the governance defect this gate exists to catch — a retired or
    // non-person anchor — only arises from an anchor that DID resolve, so those are the fatal verdicts.
    // Null anchor = a hand-edited file with no `name: persona-<id>` line (already covered by `unparsed`).
    let anchorBad = 0;
    let anchorVerdict: string | null = null;
    if (header.anchor) {
      anchorVerdict = await checkPersonaAnchor(
        store,
        ontology,
        header.anchor,
        now,
        { ns },
      );
      if (anchorVerdict === "retired" || anchorVerdict === "not-a-person") {
        anchorBad = 1;
        lines.push(`anchor      ${header.anchor} — ${anchorVerdict}`);
      }
    }
    // Counted against what the header DECLARED, not against what parsed: a header that says three and
    // whose list holds one must not report "1 of 1 — all current" and hide the two it no longer names.
    // `Math.max` keeps it truthful the other way round too, if a hand-edited header undercounts its
    // own list.
    const total = Math.max(
      header.declared,
      checks.length + header.unparsed.length,
    );
    const absent = total - checks.length - header.unparsed.length;
    if (absent > 0)
      lines.push(
        `unlisted    ${absent} source(s) the header counts are not in the list — hand-edited header?`,
      );
    const bad = moved.length + header.unparsed.length + absent + anchorBad;
    lines.push(
      bad === 0
        ? `${total} sources, all current`
        : `${bad} of ${total} sources${anchorBad ? " (and the anchor)" : ""} moved or unreadable — re-export with: yoke persona <person> --out <dir>`,
    );
    return {
      ok: bad === 0,
      human: lines.join("\n"),
      data: {
        sources: checks,
        unparsed: header.unparsed,
        // What the header claimed and how many of those never reached a verdict — a JSON consumer
        // (this is meant to be a CI gate) needs the denominator the human line is counted against.
        declared: total,
        unlisted: absent,
        moved: moved.length,
        // The anchor verdict a CI gate needs alongside the sources: the retired-anchor case is invisible
        // in `sources` because the anchor is not one of them.
        anchor: header.anchor
          ? { id: header.anchor, verdict: anchorVerdict }
          : null,
      },
    };
  }
}
