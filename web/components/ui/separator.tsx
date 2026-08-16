"use client";

import { Separator as SeparatorPrimitive } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

// House style (function + `data-slot` + the unified `radix-ui` package), and no new dependency —
// `radix-ui` is already here for Label, Dialog, Select, Checkbox, RadioGroup and Popover.
//
// One divider for the whole app, so the next one is not another hand-written span with slightly
// different numbers. `decorative` is the default and the reason to use the primitive at all: Radix
// then sets `aria-hidden`, so a rule that carries no meaning stays out of the accessibility tree
// rather than being announced as a separator.
function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-4 data-[orientation=vertical]:w-px",
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
