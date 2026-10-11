import type { SessionContext } from "eve/context";

import { sessionBinding } from "./computer/screens";
import { checkRun, describeRunRefusal, type RunCheck } from "./jobs";
import { operator } from "./session";

/** The slice of a teammate tool's context the guard reads: who it works for and which session it is. */
export type RunContext = { readonly session: Pick<SessionContext["session"], "id" | "auth"> };

export type Guard = (RunCheck & { ok: true; jobId: string }) | (Exclude<RunCheck, { ok: true }> & { jobId: string | null; message: string });

/**
 * Refuses a side effect when the calling teammate is no longer its job's run.
 *
 * A run that outlived its lease keeps its session and its tools, so without
 * this it could still send the email or submit the form after a fresh run took
 * the job over, and both would. Call it right before anything that changes the
 * world outside the job record and stop on `ok: false`, handing the model
 * `message`. Writes to the job record itself go through `patchJobAsRun`, which
 * checks and writes in one step; this is a read, so it narrows the window
 * rather than closing it.
 *
 * The job is the one `job_brief` bound this session to (see `bindScreen`), so
 * the model need not pass it; a `jobId` given explicitly is checked instead.
 *
 * Cancellation and approvals: a cancelled job refuses here (`cancelled`), and
 * that is what invalidates an approval granted before or during the cancel.
 * eve runs `execute` only once a person approves, possibly long after the
 * request, so a tool behind an approval gate must call this inside `execute`,
 * after the approval, never only before asking. `cancelJobRun` also retires
 * the run's session when its caller can (see `lib/cancel.ts`), which drops the
 * pending request outright; this check is what holds when it cannot.
 */
export async function guardSideEffect(ctx: RunContext, jobId?: string): Promise<Guard> {
  const { workspaceId } = operator(ctx);
  const target = jobId ?? (await sessionBinding(workspaceId, ctx.session.id))?.jobId ?? null;
  if (target === null) {
    return {
      ok: false,
      reason: "unbound",
      jobId: null,
      message: "Call job_brief with the jobId and runToken from your briefing message first.",
    };
  }
  const check = await checkRun(workspaceId, target, ctx.session.id);
  return check.ok
    ? { ...check, jobId: target }
    : { ...check, jobId: target, message: describeRunRefusal(check.reason, target) };
}
