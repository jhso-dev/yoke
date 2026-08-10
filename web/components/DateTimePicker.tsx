"use client";

import { CalendarIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useT } from "../lib/i18n";

/**
 * A date + time control over the app's own calendar, replacing `<input type="datetime-local">` —
 * the last OS-styled control in the product, and the one whose popup ignored the theme entirely.
 *
 * The VALUE contract is unchanged: local wall time as `YYYY-MM-DDTHH:mm`, or "" for unset — exactly
 * what datetime-local emitted, so the URL round-trip convention (`web/lib/time.ts`, "the control's
 * vocabulary is local wall time") and both call sites' state handling survive untouched. This is a
 * rendering swap, not a semantics change.
 *
 * Time is a separate small field beside the calendar rather than a second popover: picking an
 * instant is one gesture on this screen ("that afternoon"), and a time wheel would be more chrome
 * than the 5 characters it replaces.
 */
export function DateTimePicker({
  id,
  value,
  onChange,
  title,
}: {
  id?: string;
  /** `YYYY-MM-DDTHH:mm` local wall time, or "" for unset. */
  value: string;
  onChange: (next: string) => void;
  title?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [datePart, timePart] = value ? value.split("T") : ["", ""];
  const selected = datePart
    ? // Constructed from parts: `new Date("YYYY-MM-DD")` parses as UTC midnight and shifts the day
      // in any zone east of it — the exact bug class time.ts exists to keep out.
      new Date(
        Number(datePart.slice(0, 4)),
        Number(datePart.slice(5, 7)) - 1,
        Number(datePart.slice(8, 10)),
      )
    : undefined;

  const pad = (n: number) => String(n).padStart(2, "0");
  const pick = (day: Date | undefined) => {
    if (!day) {
      onChange("");
      return;
    }
    const date = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
    // A fresh pick defaults the time to now's wall clock — "as of that day, about now" is the
    // useful reading; midnight would silently exclude the day's own events.
    const now = new Date();
    onChange(
      `${date}T${timePart || `${pad(now.getHours())}:${pad(now.getMinutes())}`}`,
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="secondary"
          title={title}
          className="border border-border font-normal tabular-nums hover:border-primary"
        >
          <CalendarIcon className="size-3.5 opacity-70" />
          {value ? value.replace("T", " ") : t.common.anyTime}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto">
        <Calendar mode="single" selected={selected} onSelect={pick} />
        <div className="mt-2 flex items-center gap-2 border-t border-border pt-2">
          <Input
            type="time"
            aria-label={t.common.timeOfDay}
            value={timePart}
            disabled={!datePart}
            onChange={(e) =>
              datePart &&
              e.target.value &&
              onChange(`${datePart}T${e.target.value}`)
            }
            className="w-auto tabular-nums"
          />
          <Button
            type="button"
            variant="ghost"
            size="text"
            className="muted ml-auto"
            onClick={() => {
              onChange("");
              setOpen(false);
            }}
          >
            {t.common.clear}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
