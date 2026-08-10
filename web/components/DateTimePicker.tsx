"use client";

import { CalendarIcon } from "lucide-react";
import { useState } from "react";
import type { DateRange } from "react-day-picker";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useT } from "../lib/i18n";

// Values are local wall time as `YYYY-MM-DDTHH:mm` (or "" unset) — exactly what datetime-local
// emitted, so `web/lib/time.ts`'s convention and every call site's URL state survive unchanged.

const pad = (n: number) => String(n).padStart(2, "0");
const dayOf = (local: string): Date | undefined =>
  local
    ? new Date(
        // From parts, never `new Date("YYYY-MM-DD")` — that parses as UTC midnight and shifts the
        // day in any zone east of it, the exact bug class time.ts exists to keep out.
        Number(local.slice(0, 4)),
        Number(local.slice(5, 7)) - 1,
        Number(local.slice(8, 10)),
      )
    : undefined;
const dateStr = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeOf = (local: string, fallback: string) =>
  local ? local.slice(11, 16) : fallback;

function Trigger({
  id,
  title,
  label,
}: {
  id?: string;
  title?: string;
  label: string;
}) {
  return (
    <PopoverTrigger asChild>
      <Button
        id={id}
        type="button"
        variant="secondary"
        title={title}
        className="border border-border font-normal tabular-nums hover:border-primary"
      >
        <CalendarIcon className="size-3.5 opacity-70" />
        {label}
      </Button>
    </PopoverTrigger>
  );
}

function Footer({
  resetLabel,
  onReset,
  onApply,
  canApply,
}: {
  resetLabel: string;
  onReset: () => void;
  onApply: () => void;
  canApply: boolean;
}) {
  const t = useT();
  return (
    <div className="mt-2 flex items-center gap-2 border-t border-border pt-2">
      {/* Same box as Apply (default size), so the pair reads as two actions rather than a link
          beside a button. `text-muted-foreground` rather than the hand-written `.muted` class: a
          primitive should not reach into globals.css for its colour. */}
      <Button
        type="button"
        variant="ghost"
        className="text-muted-foreground"
        onClick={onReset}
      >
        {resetLabel}
      </Button>
      {/* Nothing leaves this popover without Apply — a half-picked draft must not fire a query. */}
      <Button
        type="button"
        className="ml-auto"
        disabled={!canApply}
        onClick={onApply}
      >
        {t.common.apply}
      </Button>
    </div>
  );
}

/**
 * A point in time, confirmed explicitly.
 *
 * The popover edits a DRAFT: picking a day or a time changes nothing outside until Apply — an as-of
 * query re-running on every intermediate click both spams the backend and makes the URL lie about
 * what the person meant. The reset action lives INSIDE the popover (the caller names it — "Now" for
 * an as-of, since unset means the present), so there is exactly one place this control is operated.
 */
