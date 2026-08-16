import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

const alertVariants = cva(
  "relative grid w-full grid-cols-[0_1fr] items-start gap-y-0.5 rounded-lg border px-4 py-3 text-sm has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] has-[>svg]:gap-x-3 [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground",
        destructive:
          "bg-card text-destructive *:data-[slot=alert-description]:text-destructive/90 [&>svg]:text-current",
        // The page-level notice. A tighter box than `default` on purpose: these are one sentence
        // above a table, whereas `default` is an inline result panel with a title. The three kinds
        // reuse the lifecycle tones so a warning on any screen is the colour a draft record already
        // is.
        //
        // `block` is not cosmetic. The base is a two-column GRID sized for an icon and an
        // AlertTitle/AlertDescription pair, and a notice whose child is a plain sentence turns every
        // WORD into a grid item — one word per line, measured. These carry text, so they lay out as
        // text.
        error:
          "mb-3 block rounded-[var(--radius)] border-[var(--tone-deprecated)] bg-[var(--tone-deprecated-bg)] px-3 py-[9px] text-[13px] text-[var(--tone-deprecated)]",
        warn: "mb-3 block rounded-[var(--radius)] border-[var(--tone-draft)] bg-[var(--tone-draft-bg)] px-3 py-[9px] text-[13px] text-[var(--tone-draft)]",
        info: "mb-3 block rounded-[var(--radius)] border-border bg-secondary px-3 py-[9px] text-[13px]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

/**
 * `role="alert"` is an assertive live region, so it belongs only on the variants that report
 * something that just happened. On every variant it would make a standing panel — the login screen's
 * two `yoke token create` commands, present from first paint — interrupt a screen reader before the
 * reader has reached the field. A static panel is content, not an alert.
 */
const ANNOUNCES: Record<string, boolean> = {
  error: true,
  warn: true,
  destructive: true,
};

function Alert({
  className,
  variant,
  role,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role={role ?? (variant && ANNOUNCES[variant] ? "alert" : undefined)}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "col-start-2 line-clamp-1 min-h-4 font-medium tracking-tight",
        className,
      )}
      {...props}
    />
  );
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "col-start-2 grid justify-items-start gap-1 text-sm text-muted-foreground [&_p]:leading-relaxed",
        className,
      )}
      {...props}
    />
  );
}

export { Alert, AlertDescription, AlertTitle };
