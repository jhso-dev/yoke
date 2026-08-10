"use client";

import Link from "next/link";
import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Actor } from "../../components/Actor";
import { CopyCode } from "../../components/CopyCode";
import { DateRangePicker } from "../../components/DateTimePicker";
import { DirectionIcon } from "../../components/DirectionIcon";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Instant } from "../../components/Instant";
import { Pagination, usePage } from "../../components/Pagination";
import { Panel } from "../../components/Panel";
import { api } from "../../lib/api";
import { recordLabel, shortId } from "../../lib/citation";
import { useT } from "../../lib/i18n";
import { isoFromLocalInput } from "../../lib/time";
import type { AuditEntry } from "../../lib/types";
import { useAsync } from "../../lib/useAsync";

/** Radix Select reserves the empty string for "no selection", so an "all"/"any" option cannot BE the
 * empty value it means — it carries this token and the handler maps it back. The filter state stays
 * `""` so the URL and the API call are unchanged. */
const ANY = "__any";

/**
 * Who was told what, when — answerable without shell access.
 *
 * The action names are shown as-is and never collapsed: `inject` is what an agent received,
 * `inject_preview` is a human looking at this workbench, `persona` is a person-anchored read,
 * `verify`/`deprecate` are governance acts. The readable gloss for each lives in the dictionary
 * (`t.audit.meaning`) — the NAME is the audit fact and is not translated; the explanation is.
 */

/** A bulk verify names every id it promoted, which can be thousands. Render a readable prefix and
 * say how many were left off — the count is the honesty, the full list is in `yoke audit`. */
const SHOW_REFS = 12;

/** One page of the trail, newest first — enough that a local run's whole history usually fits, and
 * one request rather than a cursor walk. Named because the request and the cap notice have to agree:
 * a screen that asks for 500 and says "the most recent 200" is lying about what it left out, and
 * `t.audit.shown` ("N of M loaded") reads as completeness on its own.
 *
 * ceiling: no paging past the newest 500. Lifting it needs the cursor the audit endpoint does not
 * have yet; until then the honest move is to say the cap out loud and point at `yoke audit --json`. */
const LOAD_LIMIT = 500;

function Detail({ event }: { event: AuditEntry }) {
  const t = useT();
  // Two shapes: `<subject> -> <id> …` for a read, a bare id list for verify/deprecate. Returning the
  // raw text when there is no arrow is what made a verify row a column of ULIDs.
  const [head, right] = event.detail.split(" -> ");
  // With an arrow the head is the subject; without one the whole string is the id list, and printing
  // it as a subject would put the ULIDs back beside their resolved form.
  const subject = right === undefined ? "" : head;
  const all = (right ?? head ?? "").split(" ").filter(Boolean);
  const ids = all.slice(0, SHOW_REFS);
  const more = all.length - ids.length;
  const byId = new Map((event.refs ?? []).map((r) => [r.id, r]));
  // The subject is a TOKEN LIST (SPEC "HTTP API"): a persona row's is one person id, an anchored
  // injection's is an anchor id then the query text, and an as-of read prefixes `@<instant>`. Treating
  // it as one opaque string resolved only the single-token case, so an anchored injection would print
  // its anchor as a raw ULID next to the resolved names of everything it returned.
  const subjectTokens = subject.split(" ").filter(Boolean);
  return (
    <>
      {subjectTokens.length > 0 && (
        <>
          {subjectTokens.map((tok, i) => {
            const ref = byId.get(tok);
            return (
              // The index is part of the key because a subject can legitimately repeat a token — a
              // query is free text and "cache cache" is a query. This list is derived from one
              // immutable string and is never reordered.
              // biome-ignore lint/suspicious/noArrayIndexKey: tokens are not unique; the detail is immutable.
              <span key={`${tok}-${i}`}>
                {i > 0 && " "}
                {ref ? (
                  <Link href={`/entity/?id=${encodeURIComponent(tok)}`}>
                    {recordLabel(ref)}
                  </Link>
                ) : (
                  <span>{tok}</span>
                )}
              </span>
            );
          })}
          <span className="muted">
            {" "}
            <DirectionIcon direction="right" />{" "}
          </span>
        </>
      )}
      {/* "nothing" belongs to the RESULT half only. Returning it before the subject rendered threw
          away the query text and the resolved anchor of every zero-result read — about half the rows
          on a demo corpus — and this screen exists to answer "who asked for what", which is exactly
          the half that survives when the answer was empty. */}
      {all.length === 0 ? (
        <span className="muted">{t.audit.nothing}</span>
      ) : (
        ids.map((id, i) => {
          const ref = byId.get(id);
          return (
            <span key={id}>
              {i > 0 && <span className="muted">, </span>}
              <Link href={`/entity/?id=${encodeURIComponent(id)}`}>
                {ref ? recordLabel(ref) : shortId(id)}
              </Link>
              {ref && <span className="muted mono"> {ref.type}</span>}
            </span>
          );
        })
      )}
      {/* Never a silent truncation: the row says how many it left off. */}
      {more > 0 && <span className="muted"> · {t.audit.more(more)}</span>}
    </>
  );
}

