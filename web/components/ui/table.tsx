"use client";

import type * as React from "react";

import { cn } from "@/lib/utils";

// The workbench's table, not shadcn's defaults. shadcn ships `text-sm` cells with `h-10 px-2` heads
// and middle alignment; this screen's tables are 13px with 11px uppercase heads, `8px 12px` padding
// and top alignment, which is what every screenshot of this product shows. The values live HERE and
// not in globals.css as bare `table`/`th`/`td` element rules, because an UNLAYERED element rule beats
// a Tailwind utility regardless of specificity — element rules would make this component unusable,
// overriding every class it sets, and importing it would change nothing.
//
// Same pixels, one definition, and a call site can override a cell with a className the
// way it can everywhere else.
//
// Two rules deliberately stay in globals.css, because both are call-site concerns rather than
// defaults: `td.num` (tabular numerals on a numeric column) and the `.md table` block, which narrows
// a table rendered from stored markdown and drops its uppercase heads. Those keep working for the
// same reason the element rules had to go — unlayered CSS still wins over these utilities.

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div data-slot="table-container" className="w-full overflow-x-auto">
      <table
        data-slot="table"
        className={cn("w-full border-collapse text-[13px]", className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={className} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      // The last row of the BODY drops its rule, so a table never draws a line against the panel
      // border below it. `tr:last-child td` did this before; scoping it to the body is the same
      // result on every table here and stops depending on the table's last element being a row.
      className={cn("[&_tr:last-child>td]:border-b-0", className)}
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return <tfoot data-slot="table-footer" className={className} {...props} />;
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return <tr data-slot="table-row" className={className} {...props} />;
}

/** The shared cell box: `8px 12px`, left-aligned, top-aligned, one hairline below. */
const CELL = "border-b border-border px-3 py-2 text-left align-top";

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        CELL,
        "text-[11px] font-semibold tracking-[0.06em] whitespace-nowrap text-muted-foreground uppercase",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td data-slot="table-cell" className={cn(CELL, className)} {...props} />
  );
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
};
