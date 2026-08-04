import { describe, expect, it } from "vitest";
import { type Block, isDocument, parseInline, parseMarkdown } from "./markdown";

/** The text of a block, marks flattened — what a reader sees, which is what these assert on. */
const text = (b: Block): string =>
  b.kind === "table"
    ? b.head.map((c) => c.map((r) => r.text).join("")).join("|")
    : b.kind === "list"
      ? b.items.map((i) => i.map((r) => r.text).join("")).join(" / ")
      : b.text.map((r) => r.text).join("");

describe("parseMarkdown", () => {
  it("keeps a document's sections apart, which is the whole point", () => {
    // Shaped like the record that prompted this: heading, prose, a timeline, action items. In a table
    // cell all of it was one paragraph.
    const doc = [
      "## 개요",
      "2026-07-14 새벽 결제 실패가 대량 발생했다.",
      "",
      "## 타임라인 (KST)",
      "- 03:10 p99 레이턴시 급등",
      "- 03:12 타임아웃 도달",
      "",
      "## 조치",
      "1. 임계치 하향",
      "2. runbook 작성",
    ].join("\n");
    const blocks = parseMarkdown(doc);
    expect(blocks.map((b) => b.kind)).toEqual([
      "heading",
      "para",
      "heading",
      "list",
      "heading",
      "list",
    ]);
    expect(blocks.filter((b) => b.kind === "list")).toHaveLength(2);
    const [bullets, numbers] = blocks.filter((b) => b.kind === "list");
    expect(bullets.kind === "list" && bullets.ordered).toBe(false);
    expect(numbers.kind === "list" && numbers.ordered).toBe(true);
    expect(text(bullets)).toBe("03:10 p99 레이턴시 급등 / 03:12 타임아웃 도달");
  });

  it("starts a new list when the kind changes, so items are never renumbered", () => {
    const blocks = parseMarkdown("1. 첫째\n2. 둘째\n- 별개\n- 항목");
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => text(b))).toEqual(["첫째 / 둘째", "별개 / 항목"]);
  });

  it("a heading needs no blank line before it — notes are not written that way", () => {
    const blocks = parseMarkdown("본문 한 줄\n## 다음 절\n그 아래");
    expect(blocks.map((b) => b.kind)).toEqual(["para", "heading", "para"]);
  });

  it("joins wrapped lines into one paragraph with a space, not a jam", () => {
    // Without the space, "지연이" + "발생했다" would render as "지연이발생했다".
    expect(text(parseMarkdown("지연이\n발생했다")[0])).toBe("지연이 발생했다");
  });

  it("reads a table only when the rule row confirms it", () => {
    const table = parseMarkdown(
      [
        "| 지표 | v2 | v3 |",
        "|---|---|---|",
        "| nDCG@20 | 0.312 | 0.334 |",
        "| CTR | 2.1% | 2.3% |",
      ].join("\n"),
    );
    expect(table).toHaveLength(1);
    expect(table[0].kind).toBe("table");
    if (table[0].kind === "table") {
      expect(text(table[0])).toBe("지표|v2|v3");
      expect(table[0].rows).toHaveLength(2);
      expect(table[0].rows[0].map((c) => c[0].text)).toEqual([
        "nDCG@20",
        "0.312",
        "0.334",
      ]);
    }
    // A sentence that merely contains pipes is prose, not a table — the rule row is the evidence.
    expect(parseMarkdown("비율은 | 로 구분한다")[0].kind).toBe("para");
  });

  it("marks bold and code inline, and leaves the text between them alone", () => {
    const runs = parseInline("타임아웃 **3초**를 `payments-api`에 적용");
    expect(runs.map((r) => r.text)).toEqual([
      "타임아웃 ",
      "3초",
      "를 ",
      "payments-api",
      "에 적용",
    ]);
    expect(runs.filter((r) => r.bold).map((r) => r.text)).toEqual(["3초"]);
    expect(runs.filter((r) => r.code).map((r) => r.text)).toEqual([
      "payments-api",
    ]);
  });

  it("returns one empty run rather than nothing, so a renderer needs no special case", () => {
    expect(parseInline("")).toEqual([{ text: "" }]);
  });

  it("degrades an unsupported construct instead of dropping it", () => {
    // No fences, quotes or links are implemented (none occur in the measured corpus). The text must
    // still reach the reader — losing a line of someone's knowledge is worse than losing its styling.
    const src = "> 인용문\n[링크](http://x)";
    expect(text(parseMarkdown(src)[0])).toContain("인용문");
    expect(text(parseMarkdown(src)[0])).toContain("링크");
  });

  it("treats a newline as the evidence that a value is a document", () => {
    // A one-line value with an asterisk is a sentence. Reflowing every short attribute would change
    // how most of a corpus reads in exchange for nothing.
    expect(isDocument("타임아웃 3초 * 재시도 2회")).toBe(false);
    expect(isDocument("## 개요\n본문")).toBe(true);
  });
});
