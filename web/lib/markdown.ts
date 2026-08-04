// A markdown subset, parsed to a token tree. No renderer here and no React — the tree is what the
// root vitest suite can test (web/lib/react-free-tests.test.ts: a test in this tree may not import a
// `.tsx` module), and the component that turns it into elements lives in components/Markdown.tsx.
//
// Hand-rolled rather than a dependency, on the same grounds as the ontology validator ("no schema
// library") and core/rank.ts's BM25: the syntax that actually reaches these screens was counted, not
// guessed. Over a 99,626-character corpus of real records:
//
//   ## heading   58     - bullet   140     1. ordered   66
//   **bold**     12     `code`      39     | table       8
//   ### / #       0     ``` fence    0     > quote       0     [link](url)  0
//
// So: headings, both list kinds, tables, and two inline marks. The four constructs with zero
// occurrences are not implemented — an unused branch is a branch nobody has ever seen run.
//
// ponytail: no nesting, no fences, no links. A nested list renders as flat items and a fence renders
// as paragraphs — degraded, never dropped, which is the property that matters when the input is
// someone's knowledge. Add a construct when a corpus shows it, not before.

/** A run of text carrying at most one mark. Deliberately not a tree: nothing in the measured corpus
 * nests marks, and a flat run is what keeps the renderer free of `dangerouslySetInnerHTML`. */
export type Inline = { text: string; bold?: boolean; code?: boolean };

export type Block =
  | { kind: "heading"; level: number; text: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "table"; head: Inline[][]; rows: Inline[][][] }
  | { kind: "para"; text: Inline[] };

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const TABLE_ROW = /^\s*\|(.*)\|\s*$/;
/** The `|---|:--:|` row under a table header. It carries alignment, which this does not render, so
 * its only job is to confirm the line above it was a header. */
const TABLE_RULE = /^\s*\|[\s:|-]+\|\s*$/;

/** `**bold**` and `` `code` `` in one pass. Ordered so a backtick inside bold still tokenizes as
 * code rather than swallowing the closing asterisks. */
const MARKS = /\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let at = 0;
  for (const m of src.matchAll(MARKS)) {
    const i = m.index ?? 0;
    if (i > at) out.push({ text: src.slice(at, i) });
    if (m[1] !== undefined) out.push({ text: m[1], bold: true });
    else out.push({ text: m[2], code: true });
    at = i + m[0].length;
  }
  if (at < src.length) out.push({ text: src.slice(at) });
  // An empty string still yields one run, so a renderer never has to special-case "no content".
  return out.length > 0 ? out : [{ text: "" }];
}

const cells = (row: string): Inline[][] =>
  row
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => parseInline(c.trim()));

/**
 * Line-based, because every construct measured above is decided by its own first characters. A
 * paragraph accumulates until a blank line or a line that starts something else, which is what makes
 * a heading immediately after text work without a blank line between them — real notes are written
 * that way.
 */
export function parseMarkdown(src: string): Block[] {
  const blocks: Block[] = [];
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  let para: string[] = [];
  const flush = () => {
    if (para.length === 0) return;
    blocks.push({ kind: "para", text: parseInline(para.join(" ")) });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      flush();
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      blocks.push({
        kind: "heading",
        level: h[1].length,
        text: parseInline(h[2].trim()),
      });
      continue;
    }
    // A table is a header row followed by the rule row. Without that second line it is just text
    // containing pipes, which is what a lone `| 표` inside a sentence is.
    if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[i + 1] ?? "")) {
      flush();
      const head = cells(line);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i])) {
        rows.push(cells(lines[i]));
        i++;
      }
      i--;
      blocks.push({ kind: "table", head, rows });
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    if (bullet || ordered) {
      const isOrdered = !bullet;
      const text = (bullet ?? ordered)?.[1] ?? "";
      const last = blocks[blocks.length - 1];
      // Consecutive items of the same kind join one list; switching kind starts a new one, so a
      // bulleted list directly under a numbered one does not silently renumber.
      if (
        para.length === 0 &&
        last?.kind === "list" &&
        last.ordered === isOrdered
      ) {
        last.items.push(parseInline(text));
      } else {
        flush();
        blocks.push({
          kind: "list",
          ordered: isOrdered,
          items: [parseInline(text)],
        });
      }
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

/**
 * Whether a stored value should be rendered as a document rather than as a table cell.
 *
 * A newline is the test, and it is the honest one: attributes are free-form, so the only evidence
 * that a value was WRITTEN as a document is that its author put line breaks in it. A one-line value
 * containing an asterisk is a sentence, not markup, and turning it into a paragraph block would
 * reflow the short values that make up most of any corpus.
 */
export function isDocument(value: string): boolean {
  return value.includes("\n");
}
