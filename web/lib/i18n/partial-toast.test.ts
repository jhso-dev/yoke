// W-TOAST: the partial-commit toast used to classify `unrecorded` by `startsWith("relates_to")`
// alone, collapsed to one boolean. But core emits THREE labels (src/core/commit.ts) —
// `conflicts_with -> …`, `authored_by -> …`, `relates_to -> …` — each with a DIFFERENT remedy:
//   - relates_to  → a --scope attachment: must be re-linked
//   - authored_by → an authorship edge: re-derives with `yoke backfill`
//   - conflicts_with → a contradiction marker: NO backfill re-derives it
// So a conflict loss was mislabelled as an authorship loss (sent to backfill, which cannot re-derive
// a contradiction), and an authorship loss riding alongside an attachment loss was silently dropped.
//
// Tested at the i18n level with the exact label strings core produces — no React, so it runs in the
// react-free suite (imports en.ts/ko.ts directly, never the .tsx barrel).

import { describe, expect, it } from "vitest";
import { en } from "./en";
import { ko } from "./ko";

// The exact prefixes core emits, followed by an id (`<label> -> <id>`).
const RELATES = "relates_to -> 01ABC";
const AUTHORED = "authored_by -> person:x";
const CONFLICT = "conflicts_with -> 01DEF";

describe("W-TOAST: partial-commit toast names each remedy", () => {
  it("relates_to → re-link, and not backfill", () => {
    const msg = en.create.partial("R", [RELATES]);
    expect(msg).toContain("link it again");
    expect(msg).not.toContain("backfill");
  });

  it("authored_by → backfill", () => {
    const msg = en.create.partial("R", [AUTHORED]);
    expect(msg).toContain("yoke backfill");
    expect(msg).not.toContain("link it again");
  });

  it("conflicts_with → its own message, NOT backfill as the remedy", () => {
    const msg = en.create.partial("R", [CONFLICT]);
    expect(msg).toContain("contradiction");
    // The honest claim: backfill does NOT re-derive a conflict. It may name backfill only to deny it.
    expect(msg).toContain("backfill does not re-derive conflicts");
    expect(msg).not.toContain("re-derive it with yoke backfill");
    expect(msg).not.toContain("link it again");
  });

  it("an authorship loss alongside an attachment loss is not dropped", () => {
    // The old boolean showed ONLY the attachment message; both remedies must now appear.
    const msg = en.create.partial("R", [RELATES, AUTHORED]);
    expect(msg).toContain("link it again");
    expect(msg).toContain("yoke backfill");
  });

  it("all three at once each get a clause", () => {
    const msg = en.create.partial("R", [RELATES, AUTHORED, CONFLICT]);
    expect(msg).toContain("link it again");
    expect(msg).toContain("yoke backfill");
    expect(msg).toContain("contradiction");
  });

  it("an unknown label is reported, never rendered as an unqualified success", () => {
    const msg = en.create.partial("R", ["future_edge -> 01X"]);
    expect(msg).toContain("NOT recorded");
    // The label still ends as a partial-commit sentence, not a bare "created".
    expect(msg).toContain("Saved");
  });

  it("ko classifies the same three labels (Hangul, same structure)", () => {
    expect(ko.create.partial("R", [RELATES])).toContain("다시 연결");
    expect(ko.create.partial("R", [AUTHORED])).toContain("yoke backfill");
    const conflict = ko.create.partial("R", [CONFLICT]);
    expect(conflict).toContain("상충");
    expect(conflict).toContain("backfill은 상충을 재생성하지 않습니다");
  });
});
