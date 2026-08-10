"use client";

import Link from "next/link";
import { useState } from "react";
import { Input } from "@/components/ui/input";
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
import { DateTimePicker } from "../../components/DateTimePicker";
import { DirectionIcon } from "../../components/DirectionIcon";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Instant } from "../../components/Instant";
import { Pagination, usePage } from "../../components/Pagination";
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

function Detail({ event }: { event: AuditEntry }) {
  const t = useT();
  // Two shapes: `<subject> -> <id> …` for a read, a bare id list for verify/deprecate. Returning the
  // raw text when there is no arrow is what made a verify row a column of ULIDs.
  const [head, right] = event.detail.split(" -> ");
  // With an arrow the head is the subject; without one the whole string is the id list, and printing
  // it as a subject would put the ULIDs back beside their resolved form.
  const subject = right === undefined ? "" : head;
  const all = (right ?? head ?? "").split(" ").filter(Boolean);
  if (all.length === 0) return <span className="muted">{t.audit.nothing}</span>;
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
      {ids.map((id, i) => {
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
      })}
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
  const [since, setSince] = useState("");
  const sinceIso = isoFromLocalInput(since);
  const [action, setAction] = useState("");
  // "Filterable by actor, action and time" is what ROADMAP claims this screen does; actor was
  // missing. It is the axis that answers the question the trail exists for — which agent received
  // what, and which person changed the trust state — and with one actor per local run its absence
  // was invisible.
  const [actor, setActor] = useState("");
  const trail = useAsync(
    () => api.audit({ since: sinceIso || undefined, limit: 500 }),
    [sinceIso],
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
      loaded.map((e) => [e.actor, e.actorName ?? e.actor] as const),
    ).entries(),
  ].sort((a, b) => a[1].localeCompare(b[1]));
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
        <Label
          htmlFor="audit-since"
          className="gap-1.5 text-[inherit] font-[inherit]"
        >
          {t.audit.since}
          {/* Every timestamp on this screen reads in the viewer's zone, so the filter takes one too. */}
          <DateTimePicker
            id="audit-since"
            value={since}
            onChange={setSince}
            title={t.audit.sinceHint}
          />
        </Label>
        <Select
          value={action || ANY}
          onValueChange={(v) => setAction(v === ANY ? "" : v)}
        >
          <SelectTrigger aria-label="action">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>{t.audit.allActions}</SelectItem>
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
          <SelectTrigger aria-label="actor">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>{t.audit.allActors}</SelectItem>
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
      <div className="panel">
        {trail.loading ? (
          <div className="empty">{t.common.loading}</div>
        ) : rows.length === 0 ? (
          <div className="empty">{t.audit.empty}</div>
        ) : (
          <div className="scroll-x">
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
            <Pagination
              page={page.page}
              pages={page.pages}
              setPage={page.setPage}
              total={rows.length}
            />
          </div>
        )}
      </div>
    </>
  );
}
