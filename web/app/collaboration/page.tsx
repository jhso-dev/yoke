"use client";

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CardTitle } from "@/components/ui/card";
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
import { AttributeValue } from "../../components/AttributeValue";
import { Citation } from "../../components/Citation";
import { CopyCode } from "../../components/CopyCode";
import { CreateButton } from "../../components/CreateButton";
import { DirectionIcon } from "../../components/DirectionIcon";
import { DisputedLinks } from "../../components/DisputedLinks";
import { ErrorBanner } from "../../components/ErrorBanner";
import { KnowledgeTable } from "../../components/KnowledgeTable";
import { Pagination, usePage } from "../../components/Pagination";
import { Panel, PanelHead } from "../../components/Panel";
import { StatusBadge } from "../../components/StatusBadge";
import { api } from "../../lib/api";
import { recordLabel } from "../../lib/citation";
import { useT } from "../../lib/i18n";
import { announce } from "../../lib/toast";
import {
  type InjectedKnowledge,
  isMissing,
  type Knowledge,
} from "../../lib/types";
import { useAsync } from "../../lib/useAsync";

/* `.panel` and `.panel-head` restated as utilities, because globals.css still owns those classes for
   the screens that have not migrated and this one no longer uses them (see the note at the top of
   globals.css: each class goes when its last screen moves over).

   Card's own defaults are all wrong for a dense workbench panel — `rounded-xl` where every other
   panel is 6px, `py-6` where the content is a full-bleed table whose padding comes from its cells,
   `gap-6` between those children, and a shadow `.panel` never had. The 14px between stacked panels
   has to be said out loud too: it came from a `.panel + .panel` sibling rule, and a CSS selector
   keyed on a class cannot follow markup that stopped using it. */
/* CardTitle's `leading-none` suits a title standing alone in a card. These are one line of 13px text
   in a fixed strip, and the tighter leading shortened only the heads with no note beside the title —
   leaving the panels on one screen at two different heights. */

/** How many people the picker offers, and the number `peopleCapped` names — one constant so the
 * request and the message about the request cannot disagree.
 *
 * ceiling: one page, no typeahead. The picker is a convenience over the path that is always
 * available (`yoke link <person> works_on <collaboration>`, or the link control on the person's own
 * record), so a namespace with more people than this wants a searchable picker, not a bigger number. */
const PEOPLE_LIMIT = 200;

