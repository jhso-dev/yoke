"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Actor } from "../../components/Actor";
import { AttributeValue } from "../../components/AttributeValue";
import { Citation } from "../../components/Citation";
import { DeprecateButton } from "../../components/DeprecateButton";
import { DirectionIcon } from "../../components/DirectionIcon";
import { Downstream } from "../../components/Downstream";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Instant } from "../../components/Instant";
import { LinkRecord } from "../../components/LinkRecord";
import { Pagination, usePage } from "../../components/Pagination";
import { Panel, PanelHead } from "../../components/Panel";
import { StatusBadge } from "../../components/StatusBadge";
import { api } from "../../lib/api";
import { recordLabel, shortId } from "../../lib/citation";
import { copyText } from "../../lib/clipboard";
import { useT } from "../../lib/i18n";
import { localTime } from "../../lib/time";
import { isMissing, type Knowledge } from "../../lib/types";
import { useAsync } from "../../lib/useAsync";

/**
 * One record, as stored. Nothing inferred, nothing summarized away.
 *
 * The version history is the point as much as the attributes: yoke never overwrites, so every row
 * here is a belief the system once held, and being able to read them in order is what makes
 * "reconstruct what we believed then" a real claim rather than a design note.
 */
function EntityBody() {
  const id = useSearchParams().get("id") ?? "";
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [downstream, setDownstream] = useState<Knowledge[]>([]);
  const detail = useAsync(
    () => (id ? api.entity(id) : Promise.resolve(null)),
    [id],
  );
  // The relation types this namespace declares — the link control is built from them, so a tenant
  // with its own relation names gets its own list without a code change.
  const ontology = useAsync(() => api.ontology(), []);
  const t = useT();
  // Both of this screen's tables paginate, like every other table in the app: a long-lived record's
  // relations are an unbounded wall otherwise, and the one just added through the control above it
  // lands somewhere in that wall with nothing pointing at it. Declared here, above the early
  // returns, because hooks cannot be called conditionally.
  const historyPage = usePage(detail.data?.history ?? []);
  const edgePage = usePage(
    detail.data
      ? [...detail.data.relations.out, ...detail.data.relations.in]
      : [],
  );

  async function act(kind: "verify" | "deprecate") {
    setBusy(true);
    setActionError(null);
    try {
      if (kind === "verify") await api.verify([id]);
      // Retiring answers what rests on it (v5.8). Kept in state rather than announced, because the
      // records are meant to be opened — a toast cannot hold a link.
      else setDownstream((await api.deprecate([id])).downstream);
      detail.reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }

  if (!id)
    return (
      <Panel>
        <div className="empty">
          {t.entity.noId} <Link href="/browse/">{t.common.browse}</Link>
        </div>
      </Panel>
    );
  // Only the FIRST load may replace the screen. `useAsync` keeps the previous data while refetching,
  // and throwing it away here would swap the heading, the badge, the attributes and the provenance
  // for the word "loading" on every verify — exactly when the reader is waiting to see the status
  // change.
  if (detail.loading && !detail.data)
    return <p className="muted">{t.common.loading}</p>;
  if (detail.error)
    return (
      <>
        <h1>{t.common.record}</h1>
        <ErrorBanner error={detail.error} onRetry={detail.reload} />
      </>
    );
  const d = detail.data;
  if (!d) return <div className="empty">{t.common.notFound}</div>;

  const edges = [...d.relations.out, ...d.relations.in];
  return (
    <>
      <h1>
        <span className="mono">{d.entity.type}</span>{" "}
        {recordLabel(d.entity) === d.entity.summary
          ? d.entity.summary
          : t.entity.noTextAttributes}
      </h1>
      <p className="lede">
        <StatusBadge status={d.entity.effectiveStatus} />{" "}
        {/* This record's own id, shortened like every other id a person reads. Click to copy the
            whole thing — a ULID is for machines and for pasting into a command, not for reading. */}
        <Button
          variant="ghost"
          size="text"
          className="mono muted cursor-copy"
          title={`${d.entity.id}\n\n${t.entity.copyId}`}
          onClick={() => copyText(d.entity.id, t.common.copied)}
        >
          {shortId(d.entity.id)}
        </Button>
      </p>
      <ErrorBanner error={actionError} />
      {/* The question a retired record raises, answered on the record itself. It comes from the
          governance act rather than the row, so a record retired twice shows the reason for the
          retirement it is currently in. */}
      {d.retirement && (
        <Alert variant="warn">
          {/* The retiree through <Actor>, resolved to a name with the id on hover — a bare ULID used
              to sit in this human sentence. */}
          <Actor
            actor={d.retirement.actor}
            actorName={d.retirement.actorName}
          />
          {t.retire.retiredBy(localTime(d.retirement.at))}
          {" — "}
          {d.retirement.reason ?? t.retire.noReason}
        </Alert>
      )}

      <div className="controls">
        <Button
          type="button"
          disabled={busy || d.entity.effectiveStatus === "verified"}
          onClick={() => act("verify")}
          title={t.common.verifyHint}
        >
          {d.entity.effectiveStatus === "stale"
            ? t.common.reconfirm
            : t.common.verify}
        </Button>
        <DeprecateButton
          ids={[id]}
          disabled={busy || d.entity.effectiveStatus === "deprecated"}
          label={t.common.deprecate}
          onDone={(down) => {
            setDownstream(down);
            detail.reload();
          }}
        />
        <Button asChild variant="outline">
          <Link href={`/graph/?scope=${encodeURIComponent(d.entity.id)}`}>
            {t.common.openInGraph}
          </Link>
        </Button>
      </div>
      {/* Below the buttons, not above them: this is the consequence of pressing Deprecate, and putting
          it between the record heading and its own controls made the controls read as the table's. */}
      <Downstream rows={downstream} />

      <Panel>
        <PanelHead>{t.common.attributes}</PanelHead>
        <Table>
          <TableBody>
            {Object.entries(d.entity.attributes).map(([k, v]) => (
              <TableRow key={k}>
                <TableHead style={{ width: "22%" }}>{k}</TableHead>
                <TableCell>
                  <AttributeValue value={v} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>

      <Panel>
        <PanelHead>{t.entity.provenance}</PanelHead>
        <Table>
          <TableBody>
            <TableRow>
              <TableHead style={{ width: "22%" }}>
                {t.entity.recordedBy}
              </TableHead>
              <TableCell>
                <Actor actor={d.entity.actor} actorName={d.entity.actorName} />
              </TableCell>
            </TableRow>
            <TableRow>
              <TableHead>{t.entity.origin}</TableHead>
              <TableCell className="mono">{d.entity.origin}</TableCell>
            </TableRow>
            <TableRow>
              <TableHead>{t.entity.occurredAt}</TableHead>
              <TableCell className="mono">
                <Instant iso={d.entity.occurred_at} />
              </TableCell>
            </TableRow>
            <TableRow>
              <TableHead>{t.entity.lastConfirmed}</TableHead>
              <TableCell className="mono">
                <Instant iso={d.entity.last_confirmed} />
              </TableCell>
            </TableRow>
            {/* Compact, like everywhere else. Every field the raw string contains is already a row
                in this table (id in the header, version, recorded by, occurred at) — its only
                unique value is being copyable exactly, which the click gives. */}
            <TableRow>
              <TableHead>{t.entity.citation}</TableHead>
              <TableCell>
                <Citation row={d.entity} />
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Panel>

      <Panel>
        <PanelHead>
          {t.entity.versionHistory}
          <span className="muted">{d.history.length}</span>
        </PanelHead>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.common.version}</TableHead>
              <TableHead>{t.entity.storedStatus}</TableHead>
              <TableHead>{t.common.actor}</TableHead>
              <TableHead>{t.entity.occurredAt}</TableHead>
              <TableHead>{t.common.source}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {historyPage.items.map((h) => (
              <TableRow key={h.version}>
                <TableCell className="num">{h.version}</TableCell>
                <TableCell>
                  <StatusBadge status={h.status} />
                </TableCell>
                <TableCell>
                  <Actor actor={h.actor} actorName={h.actorName} />
                </TableCell>
                <TableCell className="mono">
                  <Instant iso={h.occurred_at} />
                </TableCell>
                <TableCell>
                  <Citation row={h} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <Pagination
          page={historyPage.page}
          pages={historyPage.pages}
          setPage={historyPage.setPage}
          total={d.history.length}
        />
      </Panel>

      <Panel>
        <PanelHead>
          {t.common.relations}
          <span className="muted">{edges.length}</span>
        </PanelHead>
        {/* `yoke link` for this record. Any declared relation, either direction — the general case
            the collaboration screen specialises. */}
        <LinkRecord
          ontology={ontology.data ?? []}
          record={d.entity}
          onLinked={detail.reload}
        />
        {edges.length === 0 ? (
          <div className="empty">{t.entity.standsAlone}</div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.common.direction}</TableHead>
                  <TableHead>{t.common.type}</TableHead>
                  <TableHead>{t.common.otherEnd}</TableHead>
                  <TableHead>{t.common.status}</TableHead>
                  <TableHead>{t.common.source}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {edgePage.items.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="mono">
                      {/* The readable phrasing, not the stored field name: this used to announce
                        "out"/"in" as both the aria-label and the tooltip — untranslated, and a
                        column heading's worth of meaning left to the reader to infer. The two
                        sentences already existed for this exact concept on the link control. */}
                      <DirectionIcon
                        direction={e.dir === "out" ? "right" : "left"}
                        label={
                          e.dir === "out"
                            ? t.entity.pointsAt
                            : t.entity.isPointedAt
                        }
                      />
                    </TableCell>
                    <TableCell className="mono">{e.type}</TableCell>
                    <TableCell>
                      {isMissing(e.other) ? (
                        <span className="mono muted">
                          <span className="mono">{shortId(e.other.id)}</span> —
                          {t.common.notInNamespace}
                        </span>
                      ) : (
                        <Link
                          href={`/entity/?id=${encodeURIComponent(e.other.id)}`}
                        >
                          {recordLabel(e.other)}
                        </Link>
                      )}
                    </TableCell>
                    <TableCell>
                      {isMissing(e.other) ? null : (
                        <StatusBadge status={e.other.effectiveStatus} />
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
              page={edgePage.page}
              pages={edgePage.pages}
              setPage={edgePage.setPage}
              total={edges.length}
            />
          </>
        )}
      </Panel>
    </>
  );
}

export default function EntityPage() {
  const t = useT();
  return (
    <Suspense fallback={<p className="muted">{t.common.loading}</p>}>
      <EntityBody />
    </Suspense>
  );
}
