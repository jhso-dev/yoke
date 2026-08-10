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
          "aria-selected:bg-primary aria-selected:text-primary-foreground",
        ),
        today: cn(d.today, "font-bold text-primary"),
        outside: cn(d.outside, "text-muted-foreground opacity-50"),
        selected: cn(d.selected, "rounded-[var(--radius)]"),
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
