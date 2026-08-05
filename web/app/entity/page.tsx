"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
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
import { Citation } from "../../components/Citation";
import { DirectionIcon } from "../../components/DirectionIcon";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Instant } from "../../components/Instant";
import { LinkRecord } from "../../components/LinkRecord";
import { Markdown } from "../../components/Markdown";
import { StatusBadge } from "../../components/StatusBadge";
import { api } from "../../lib/api";
import { recordLabel, shortId } from "../../lib/citation";
import { copyText } from "../../lib/clipboard";
import { useT } from "../../lib/i18n";
import { isDocument } from "../../lib/markdown";
import { isMissing } from "../../lib/types";
import { useAsync } from "../../lib/useAsync";

/**
 * One stored attribute value, read the way it was written.
 *
 * Three shapes, because the ontology declares three (`string`, `string[]`, and the numbers/booleans
 * that fall through). Every one of them used to be `typeof v === "string" ? v : JSON.stringify(v)`,
 * which turned a decision's rejected alternatives — arguably the most-read field in the model, since
 * it is what a decision record exists to preserve — into `["안 1","안 2"]`, and a multi-section
 * postmortem into one collapsed paragraph.
 */
function attributeValue(v: unknown) {
  if (typeof v === "string") return isDocument(v) ? <Markdown text={v} /> : v;
  if (Array.isArray(v) && v.every((x) => typeof x === "string"))
    return (
      <div className="md">
        <ul>
          {v.map((x: string, i) => {
            // Position is the only identity these have, and two rejected alternatives can read the
            // same; the stored order is the author's, so it never reorders.
            const key = `${i}:${x}`;
            return <li key={key}>{x}</li>;
          })}
        </ul>
      </div>
    );
  return JSON.stringify(v);
}

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
  const detail = useAsync(
    () => (id ? api.entity(id) : Promise.resolve(null)),
    [id],
  );
  // The relation types this namespace declares — the link control is built from them, so a tenant
  // with its own relation names gets its own list without a code change.
  const ontology = useAsync(() => api.ontology(), []);
  const t = useT();

  async function act(kind: "verify" | "deprecate") {
    setBusy(true);
    setActionError(null);
    try {
      await (kind === "verify" ? api.verify([id]) : api.deprecate([id]));
      detail.reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }

  if (!id)
    return (
      <div className="panel">
        <div className="empty">
          {t.entity.noId} <Link href="/browse/">{t.common.browse}</Link>
        </div>
      </div>
    );
  if (detail.loading) return <p className="muted">{t.common.loading}</p>;
  if (detail.error)
    return (
      <>
        <h1>{t.common.record}</h1>
        <ErrorBanner error={detail.error} />
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
        <Button
          type="button"
          variant="destructive"
          disabled={busy || d.entity.effectiveStatus === "deprecated"}
          onClick={() => act("deprecate")}
        >
          {t.common.deprecate}
        </Button>
        <Button
          asChild
          variant="secondary"
          className="border border-border hover:border-primary"
        >
          <Link href={`/graph/?scope=${encodeURIComponent(d.entity.id)}`}>
            {t.common.openInGraph}
          </Link>
        </Button>
      </div>

      <div className="panel">
        <div className="panel-head">{t.common.attributes}</div>
        <div className="scroll-x">
          <Table>
            <TableBody>
              {Object.entries(d.entity.attributes).map(([k, v]) => (
                <TableRow key={k}>
                  <TableHead style={{ width: "22%" }}>{k}</TableHead>
                  <TableCell>{attributeValue(v)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">{t.entity.provenance}</div>
        <div className="scroll-x">
          <Table>
            <TableBody>
              <TableRow>
                <TableHead style={{ width: "22%" }}>
                  {t.entity.recordedBy}
                </TableHead>
                <TableCell>
                  <Actor
                    actor={d.entity.actor}
                    actorName={d.entity.actorName}
                  />
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
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          {t.entity.versionHistory}
          <span className="muted">{d.history.length}</span>
        </div>
        <div className="scroll-x">
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
              {d.history.map((h) => (
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
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          {t.common.relations}
          <span className="muted">{edges.length}</span>
        </div>
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
          <div className="scroll-x">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.common.direction}</TableHead>
                  <TableHead>{t.common.type}</TableHead>
                  <TableHead>{t.common.otherEnd}</TableHead>
                  <TableHead>status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {edges.map((e) => (
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
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </>
  );
}

export default function EntityPage() {
  return (
    <Suspense fallback={<p className="muted">loading…</p>}>
      <EntityBody />
    </Suspense>
  );
}
