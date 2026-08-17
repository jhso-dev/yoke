"use client";

import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
} from "@/components/ui/table";
import { useT } from "../lib/i18n";
import type { EntityDetail } from "../lib/types";
import { Panel, PanelHead } from "./Panel";

/** Entity types the catalog fragment declares (ontology/catalog.json). */
const CATALOG_TYPES = new Set(["service", "api", "datastore"]);

// Both directions, because the page hands this the concatenation of `out` and `in` and the two carry a
// literal `dir` that does not unify.
type Edge =
  | EntityDetail["relations"]["out"][number]
  | EntityDetail["relations"]["in"][number];

/**
 * The catalog view of a record, on the page that already renders records (v7.3.5).
 *
 * Deliberately not a `/service` route. `/entity` already loads the record and every edge touching it, so
 * a second detail page would be a second thing to keep in sync with the first — the two-places problem
 * this whole version exists to avoid. This groups edges the response already carried: who is accountable,
 * what it depends on, what depends on it, what documents it.
 *
 * Renders nothing for a non-catalog type, so the page is byte-identical for every other record.
 */
export function CatalogPanel({ type, edges }: { type: string; edges: Edge[] }) {
  const t = useT();
  if (!CATALOG_TYPES.has(type)) return null;

  const pick = (relType: string, dir: "in" | "out") =>
    edges.filter((e) => e.type === relType && e.dir === dir);
  const owners = pick("owns", "in");
  const dependsOn = pick("depends_on", "out");
  const dependents = pick("depends_on", "in");
  // A doc is a `resource` attached to this record; the importer files TechDocs that way so the docs index
  // reaches it through the same filter as every other document.
  const docs = pick("relates_to", "in").filter(
    (e) => "type" in e.other && e.other.type === "resource",
  );

  const row = (label: string, list: Edge[], empty: string) => (
    <TableRow key={label}>
      <TableHead scope="row" style={{ width: "22%" }}>
        {label}
      </TableHead>
      <TableCell>
        {list.length === 0 ? (
          // Stated, never blank: "nobody owns this" is the finding, and an empty cell reads as a
          // rendering gap rather than as an answer.
          <span className="muted">{empty}</span>
        ) : (
          <span className="flex flex-wrap gap-2">
            {list.map((e) => (
              <Link
                key={e.id}
                href={`/entity/?id=${encodeURIComponent(e.other.id)}`}
              >
                {"summary" in e.other ? e.other.summary : e.other.id}
              </Link>
            ))}
          </span>
        )}
      </TableCell>
    </TableRow>
  );

  return (
    <Panel>
      <PanelHead>{t.catalog.panelTitle}</PanelHead>
      <Table>
        <TableBody>
          {row(t.catalog.owner, owners, t.catalog.unowned)}
          {row(t.catalog.dependsOnLabel, dependsOn, t.catalog.none)}
          {row(t.catalog.dependentsLabel, dependents, t.catalog.none)}
          {row(t.catalog.docsLabel, docs, t.catalog.noDocs)}
        </TableBody>
      </Table>
    </Panel>
  );
}
