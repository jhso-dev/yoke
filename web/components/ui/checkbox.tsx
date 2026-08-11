"use client";

import { CheckIcon, MinusIcon } from "lucide-react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

// Written in this directory's style — a plain function with `data-slot`, importing the unified
// `radix-ui` package — rather than pasted from the registry, which still ships the older
// forwardRef/`@radix-ui/react-checkbox` shape. No new dependency: `radix-ui` is already here for
// Label, Dialog, Select and Button's Slot.
//
// The indeterminate state is a first-class value, which is the reason this replaces the native input
// cleanly rather than approximately. A native checkbox has no attribute for it — `indeterminate` is a
// DOM property only — so the review queue's header box had to reach for the node with a ref and set it
// imperatively after render. Radix takes `checked="indeterminate"`, so "some of these rows are
// selected" becomes a value the component renders instead of a side effect on a DOM node.
function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        // The dark: checked overrides are load-bearing, not belt-and-braces: `dark:bg-input/30` ties
        // with `data-[state=checked]:bg-primary` on specificity and lands later in the stylesheet,
        // so without them a checked box in dark mode kept the input background and drew its check in
        // dark-on-dark — state invisible exactly where the state is the point.
        "peer size-4 shrink-0 rounded-[4px] border border-input shadow-xs transition-shadow outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/30 dark:data-[state=checked]:bg-primary dark:data-[state=indeterminate]:bg-primary dark:aria-invalid:ring-destructive/40",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current transition-none"
      >
        {props.checked === "indeterminate" ? (
          <MinusIcon className="size-3.5" />
        ) : (
          <CheckIcon className="size-3.5" />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
