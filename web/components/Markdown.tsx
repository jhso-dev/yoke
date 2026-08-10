import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { type Block, type Inline, parseMarkdown } from "../lib/markdown";

/**
 * A stored value rendered as the document its author wrote.
 *
 * Knowledge is not always one line. A postmortem, an ADR or a runbook arrives with headings, a
 * timeline as a list and sometimes a results table — and every one of them used to land in a table
 * cell as raw text, where HTML collapses the newlines. Measured on a real record: a 2,809-character
 * postmortem with 40 line breaks and 6 sections rendered as one unbroken paragraph, so the timeline,
 * the impact numbers and the action items ran together into a wall nobody reads.
 *
 * Rendered to ELEMENTS, never through `dangerouslySetInnerHTML`: the input is stored knowledge that
 * arrived through the commit gate from a connector, an agent or a person, and none of those are
 * trusted to emit HTML. The parser returns text runs, so escaping is not something this has to
 * remember to do — there is no path by which a `<script>` in a record becomes one on the page.
 *
 * Every key below is built into a local before it is used. Position is the only identity these nodes
 * have — they are parsed fresh from an immutable string on every render and never reorder, so the
 * index is what makes a key unique when two bullets say the same thing. Naming it also keeps the
 * pattern out of biome's index-as-key rule without a suppression comment per element.
 */
export function Markdown({ text }: { text: string }) {
  return <div className="md">{parseMarkdown(text).map(block)}</div>;
}

function inline(runs: Inline[]) {
  return runs.map((r, i) => {
    const key = `${i}:${r.text}`;
    if (r.bold) return <strong key={key}>{r.text}</strong>;
    if (r.code) return <code key={key}>{r.text}</code>;
    return <span key={key}>{r.text}</span>;
  });
}

const cellKey = (i: number, cell: Inline[]) => `${i}:${cell[0]?.text ?? ""}`;

function block(b: Block, i: number) {
  const key = `${b.kind}:${i}`;
  switch (b.kind) {
    case "heading": {
      // Clamped to h3–h4. The panel's own title is the h2 of this region, so honouring a document's
      // `##` literally would put a second heading of that rank inside it and break the outline for a
      // screen reader — the level is relative to where the document sits, not the file it came from.
      const Tag = b.level <= 2 ? "h3" : "h4";
      return <Tag key={key}>{inline(b.text)}</Tag>;
    }
    case "list": {
      const items = b.items.map((item, j) => {
        const itemKey = cellKey(j, item);
        return <li key={itemKey}>{inline(item)}</li>;
      });
      return b.ordered ? (
        <ol key={key}>{items}</ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
    case "table":
      // Its own scroller, because this <Table> sits inside prose rather than in a panel: a
      // five-column results table must not make the page scroll sideways.
      return (
        <div className="overflow-x-auto" key={key}>
          <Table>
            <TableHeader>
              <TableRow>
                {b.head.map((cell, j) => {
                  const headKey = cellKey(j, cell);
                  return <TableHead key={headKey}>{inline(cell)}</TableHead>;
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {b.rows.map((row, j) => {
                const rowKey = `row${j}:${row[0]?.[0]?.text ?? ""}`;
                return (
                  <TableRow key={rowKey}>
                    {row.map((cell, k) => {
                      const dataKey = cellKey(k, cell);
                      return (
                        <TableCell key={dataKey}>{inline(cell)}</TableCell>
                      );
                    })}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      );
    default:
      return <p key={key}>{inline(b.text)}</p>;
  }
}