export function DateTimePicker({
  id,
  value,
  onChange,
  title,
  unsetLabel,
  resetLabel,
  disableFuture = false,
}: {
  id?: string;
  /** `YYYY-MM-DDTHH:mm` local wall time, or "" for unset. */
  value: string;
  onChange: (next: string) => void;
  title?: string;
  /** What the trigger says when unset — the MEANING of no value here ("Now", "Any time"). */
  unsetLabel: string;
  /** The in-popover action that returns to unset. */
  resetLabel: string;
  /**
   * Refuse days after today. For an as-of read that is not a nicety: nothing clamps a future
   * instant, so the query ran against now while the screen announced "this is what would have been
   * injected on <future date>" — a live answer labelled as a historical one.
   */
  disableFuture?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState<Date | undefined>();
  const [time, setTime] = useState("");

  const openWith = (next: boolean) => {
    if (next) {
      setDay(dayOf(value));
      setTime(
        timeOf(
          value,
          `${pad(new Date().getHours())}:${pad(new Date().getMinutes())}`,
        ),
      );
    }
    setOpen(next);
  };
  const commit = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={openWith}>
      <Trigger
        id={id}
        title={title}
        label={value ? value.replace("T", " ") : unsetLabel}
      />
      <PopoverContent className="w-auto">
        <Calendar
          mode="single"
          selected={day}
          onSelect={setDay}
          disabled={disableFuture ? { after: new Date() } : undefined}
        />
        <div className="mt-2 flex items-center gap-2">
          <Input
            type="time"
            aria-label={t.common.timeOfDay}
            value={time}
            disabled={!day}
            onChange={(e) => setTime(e.target.value)}
            className="w-auto tabular-nums"
          />
        </div>
        <Footer
          resetLabel={resetLabel}
          onReset={() => commit("")}
          onApply={() => day && commit(`${dateStr(day)}T${time || "00:00"}`)}
          canApply={!!day}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * A period — both bounds optional-ended is a lie for a range control, so: `from` required to apply,
 * `to` optional (an open-ended "since then"). Times default to the widest reading of the picked days
 * (00:00 and 23:59): a person dragging two dates means those whole days.
 */
export function DateRangePicker({
  id,
  value,
  onChange,
  title,
  unsetLabel,
  resetLabel,
  disableFuture = false,
}: {
  id?: string;
  /** Local wall time bounds; "" = unset. `to` may be "" while `from` is set (open-ended). */
  value: { from: string; to: string };
  onChange: (next: { from: string; to: string }) => void;
  title?: string;
  unsetLabel: string;
  resetLabel: string;
  /** Refuse days after today — see the note on DateTimePicker. */
  disableFuture?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<DateRange | undefined>();
  const [fromTime, setFromTime] = useState("00:00");
  const [toTime, setToTime] = useState("23:59");

  const openWith = (next: boolean) => {
    if (next) {
      setRange(
        value.from
          ? { from: dayOf(value.from), to: dayOf(value.to) }
          : undefined,
      );
      setFromTime(timeOf(value.from, "00:00"));
      setToTime(timeOf(value.to, "23:59"));
    }
    setOpen(next);
  };
  const commit = (next: { from: string; to: string }) => {
    onChange(next);
    setOpen(false);
  };
  // "onward" rather than a trailing tilde: clicking one day in a range calendar leaves `to` unset,
  // which is a legitimate open-ended window — but rendered as `2026-08-01 00:00 ~ ` it read as a
  // value someone had failed to finish.
  const label = value.from
    ? value.to
      ? `${value.from.replace("T", " ")} ~ ${value.to.replace("T", " ")}`
      : t.common.onward(value.from.replace("T", " "))
    : unsetLabel;

  return (
    <Popover open={open} onOpenChange={openWith}>
      <Trigger id={id} title={title} label={label} />
      <PopoverContent className="w-auto">
        <Calendar
          mode="range"
          selected={range}
          onSelect={setRange}
          disabled={disableFuture ? { after: new Date() } : undefined}
        />
        <div className="mt-2 grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1">
          <span className="muted text-[12px]">{t.common.startTime}</span>
          <Input
            type="time"
            aria-label={t.common.startTime}
            value={fromTime}
            disabled={!range?.from}
            onChange={(e) => setFromTime(e.target.value)}
            className="w-auto tabular-nums"
          />
          <span className="muted text-[12px]">{t.common.endTime}</span>
          <Input
            type="time"
            aria-label={t.common.endTime}
            value={toTime}
            disabled={!range?.to}
            onChange={(e) => setToTime(e.target.value)}
            className="w-auto tabular-nums"
          />
        </div>
        <Footer
          resetLabel={resetLabel}
          onReset={() => commit({ from: "", to: "" })}
          onApply={() =>
            range?.from &&
            commit({
              from: `${dateStr(range.from)}T${fromTime || "00:00"}`,
              to: range.to ? `${dateStr(range.to)}T${toTime || "23:59"}` : "",
            })
          }
          canApply={!!range?.from}
        />
      </PopoverContent>
    </Popover>
  );
}
