"use client";

import { CircleIcon } from "lucide-react";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

// House style (function + `data-slot` + the unified `radix-ui` package) rather than the registry's
// older forwardRef shape, and no new dependency.

function RadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      className={cn("grid gap-3", className)}
      {...props}
    />
  );
}

/**
 * One option. Draws the dot by default; with children it draws them instead.
 *
 * That fallback is what lets a **segmented control** be a radio group rather than a lookalike built
 * from buttons. The review queue's two views are one choice between two states, and a radio group is
 * what a screen reader announces as such with no aria bookkeeping — the reason the markup it replaces
 * used radios and hid them off-screen behind styled labels. Radix supplies the roles and the arrow-key
 * handling; the segment appearance travels on `className` at that one call site, so nothing here has a
 * variant invented for a single user.
 */
function RadioGroupItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        // `dark:bg-input/30` needs a `dark:data-[state=checked]:` counterpart for the same reason
        // Checkbox does: the two tie on specificity and the dark rule lands later in the sheet, so
        // without it a SELECTED segment of the review queue's control lost its fill in dark mode —
        // the one thing distinguishing which queue you are looking at. A call site that wants a
        // different checked fill still overrides this, because it composes after.
        "aspect-square size-4 shrink-0 rounded-full border border-input shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/30 dark:data-[state=checked]:bg-secondary dark:aria-invalid:ring-destructive/40",
        className,
      )}
      {...props}
    >
      {children ?? (
        <RadioGroupPrimitive.Indicator
          data-slot="radio-group-indicator"
          className="relative flex items-center justify-center"
        >
          <CircleIcon className="absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 fill-primary" />
        </RadioGroupPrimitive.Indicator>
      )}
    </RadioGroupPrimitive.Item>
  );
}

export { RadioGroup, RadioGroupItem };