/** Pick a person, record `works_on`. Direction is fixed here rather than offered as a choice. */
function AddMember({
  people,
  capped,
  already,
  to,
  onLinked,
}: {
  people: Knowledge[];
  /** The fetch came back full, so this list is not everyone. Saying so is the same rule the briefing
   * follows for its own cap — a bounded list is honest only if it says where the rest is. */
  capped: boolean;
  already: Set<string>;
  to: string;
  onLinked: () => void;
}) {
  const t = useT();
  const candidates = people.filter((p) => !already.has(p.id));
  const [who, setWho] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // The picked ROW, not just its id: the toast has to name a person and `who` is a ULID, and holding
  // the row also lets the button refuse a selection this list can no longer resolve.
  const picked = candidates.find((p) => p.id === who);
  // An empty namespace is not "everyone is already added", and the guard below could not tell them
  // apart: with no person records at all it never fired, so the reader got a Select that opened an
  // empty popover beside a permanently disabled button, with nothing explaining either.
  if (people.length === 0)
    return <div className="empty">{t.collaboration.noPeople}</div>;
  if (candidates.length === 0)
    return <div className="empty">{t.collaboration.everyoneAdded}</div>;
  return (
    <div className="flex flex-wrap items-center gap-2 p-3">
      <Select value={who} onValueChange={setWho}>
        <SelectTrigger aria-label={t.collaboration.person} className="w-64">
          <SelectValue placeholder={t.collaboration.addSomeone} />
        </SelectTrigger>
        <SelectContent>
          {candidates.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {recordLabel(p)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        type="button"
        disabled={!picked || busy}
        onClick={async () => {
          if (!picked) return;
          setBusy(true);
          setError(null);
          try {
            const { existed } = await api.link({
              from: picked.id,
              type: "works_on",
              to,
            });
            // This was the quietest write in the app: every other action on this screen announces,
            // and a link whose only trace is a table that redraws leaves the reader guessing whether
            // the click landed at all.
            announce(
              existed
                ? t.collaboration.alreadyOnThisWork(recordLabel(picked))
                : t.collaboration.memberAdded(recordLabel(picked)),
            );
            setWho("");
            onLinked();
          } catch (e) {
            setError(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? t.common.linking : t.collaboration.addToWork}
      </Button>
      <ErrorBanner error={error} />
      {/* `basis-full` puts it on its own line in the wrapping row; `mb-0` because the row's own
          padding already supplies the space the variant's `mb-3` is for. */}
      {capped && (
        <Alert variant="info" className="mb-0 basis-full">
          {t.collaboration.peopleCapped(PEOPLE_LIMIT)}
        </Alert>
      )}
    </div>
  );
}

/**
 * The shared working context, made visible.
 *
 * v4.0 made a collaboration anchor a first-class thing in core, MCP and the CLI, and the web tier shipped
 * without it — the only trace was a placeholder in the inject box, so a collaboration id was something you
 * had to already know. This screen is the missing half: pick the work, see who is on it, and see the
 * briefing an agent actually receives when it anchors there.
 *
 * It adds no endpoint. A collaboration is an entity, its members are relations, and its briefing is
 * `inject(scope)` — so this composes three routes that already exist, which is also why every action
 * here stays CLI-achievable (`yoke list --type collaboration`, `yoke get --relations`, `yoke inject
 * --scope`).
 */
function CollaborationBody() {
  const t = useT();
  const id = useSearchParams().get("id") ?? "";
  const [cursors, setCursors] = useState<string[]>([]);
  const after = cursors.at(-1);
  const list = useAsync(
    () => api.entities({ type: "collaboration", after, limit: 20 }),
    [after],
  );
  const detail = useAsync(
    () => (id ? api.entity(id) : Promise.resolve(null)),
    [id],
  );
  // The real thing, not a mock of it: same filter, same ranking, same citations, same audit row as a
  // `yoke_inject` anchored here. If this disagrees with what an agent sees, this screen is lying.
  const briefing = useAsync(
    () => (id ? api.inject({ scope: id, limit: 50 }) : Promise.resolve(null)),
    [id],
  );
  // The create form is built from the ontology, so a tenant that renamed this type or added an
  // attribute gets the right fields with no code change here.
  const ontology = useAsync(() => api.ontology(), []);
  // Candidate members. `person` is the seeded type for a human; a tenant using another name links
  // through the entity screen instead, which is why this list is a convenience and not the only path.
  const people = useAsync(
    () => api.entities({ type: "person", limit: PEOPLE_LIMIT }),
    [],
  );
  // A full page is the signal that this control is not the whole list. Not `next`: the cursor is
  // present whenever the page filled, including when the page after it turns out to be empty, and
  // "only the first 200 are offered" is true either way.
  const peopleCapped = (people.data?.items.length ?? 0) >= PEOPLE_LIMIT;
  const d = detail.data;
  const members = d
    ? d.relations.in.filter((e) => e.type === "works_on").map((e) => e.other)
    : [];
  const attached = d
    ? [...d.relations.in, ...d.relations.out].filter(
        (e) => e.type !== "works_on" && e.type !== "authored_by",
      )
    : [];
  const memberPage = usePage(members);
  const attachedPage = usePage(attached);

  if (!id) {
    const rows = list.data?.items ?? [];
    return (
      <>
        <div className="page-head">
          <h1>{t.collaboration.heading}</h1>
          <CreateButton
            ontology={ontology.data ?? []}
            type="collaboration"
            label={t.collaboration.newOne}
            onCreated={list.reload}
          />
        </div>
        {/* Says what the thing IS in the first clause, because the type name alone never did. And
            "attached to" rather than "in": a collaboration holds nothing — people and records point at
            it, which is what the arrows on the graph screen draw. */}
        <p className="lede">{t.collaboration.lede}</p>
        <ErrorBanner error={list.error} />
        {/* No `.scroll-x` around the table: Table renders its own `overflow-x-auto` container, so the
            wrapper was a second scroller around the first. */}
        <Panel>
          {list.loading ? (
            <div className="empty">{t.common.loading}</div>
          ) : rows.length === 0 ? (
            <div className="empty">{t.collaboration.emptyList}</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {/* No key column: the list payload carries `summary`, not attributes, and one
                      request per row to fetch a key would be an N+1 for a label. The key is on the
                      record when you open it. */}
                  <TableHead>{t.common.title}</TableHead>
                  <TableHead>{t.common.status}</TableHead>
                  <TableHead>{t.common.source}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((w) => (
                  <TableRow key={w.id}>
                    <TableCell>
                      <Link
                        href={`/collaboration/?id=${encodeURIComponent(w.id)}`}
                      >
                        {recordLabel(w)}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={w.effectiveStatus} />
                    </TableCell>
                    <TableCell>
                      <Citation row={w} />
                    </TableCell>
                    <TableCell>
                      <Link href={`/graph/?scope=${encodeURIComponent(w.id)}`}>
                        {t.common.graph}
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Panel>
        <div className="controls" style={{ marginTop: 12 }}>
          <Button
            type="button"
            variant="secondary"
            disabled={cursors.length === 0}
            onClick={() => setCursors((c) => c.slice(0, -1))}
          >
            <ChevronLeftIcon />
            {t.common.prev}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={!list.data?.next}
            onClick={() =>
              setCursors((c) => (list.data?.next ? [...c, list.data.next] : c))
            }
          >
            {t.common.next}
            <ChevronRightIcon />
          </Button>
        </div>
      </>
    );
  }

  // Every exit from this screen offers the way out, not just the one that succeeded. A collaboration
  // id in the URL is often pasted or stale, so "not found" and the error path are the two states a
  // reader is MOST likely to arrive in — and both were dead ends with no link to anything.
  const back = (
    <p className="lede">
      <Link href="/collaboration/">{t.collaboration.all}</Link>
    </p>
  );
  if (detail.loading)
    return (
      <>
        <p className="muted">{t.common.loading}</p>
        {back}
      </>
    );
  if (detail.error)
    return (
      <>
        <h1>{t.collaboration.headingOne}</h1>
        {back}
        <ErrorBanner error={detail.error} />
      </>
    );
  if (!d)
    return (
      <>
        <div className="empty">{t.common.notFound}</div>
        {back}
      </>
    );

  return (
    <>
      <h1>{recordLabel(d.entity)}</h1>
      <p className="lede">
        <StatusBadge status={d.entity.effectiveStatus} />{" "}
        <Link href="/collaboration/">{t.collaboration.all}</Link>
      </p>
      <ErrorBanner error={briefing.error} />

      <div className="controls">
        {/* `variant="outline"` already means "bordered button". These were two of five copies of
            `variant="secondary"` plus a hand-written border across the app — the same idea spelled
            five times, each free to drift. Outline sits on --background rather than --secondary and
            hovers to the accent fill instead of a primary border, which is what a bordered button
            looks like on every other shadcn surface in both themes. */}
        <Button asChild variant="outline">
          <Link href={`/graph/?scope=${encodeURIComponent(id)}`}>
            {t.common.openInGraph}
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link href={`/entity/?id=${encodeURIComponent(id)}`}>
            {t.common.openAsRecord}
          </Link>
        </Button>
        <CopyCode value={`yoke inject --scope ${id}`} />
      </div>

      <Panel>
        <PanelHead>
          <CardTitle>{t.common.attributes}</CardTitle>
        </PanelHead>
        <Table>
          <TableBody>
            {Object.entries(d.entity.attributes).map(([k, v]) => (
              <TableRow key={k}>
                {/* `scope="row"` because this th labels a ROW, not a column — without it a screen
                    reader gets a header cell associated with nothing. */}
                <TableHead scope="row" className="w-[22%]">
                  {k}
                </TableHead>
                <TableCell>
                  {/* The shared renderer, not a local JSON.stringify: an array attribute printed as
                      `["안 1","안 2"]` here while the entity screen showed it as a list. */}
                  <AttributeValue value={v} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>

      <Panel>
        <PanelHead>
          <CardTitle>{t.collaboration.people}</CardTitle>
          {/* The count says what it counts. "3 · The participant list is not knowledge…" was a
              number, a middot and a sentence, with nothing naming the 3. */}
          <span className="muted">
            {t.collaboration.peopleCount(members.length)} ·{" "}
            {t.collaboration.peopleNote}
          </span>
        </PanelHead>
        {/* The direction is not the caller's choice to get wrong: works_on points person →
            collaboration, so the control always links the picked person TO this record. Reversed, the
            collaboration would land on the person's persona instead. */}
        <AddMember
          people={people.data?.items ?? []}
          capped={peopleCapped}
          already={new Set(members.map((m) => m.id))}
          to={id}
          onLinked={detail.reload}
        />
        {members.length === 0 ? (
          <div className="empty">
            {t.collaboration.noMembers}{" "}
            <CopyCode value={`yoke link <person> works_on ${id}`} />
          </div>
        ) : (
          /* The pager sits OUTSIDE the table's scroll container. It used to share the `.scroll-x`
             wrapper with the table, so on a narrow viewport it scrolled sideways out of view along
             with the columns — the control for reaching page 2 was reachable only by scrolling. */
          <>
            <Table>
              <TableBody>
                {memberPage.items.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell>
                      {isMissing(m) ? (
                        <span className="muted">{t.common.notInNamespace}</span>
                      ) : (
                        <Link
                          href={`/persona/?id=${encodeURIComponent(m.id)}`}
                          title={t.collaboration.readJudgment}
                        >
                          {recordLabel(m)}
                        </Link>
                      )}
                    </TableCell>
                    <TableCell>
                      {isMissing(m) ? null : <Citation row={m} />}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pagination
              page={memberPage.page}
              pages={memberPage.pages}
              setPage={memberPage.setPage}
              total={members.length}
            />
          </>
        )}
      </Panel>

      <Panel>
        <PanelHead>
          <CardTitle>{t.collaboration.briefing}</CardTitle>
          <span className="muted">{t.collaboration.briefingNote}</span>
        </PanelHead>
        {briefing.loading ? (
          <div className="empty">{t.common.loading}</div>
        ) : (
          <>
            {/* The cap is honest only if it says where the rest is — the same sentence the agent
                gets from yoke_inject, so the screen and the tool cannot disagree.
                `mx-3` replaces the `.panel > [data-slot="alert"]` rule in globals.css, which keyed on
                the class this panel no longer carries; without it the notice's border lands on the
                panel's own. */}
            {(briefing.data?.omitted ?? 0) > 0 && (
              <Alert variant="warn" className="mx-3">
                {t.collaboration.truncated(
                  briefing.data?.items.length ?? 0,
                  (briefing.data?.items.length ?? 0) +
                    (briefing.data?.omitted ?? 0),
                  briefing.data?.omitted ?? 0,
                )}
              </Alert>
            )}
            {/* What was linked here but held back, and why — the exact reason the server already
                ships (draft/stale/deprecated/superseded/structural). Without it this panel guessed
                the empty-state from the linked-record count and named none of these on a partial
                briefing. Same sentence as the inject preview, since it is the same inject(). */}
            {briefing.data?.withheld && (
              <Alert variant="warn" className="mx-3">
                {t.inject.withheld(
                  briefing.data.withheld,
                  briefing.data.items.length,
                )}
              </Alert>
            )}
            {/* An empty briefing is not an unlinked collaboration. This is `inject(scope)`, which
                returns VERIFIED records only, so a collaboration whose attached records are all draft
                or stale read as "no knowledge is linked to this collaboration" — contradicted by the
                linked-records panel two below, which listed them. When something IS linked, name
                draft/stale as the reason an agent still receives nothing. */}
            <KnowledgeTable
              rows={briefing.data?.items ?? []}
              empty={
                attached.length > 0
                  ? t.collaboration.briefingEmptyLinked(attached.length)
                  : t.collaboration.briefingEmpty
              }
              paginate
              // A disputed briefing row has to look disputed, the same as on the inject preview: an
              // agent anchoring here receives both sides of a live contradiction, and two rows that
              // flatly disagree must not read as two ordinary facts.
              trailing={{
                head: t.inject.disputedHead,
                cell: (r) => (
                  <DisputedLinks
                    ids={(r as InjectedKnowledge).conflictsWith}
                    rows={briefing.data?.items ?? []}
                  />
                ),
              }}
            />
          </>
        )}
      </Panel>

      <Panel>
        <PanelHead>
          <CardTitle>{t.collaboration.attached}</CardTitle>
          <span className="muted">
            {t.collaboration.attachedCount(attached.length)} ·{" "}
            {t.collaboration.attachedNote}
          </span>
        </PanelHead>
        {attached.length === 0 ? (
          <div className="empty">{t.collaboration.attachedEmpty}</div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.common.direction}</TableHead>
                  <TableHead>{t.common.relation}</TableHead>
                  <TableHead>{t.common.record}</TableHead>
                  <TableHead>{t.common.source}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {attachedPage.items.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="mono">
                      <DirectionIcon
                        direction={e.dir === "out" ? "right" : "left"}
                        label={e.dir}
                      />
                    </TableCell>
                    <TableCell className="mono">{e.type}</TableCell>
                    <TableCell>
                      {isMissing(e.other) ? (
                        <span className="muted">{t.common.notInNamespace}</span>
                      ) : (
                        <Link
                          href={`/entity/?id=${encodeURIComponent(e.other.id)}`}
                        >
                          {recordLabel(e.other)}
                        </Link>
                      )}
                    </TableCell>
                    <TableCell>
                      {isMissing(e.other) ? null : <Citation row={e.other} />}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pagination
              page={attachedPage.page}
              pages={attachedPage.pages}
              setPage={attachedPage.setPage}
              total={attached.length}
            />
          </>
        )}
      </Panel>
    </>
  );
}

/** useSearchParams must sit under a Suspense boundary or the static export build fails. */
export default function CollaborationPage() {
  const t = useT();
  return (
    <Suspense fallback={<p className="muted">{t.common.loading}</p>}>
      <CollaborationBody />
    </Suspense>
  );
}