export default function Audit() {
  const t = useT();
  // The control's own vocabulary — local wall time, no zone, no seconds. Round-tripping an ISO string
  // through `value` is what made the field clear itself on every pick; the conversion happens once, at
  // the request, and `since` stays the only thing `<input type="datetime-local">` will accept.
  const [range, setRange] = useState({ from: "", to: "" });
  const sinceIso = isoFromLocalInput(range.from);
  const untilIso = isoFromLocalInput(range.to);
  const [action, setAction] = useState("");
  // "Filterable by actor, action and time" is what ROADMAP claims this screen does; actor was
  // missing. It is the axis that answers the question the trail exists for — which agent received
  // what, and which person changed the trust state — and with one actor per local run its absence
  // was invisible.
  const [actor, setActor] = useState("");
  const trail = useAsync(
    () =>
      api.audit({
        since: sinceIso || undefined,
        until: untilIso || undefined,
        limit: LOAD_LIMIT,
      }),
    [sinceIso, untilIso],
  );

  const loaded = trail.data?.items ?? [];
  const rows = loaded.filter(
    (e) =>
      (!action || e.action === action) &&
      // Match on the id, never the display name: two people can share a name, and the id is what
      // the trail actually recorded.
      (!actor || e.actor === actor),
  );
  const actions = [...new Set(loaded.map((e) => e.action))];
  const actors = [
    ...new Map(
      // An unnamed actor is an id, and a stored id can be a 26-character ULID: the dropdown is read
      // for meaning, so it gets the shortened form (the full id is what the filter matches on).
      loaded.map((e) => [e.actor, e.actorName ?? shortId(e.actor)] as const),
    ).entries(),
  ].sort((a, b) => a[1].localeCompare(b[1]));
  // A chosen filter outlives the rows that offered it: narrow the range until no `verify` event
  // loads and `verify` is simply not among this window's actions. Radix renders nothing for a value
  // with no matching item and will not fall back to the placeholder while the value is non-empty, so
  // the trigger went BLANK — an empty table beside an empty filter box, with no way for the reader to
  // see what was filtering, let alone clear it. The absent value stays on the list, labelled absent.
  const missingAction = !!action && !actions.includes(action);
  const missingActor = !!actor && !actors.some(([id]) => id === actor);
  const orderedRows = [...rows].reverse();
  const page = usePage(orderedRows);

  return (
    <>
      <h1>{t.audit.heading}</h1>
      <p className="lede">
        {t.audit.lede}
        <CopyCode value="yoke audit --json" />
        {t.audit.ledeAfter}
      </p>
      <ErrorBanner error={trail.error} />
      <div className="controls">
        {/* Label BESIDE the control, not around it — wrapped-plus-htmlFor double-activates in some
            engines (see the inject screen's filter row). */}
        <span className="flex items-center gap-1.5">
          <Label
            htmlFor="audit-since"
            className="text-[inherit] font-[inherit]"
          >
            {t.audit.period}
          </Label>
          {/* Every timestamp on this screen reads in the viewer's zone, so the filter takes one
              too. A RANGE, because "what happened that week" is the question an auditor actually
              asks; from-only stays possible (open-ended since). */}
          <DateRangePicker
            id="audit-since"
            value={range}
            onChange={setRange}
            title={t.audit.sinceHint}
            unsetLabel={t.common.anyTime}
            resetLabel={t.common.clear}
          />
        </span>
        <Select
          value={action || ANY}
          onValueChange={(v) => setAction(v === ANY ? "" : v)}
        >
          <SelectTrigger aria-label={t.common.action}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>{t.audit.allActions}</SelectItem>
            {missingAction && (
              <SelectItem value={action}>
                {t.audit.noneInWindow(action)}
              </SelectItem>
            )}
            {actions.map((a) => (
              <SelectItem key={a} value={a}>
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={actor || ANY}
          onValueChange={(v) => setActor(v === ANY ? "" : v)}
        >
          <SelectTrigger aria-label={t.common.actor}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>{t.audit.allActors}</SelectItem>
            {missingActor && (
              <SelectItem value={actor}>
                {t.audit.noneInWindow(shortId(actor))}
              </SelectItem>
            )}
            {actors.map(([id, label]) => (
              <SelectItem key={id} value={id}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="muted">
          {t.audit.shown(rows.length, loaded.length)}
        </span>
      </div>
      {/* Never a silent cap. "N of M loaded" describes the request, not the trail, so a 5,000-event
          corpus read as complete until this said otherwise. Every sibling screen states its cap. */}
      {loaded.length >= LOAD_LIMIT && (
        <Alert variant="warn">{t.audit.capped(LOAD_LIMIT)}</Alert>
      )}
      {/* Was `.panel`, which globals.css marks as migration debt. The overrides are what `.panel`
          gave a full-bleed table for free: no card padding or row gap around the table itself (the
          reader's padding comes from the cells), this product's 6px radius rather than shadcn's
          larger one so the box matches the panels still on every other screen, and no shadow. No
          `overflow-hidden` — nothing here paints to the edge (this screen has no panel head) and
          clipping would cut the pager buttons' focus ring. */}
      <Panel>
        {trail.loading ? (
          <div className="empty">{t.common.loading}</div>
        ) : rows.length === 0 ? (
          // Two different emptinesses, and blaming the clock for a filter sent readers widening a
          // window that was never the problem.
          <div className="empty">
            {loaded.length > 0 ? t.audit.noneMatch : t.audit.empty}
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.common.when}</TableHead>
                  <TableHead>{t.common.actor}</TableHead>
                  <TableHead>{t.common.action}</TableHead>
                  <TableHead>{t.common.detail}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {page.items.map((e, i) => (
                  // The index is part of the key because audit_log has no primary key: two identical
                  // events in the same second by the same actor are genuinely indistinguishable. The
                  // rule guards against reordering, and this list is append-only and never reordered.
                  // biome-ignore lint/suspicious/noArrayIndexKey: no id exists to key on.
                  <TableRow key={`${e.at}-${e.actor}-${e.action}-${i}`}>
                    <TableCell className="mono">
                      <Instant iso={e.at} />
                    </TableCell>
                    <TableCell>
                      <Actor actor={e.actor} actorName={e.actorName} />
                    </TableCell>
                    <TableCell
                      className="mono"
                      title={t.audit.meaning[e.action] ?? e.action}
                    >
                      {e.action}
                    </TableCell>
                    <TableCell>
                      <Detail event={e} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {/* A sibling of <Table>, not a child of it: Table renders its OWN `overflow-x-auto`
                container, and the pager used to sit inside that box — so on a narrow viewport the
                Next button scrolled sideways out of view along with the widest column. `.panel`
                inset a direct `.controls` child by 12px in CSS; here the top comes from the card's
                gap, the sides from `.pager`, and the bottom from `.controls`' own margin. */}
            <Pagination
              page={page.page}
              pages={page.pages}
              setPage={page.setPage}
              total={rows.length}
            />
          </>
        )}
      </Panel>
    </>
  );
}
