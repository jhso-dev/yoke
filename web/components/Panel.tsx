import { Card, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * The workbench's box: a titled surface holding a table, a form row, or a result list.
 *
 * This is `Card`, composed once. The screens were written against a hand-written `.panel` class,
 * and globals.css has always called that migration debt — but converting the call sites to bare
 * `Card` meant re-encoding four COUPLED css rules as utilities at every one of thirty-odd sites
 * (`.panel`'s own box, the 14px gap between consecutive panels, the 12px inset that `.panel >
 * .controls` gave a control row, and the pager's inset). Utility soup repeated thirty times is how
 * the thirty-first drifts, so the coupling lives here instead, in one component, on the primitive.
 *
 * What the call sites get is what they had: `<Panel>` and `<PanelHead>`, no class strings.
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
        "[&>[data-slot=alert]]:mx-3 [&>[data-slot=alert]]:mb-3",
        className,
      )}
      {...props}
    />
  );
}

/** The panel's title bar. A row, not a stacked header — the count and the note sit beside the name. */
export function PanelHead({
  className,
  ...props
}: React.ComponentProps<typeof CardHeader>) {
  return (
    <CardHeader
      className={cn(
        "flex flex-row items-center gap-2.5 border-b border-border bg-secondary px-3 py-[9px] text-[13px] font-semibold",
        className,
      )}
      {...props}
    />
  );
}
