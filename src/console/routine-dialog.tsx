"use client";

import { useEffect, useRef, useState } from "react";

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

/**
 * Change or stop a routine from the console: how often it runs, or at what
 * time on which days, and its name. Stopping cancels the job; what it already
 * delivered stays.
 */
export function RoutineDialog({ routine, onClose, onChanged }: { routine: Routine | null; onClose: () => void; onChanged: () => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<"interval" | "clock">("interval");
  const [every, setEvery] = useState(60);
  const [time, setTime] = useState("09:00");
  const [days, setDays] = useState<Day[]>([]);
  const [timezone, setTimezone] = useState(localTimezone());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (routine !== null && !element.open) {
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
      element.showModal();
    } else if (routine === null && element.open) {
      element.close();
    }
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

  if (routine === null) return <dialog ref={dialog} onClose={onClose} className="routine-dialog" />;
  const id = encodeURIComponent(routine.jobId);

  return (
    <dialog ref={dialog} onClose={onClose} className="routine-dialog">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const body =
            mode === "clock"
              ? { title, dailyAt: time, onDays: days, timezone }
              : { title, dailyAt: null, everyMinutes: Math.max(5, Math.round(every)) };
          void run(() => api(`/bot/v1/jobs/${id}`, { method: "PATCH", body: JSON.stringify(body) }), "Could not change the routine.");
        }}
      >
        <h2>Routine</h2>
        <label>
          Name
          <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} required />
        </label>
        <label>
          Runs
          <select value={mode} onChange={(event) => setMode(event.target.value as "interval" | "clock")}>
            <option value="interval">every so many minutes</option>
            <option value="clock">at a time of day</option>
          </select>
        </label>
        {mode === "interval" ? (
          <label>
            Every (minutes)
            <input type="number" min={5} max={525_600} value={every} onChange={(event) => setEvery(Number(event.target.value))} required />
          </label>
        ) : (
          <>
            <label>
              At
              <input type="time" value={time} onChange={(event) => setTime(event.target.value)} required />
            </label>
            <div className="routine-days" role="group" aria-label="Days">
              {DAYS.map(([key, label]) => (
                <label key={key} className="routine-day">
                  <input
                    type="checkbox"
                    checked={days.includes(key)}
                    onChange={(event) => setDays((current) => (event.target.checked ? [...current, key] : current.filter((day) => day !== key)))}
                  />
                  {label}
                </label>
              ))}
            </div>
            <p className="faint">No days ticked means every day.</p>
            <label>
              Timezone
              <input value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder="America/New_York" required />
            </label>
          </>
        )}
        {error === null ? null : <p className="error-text">{error}</p>}
        <div className="actions">
          <button
            type="button"
            className="btn danger"
            disabled={busy}
            onClick={() => void run(() => api(`/bot/v1/jobs/${id}`, { method: "DELETE" }), "Could not stop the routine.")}
          >
            Stop routine
          </button>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </dialog>
  );
}
