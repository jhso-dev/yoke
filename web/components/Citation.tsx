"use client";

/** The audit citation, exactly as core built it.
 *
 * The string is never reassembled here: its format is pinned by core tests, and a client that
 * rebuilt it could drift from what the audit trail records. */
export function Citation({ value }: { value: string }) {
  return (
    <span className="cite" title="source and version — click to copy">
      <button
        type="button"
        className="cite"
        style={{
          border: "none",
          background: "none",
          padding: 0,
          cursor: "copy",
        }}
        onClick={() => navigator.clipboard?.writeText(value)}
      >
        {value}
      </button>
    </span>
  );
}
