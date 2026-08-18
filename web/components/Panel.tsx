import { Card, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * The workbench's box: a titled surface holding a table, a form row, or a result list.
 *
 * This is `Card`, composed once. Four rules are COUPLED — the box, the 14px gap between consecutive
 * panels, the 12px inset on a control row, and the pager's inset — and restating them as utilities
 * at thirty-odd call sites is how the thirty-first drifts. They live here instead, on the primitive.
 *
 * What the call sites write is `<Panel>` and `<PanelHead>`, no class strings.
 */
export function Panel({
  className,
  ...props
}: React.ComponentProps<typeof Card>) {
  return (
    <Card
      data-panel=""
      className={cn(
        // `gap-0` + `py-0`: Card's default is a padded stack of sections, and these hold a
        // full-bleed table whose header must meet the border.
        "gap-0 overflow-hidden rounded-[var(--radius)] border-border bg-card py-0 shadow-none",
        // The gap belongs between consecutive panels, which is where `.panel + .panel` put it.
        "[&+[data-panel]]:mt-[14px]",
        // A control row inside a panel is inset; the pager is the same row by another name.
        "[&>.controls]:m-0 [&>.controls]:p-3 [&>.controls+.controls]:pt-0",
        // And a notice inside a panel is inset too, so its border does not land on the panel's.
        // `w-auto` undoes the alert base's `w-full`: 100% width plus the side margins is 24px of
        // right edge clipped off by this panel's `overflow-hidden`. Top margin only on the notice
        // that directly follows the title bar — `mb-3` already spaces notice-to-notice, and a
        // blanket top margin would double that gap.
        "[&>[data-slot=alert]]:mx-3 [&>[data-slot=alert]]:mb-3 [&>[data-slot=alert]]:w-auto",
        "[&>[data-slot=card-header]+[data-slot=alert]]:mt-3",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The panel's title bar. A row, not a stacked header — the count and the note sit beside the name.
 *
 * `border-b-[1px]`, never `border-b`. CardHeader carries `[.border-b]:pb-6`, which compiles to a
 * two-class compound ON THE HEADER ITSELF (`.[.border-b]:pb-6.border-b`), not a descendant selector
 * — so writing `border-b` silently claims 24px of bottom padding that a single-class `py-*` cannot
 * outrank, and the title bar grows to 53px with its text sitting off-centre. Same width, same
 * colour, no hidden padding.
 */
export function PanelHead({
  className,
  ...props
}: React.ComponentProps<typeof CardHeader>) {
  return (
    <CardHeader
      className={cn(
        "flex flex-row items-center gap-2.5 border-b-[1px] border-border bg-secondary px-3 py-[9px] text-[13px] font-semibold",
        className,
      )}
      {...props}
    />
  );
}
