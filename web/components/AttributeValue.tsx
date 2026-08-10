import { isDocument } from "../lib/markdown";
import { Markdown } from "./Markdown";

/**
 * One stored attribute value, read the way it was written.
 *
 * Three shapes, because the ontology declares three (`string`, `string[]`, and the numbers/booleans
 * that fall through). Each is rendered as what it is: a blanket `JSON.stringify` turns a decision's
 * rejected alternatives — arguably the most-read field in the model, since it is what a decision
 * record exists to preserve — into `["안 1","안 2"]`, and a multi-section postmortem into one
 * collapsed paragraph.
 *
 * Shared rather than private to the entity screen, because the collaboration screen rendered its own
 * `typeof v === "string" ? v : JSON.stringify(v)` — the exact thing this exists to prevent. A second
 * copy of a rendering rule is a second answer to the same question.
 */
export function AttributeValue({ value }: { value: unknown }) {
  if (typeof value === "string")
    return isDocument(value) ? <Markdown text={value} /> : value;
  if (Array.isArray(value) && value.every((x) => typeof x === "string"))
    return (
      <div className="md">
        <ul>
          {value.map((x: string, i) => {
            // Position is the only identity these have, and two rejected alternatives can read the
            // same; the stored order is the author's, so it never reorders.
            const key = `${i}:${x}`;
            return <li key={key}>{x}</li>;
          })}
        </ul>
      </div>
    );
  return JSON.stringify(value);
}
