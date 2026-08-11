import type * as React from "react";

import { cn } from "@/lib/utils";

// A plain element, no Radix: a textarea needs no behaviour, only this project's field styling so it
// sits beside Input without looking borrowed. Exists because the one thing typed into this app that
// is a paragraph rather than a line — why a record was retired — was being asked for in an Input,
// where a three-sentence reason scrolls sideways one word at a time.
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-[var(--radius)] border border-input bg-transparent px-2.5 py-1.5 text-[13px] shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/30",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
