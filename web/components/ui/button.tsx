import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-default disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        // yoke's own size, and the default — see the note above the component. Sits between
        // shadcn's `xs` (24px, too small to hit) and `sm` (32px, taller than the 13px table text
        // it labels). The 13px matches that table text exactly.
        compact:
          "h-7 gap-1.5 rounded-md px-2.5 text-[13px] has-[>svg]:px-2 [&_svg:not([class*='size-'])]:size-3.5",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        /** Interactive text, not a box. The two copy-on-click affordances — a record's own id on the
         * entity screen, and a citation — are prose a reader clicks, and every boxed size would draw a
         * button where the design has a word. Font and colour are inherited so the caller's
         * `.mono`/`.muted`/`.cite` still decide how it reads.
         *
         * `inline-block` and `whitespace-normal` are load-bearing: the variant base is `inline-flex`
         * with `whitespace-nowrap`, and a bare <button> is neither. globals.css also targets
         * `.persona-card .cite button` directly, and unlayered CSS beats every utility set here, so this
         * variant deliberately sets as little as possible and lets that rule keep winning. */
        text: "inline-block h-auto rounded-none p-0 text-left font-[inherit] font-normal text-[inherit] tracking-[inherit] whitespace-normal hover:bg-transparent",
        icon: "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      // Kept in step with the parameter default below, which is the one that actually decides.
      size: "compact",
    },
  },
);

// `size = "compact"` (h-7, 13px text), not shadcn's `"default"` (h-9): this is a dense workbench
// where body text is 14px and table cells 13px, and a 36px button dominated every control bar.
// 28px is under the 44px touch-target guideline — the deliberate trade for a desktop tool driven by
// a mouse, with a keyboard path to every button. Pass `size="sm"`/`"default"` where a call site
// wants a larger target.
//
// The parameter default is what decides, NOT cva's `defaultVariants` — an explicit value here means
// cva never sees `undefined` and never applies its own. Editing only the cva block does nothing.
function Button({
  className,
  variant = "default",
  size = "compact",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
