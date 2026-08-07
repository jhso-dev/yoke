import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

// The box is the workbench's status pill, not shadcn's default badge — `1px 7px`, 11px, 600 weight,
// 4px gap. It used to be `.pill` in globals.css, with the tone colours hung off a `data-tone`
// attribute; this is the same CSS, one layer down, so a status renders identically and there is one
// definition of what a badge looks like here.
//
// The `tone` variants are the product's own: a lifecycle status is never colour alone (StatusBadge
// pairs each with a label and a glyph — an accessibility basic, not a simplification), and each tone
// carries a second, non-colour signal on purpose. Draft is dashed because it is provisional, stale is
// italic because it is no longer trusted, deprecated is struck through because it is retired. Those
// survive a monochrome screenshot and colour blindness; the hue does not.
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1 rounded-full border border-transparent px-[7px] py-px text-[11px] font-semibold whitespace-nowrap transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
        secondary:
          "bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
        destructive:
          "bg-destructive text-white focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40 [a&]:hover:bg-destructive/90",
        outline:
          "border-border text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        ghost: "[a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        link: "text-primary underline-offset-4 [a&]:hover:underline",
        /** Staged, not verified — withheld from injection. Dashed border: provisional. */
        draft:
          "border-dashed border-[var(--tone-draft)] bg-[var(--tone-draft-bg)] text-[var(--tone-draft)]",
        /** A human promoted it; agents may receive it. */
        verified: "bg-[var(--tone-verified-bg)] text-[var(--tone-verified)]",
        /** Past its type's TTL. Italic: no longer trusted. */
        stale: "bg-[var(--tone-stale-bg)] text-[var(--tone-stale)] italic",
        /** Retired, never injected. Struck through. */
        deprecated:
          "bg-[var(--tone-deprecated-bg)] text-[var(--tone-deprecated)] line-through",
        /** A status this build does not recognise — shown as itself rather than hidden. */
        unknown: "bg-[var(--tone-unknown-bg)] text-[var(--tone-unknown)]",
        /** The box only: inherits its colour. The graph legend's type chips. */
        plain: "",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span";

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
