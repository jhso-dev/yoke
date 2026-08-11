"use client";

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type * as React from "react";
import { DayPicker, getDefaultClassNames } from "react-day-picker";
import { cn } from "@/lib/utils";

// react-day-picker, restyled onto this product's own tokens the way every primitive in this
// directory is — theme.css already names --popover/--accent/--primary for both themes, so the
// calendar inherits dark mode and the terminal-adjacent look with no styling of its own. Sized to
// the app's 13px table density rather than shadcn's default; a date cell is a control, not a hero.
function Calendar({
  className,
  classNames,
  ...props
}: React.ComponentProps<typeof DayPicker>) {
  const d = getDefaultClassNames();
  return (
    <DayPicker
      data-slot="calendar"
      showOutsideDays
      className={cn("text-[13px]", className)}
      classNames={{
        months: cn(d.months, "relative"),
        month: cn(d.month, "space-y-2"),
        nav: cn(d.nav, "absolute inset-x-0 top-0 flex justify-between"),
        button_previous: cn(
          d.button_previous,
          "inline-flex size-6 items-center justify-center rounded-[var(--radius)] border border-border hover:border-primary",
        ),
        button_next: cn(
          d.button_next,
          "inline-flex size-6 items-center justify-center rounded-[var(--radius)] border border-border hover:border-primary",
        ),
        month_caption: cn(
          d.month_caption,
          "flex h-6 items-center justify-center text-[12px] font-semibold uppercase tracking-wide",
        ),
        weekdays: cn(d.weekdays, "text-[11px] uppercase text-muted-foreground"),
        weekday: cn(d.weekday, "w-7 pb-1 text-center font-medium"),
        day: cn(d.day, "p-0 text-center"),
        day_button: cn(
          "size-7 rounded-[var(--radius)] tabular-nums hover:bg-accent hover:text-accent-foreground",
          // The pointer is still ON the day the moment it is clicked, so an unconditional hover fill
          // sits over the selection fill and the click appears to do nothing. Inside a selected cell
          // the button yields to the cell's paint.
          "[td[data-selected=true]_&]:hover:bg-transparent! [td[data-selected=true]_&]:hover:text-inherit!",
        ),
        // Selection paints the CELL: react-day-picker puts `data-selected` (and the range_* classes)
        // on the td, not the button — a button-level aria-selected style here matches nothing and the
        // picked day gives no visual answer at all.
        today: cn(
          d.today,
          "font-bold text-primary data-[selected=true]:text-primary-foreground",
        ),
        outside: cn(d.outside, "text-muted-foreground opacity-50"),
        selected: cn(
          d.selected,
          "rounded-[var(--radius)] bg-primary text-primary-foreground",
        ),
        // Middle days also carry `selected`; the two background utilities tie on specificity, so the
        // band's quieter fill has to be important to hold against the endpoint fill.
        range_middle: cn(
          d.range_middle,
          "rounded-none! bg-accent! text-accent-foreground!",
        ),
        disabled: cn(d.disabled, "opacity-40"),
      }}
      components={{
        Chevron: ({ orientation }) =>
          orientation === "left" ? (
            <ChevronLeftIcon className="size-4" />
          ) : (
            <ChevronRightIcon className="size-4" />
          ),
      }}
      {...props}
    />
  );
}

export { Calendar };
