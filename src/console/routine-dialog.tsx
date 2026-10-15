"use client";

import { type ReactNode, useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { api, errorMessage, SignedOutError } from "./api";
import type { Routine } from "./types";

const DAYS = [
  ["mon", "Mon"],
  ["tue", "Tue"],
  ["wed", "Wed"],
  ["thu", "Thu"],
  ["fri", "Fri"],
  ["sat", "Sat"],
  ["sun", "Sun"],
] as const;

type Day = (typeof DAYS)[number][0];

/** The browser's own timezone, which is almost always the operator's. */
const localTimezone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

/** Reads "every weekday at 09:00 (America/New_York)"-style text back into fields, best effort. */
function parseSchedule(text: string | undefined): { time: string; days: Day[]; timezone: string } | null {
  if (text === undefined) return null;
  const time = /(\d{1,2}):(\d{2})/.exec(text);
  if (time === null) return null;
  const hh = time[1]!.padStart(2, "0");
  const timezone = /\(([A-Za-z_]+\/[A-Za-z_+\-0-9]+)\)/.exec(text)?.[1] ?? localTimezone();
  const lower = text.toLowerCase();
  const days: Day[] = lower.includes("weekday") ? ["mon", "tue", "wed", "thu", "fri"] : DAYS.filter(([key]) => lower.includes(key)).map(([key]) => key);
  return { time: `${hh}:${time[2]}`, days, timezone };
}

/** A form field: its label over the control, in the dialog's quiet type. */
function FieldRow({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor} className="text-xs font-normal text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

const MODES = [
  { value: "interval", label: "every so many minutes" },
  { value: "clock", label: "at a time of day" },
] as const;

/**
 * Change or stop a routine from the console: how often it runs, or at what
 * time on which days, and its name. Stopping cancels the job; what it already
 * delivered stays.
 */
export function RoutineDialog({ routine, onClose, onChanged }: { routine: Routine | null; onClose: () => void; onChanged: () => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<"interval" | "clock">("interval");
  const [every, setEvery] = useState(60);
  const [time, setTime] = useState("09:00");
  const [days, setDays] = useState<Day[]>([]);
  const [timezone, setTimezone] = useState(localTimezone());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fieldId = useId();

  // Each routine opened fills the form from where it stands now.
  useEffect(() => {
    if (routine === null) return;
    setTitle(routine.title);
    const clock = parseSchedule(routine.schedule);
    if (clock !== null) {
      setMode("clock");
      setTime(clock.time);
      setDays(clock.days);
      setTimezone(clock.timezone);
    } else {
      setMode("interval");
      setEvery(routine.everyMinutes ?? 60);
      setDays([]);
      setTimezone(localTimezone());
    }
    setError(null);
  }, [routine]);

  const run = async (request: () => Promise<Response>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      const response = await request();
      if (!response.ok) {
        setError(await errorMessage(response, fallback));
        return;
      }
      await onChanged();
      onClose();
    } catch (caught) {
      if (!(caught instanceof SignedOutError)) setError(fallback);
    } finally {
      setBusy(false);
    }
  };

  const id = routine === null ? "" : encodeURIComponent(routine.jobId);

  return (
    <Dialog
      open={routine !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-[440px]">
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const body =
              mode === "clock"
                ? { title, dailyAt: time, onDays: days, timezone }
                : { title, dailyAt: null, everyMinutes: Math.max(5, Math.round(every)) };
            void run(() => api(`/bot/v1/jobs/${id}`, { method: "PATCH", body: JSON.stringify(body) }), "Could not change the routine.");
          }}
        >
          <DialogHeader>
            <DialogTitle>Routine</DialogTitle>
          </DialogHeader>
          <FieldRow label="Name" htmlFor={`${fieldId}-name`}>
            <Input id={`${fieldId}-name`} value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} required />
          </FieldRow>
          <FieldRow label="Runs">
            <Select items={MODES} value={mode} onValueChange={(value) => setMode(value === "clock" ? "clock" : "interval")}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODES.map((entry) => (
                  <SelectItem key={entry.value} value={entry.value}>
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
          {mode === "interval" ? (
            <FieldRow label="Every (minutes)" htmlFor={`${fieldId}-every`}>
              <Input
                id={`${fieldId}-every`}
                type="number"
                min={5}
                max={525_600}
                value={every}
                onChange={(event) => setEvery(Number(event.target.value))}
                required
              />
            </FieldRow>
          ) : (
            <>
              <FieldRow label="At" htmlFor={`${fieldId}-at`}>
                <Input id={`${fieldId}-at`} type="time" value={time} onChange={(event) => setTime(event.target.value)} required />
              </FieldRow>
              <div className="flex flex-wrap gap-x-2.5 gap-y-1.5" role="group" aria-label="Days">
                {DAYS.map(([key, label]) => (
                  <Label key={key} className="gap-1 text-[12.5px] font-normal">
                    <Checkbox
                      checked={days.includes(key)}
                      onCheckedChange={(checked) =>
                        setDays((current) => (checked ? [...current, key] : current.filter((day) => day !== key)))
                      }
                    />
                    {label}
                  </Label>
                ))}
              </div>
              <p className="m-0 text-[11.5px] text-faint">No days ticked means every day.</p>
              <FieldRow label="Timezone" htmlFor={`${fieldId}-tz`}>
                <Input id={`${fieldId}-tz`} value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder="America/New_York" required />
              </FieldRow>
            </>
          )}
          {error === null ? null : <p className="m-0 text-xs text-destructive">{error}</p>}
          <div className="flex items-center gap-2 pt-1">
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => void run(() => api(`/bot/v1/jobs/${id}`, { method: "DELETE" }), "Could not stop the routine.")}
            >
              Stop routine
            </Button>
            <span className="flex-1" />
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
