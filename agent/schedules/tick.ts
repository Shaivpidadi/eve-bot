import { defineSchedule } from "eve/schedules";

import { repairAllReservations } from "../lib/budget";
import { reapIdleScreens } from "../lib/computer/reaper";
import { chargeComputerRuntime } from "../lib/computer-spend";
import { dispatchDue } from "../lib/dispatch";
import { sendToRoomAs } from "../lib/room-delivery";
import { deliverNotes } from "../lib/teammail";

/**
 * The watchdog that keeps the team always-on.
 *
 * Runs keep their own time: `run_job` sleeps durably until a job is due. So
 * this is a safety net, not the clock. It finds work that is due with nothing
 * waiting on it — a run cancelled while it slept, a repeat nobody re-armed, a
 * run whose lease lapsed because a deploy or crash interrupted it — claims each
 * job, and wakes HQ in the job's room to run it (see `lib/dispatch.ts`, which
 * a sweep on start and from the console runs too).
 *
 * Daily by default, because that is as often as Vercel Hobby runs cron jobs.
 * On Pro, `BOT_TICK_CRON="* * * * *"` picks up stragglers within a minute.
 */
export default defineSchedule({
  cron: process.env.BOT_TICK_CRON ?? "17 6 * * *",
  run({ to, waitUntil, appAuth }) {
    waitUntil(
      dispatchDue((job, message) => sendToRoomAs(to, appAuth, job.workspaceId, job.room, message)).then((outcome) => {
        // One line per pass, so a server log shows the watchdog is alive.
        console.log(
          `[bot] watchdog: ${outcome.due} due, ${outcome.dispatched} dispatched${outcome.stranded > 0 ? `, ${outcome.stranded} stranded by a restart` : ""}, ${outcome.ms}ms`,
        );
      }),
    );
    // Teammates' notes to each other that no console pass delivered yet.
    waitUntil(
      deliverNotes((workspaceId, room, message) => sendToRoomAs(to, appAuth, workspaceId, room, message)).catch(() => 0),
    );
    // Browsers nobody is using are stopped; they start again on the next use.
    waitUntil(reapIdleScreens().catch(() => 0));
    // Budget held by runs that died before settling goes back (admission also
    // repairs on demand, so a daily tick is enough).
    waitUntil(repairAllReservations().catch(() => 0));
    // The computer's finished sessions go on the workspace budget, each once.
    waitUntil(chargeComputerRuntime().catch(() => 0));
  },
});
