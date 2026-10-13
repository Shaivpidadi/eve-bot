import { record } from "./activity";
import { getJob, key as jobKey } from "./jobs";
import { updateDoc } from "./store";
import type { Job } from "./types";

/**
 * Faults for the QA suite, behind `BOT_QA=1`.
 *
 * The things worth testing about a durable run are what happens when its
 * process dies or its machine is replaced, and neither can be done to a
 * deployment over its console API. These make the store look exactly as it
 * does after each of those, so the QA checks (and a person) can watch the
 * recovery: the watchdog re-dispatching a job, the next run restoring a
 * backup. Off unless the deployment opts in; never on by accident.
 */
export const qaEnabled = (env: Readonly<Record<string, string | undefined>> = process.env): boolean => env.BOT_QA === "1";

export type Crash =
  | {
      ok: true;
      job: Job;
      /** The lease token the dead run held. */
      token: string;
      /** Every session the dead run may still have: its bound one and the job's recorded one. */
      sessions: readonly string[];
    }
  | { ok: false; reason: string };

/**
 * Makes a job look as if the process running it died: its lease lapses at
 * once and names a token nobody holds, its bound session is dropped, and the
 * status stays what it was. The run that held it, if it is in fact still
 * alive, finds itself superseded at its next look and stops without writing;
 * the watchdog finds the job due with nothing waiting on it and dispatches a
 * fresh run. A job with no lease has no run to crash.
 */
export async function crashRun(workspaceId: string, jobId: string): Promise<Crash> {
  const outcome = { reason: `No job ${jobId} in this workspace.`, token: null as string | null, sessions: [] as string[] };
  const job = await updateDoc<Job>(jobKey(workspaceId, jobId), (current) => {
    if (current === null) return null;
    const lease = current.lease;
    if (lease === null) {
      outcome.reason =
        current.status === "cancelled" || current.status === "done" || current.status === "failed"
          ? `That job is ${current.status}; nothing is running it.`
          : "Nothing holds that job right now; there is no run to crash.";
      return null;
    }
    if (lease.token.startsWith("dead_")) {
      // Already crashed: a replayed call, or the same ask twice.
      outcome.token = lease.token;
      return null;
    }
    outcome.token = lease.token;
    outcome.sessions = [...new Set([lease.session, current.sessionId].filter((id): id is string => typeof id === "string" && id !== ""))];
    const { session: _dropped, ...rest } = lease;
    return {
      ...current,
      lease: { ...rest, token: `dead_${lease.token}`, until: new Date(0).toISOString() },
      updatedAt: new Date().toISOString(),
    };
  });
  const after = job ?? (outcome.token === null ? null : await getJob(workspaceId, jobId));
  if (after === null || outcome.token === null) return { ok: false, reason: outcome.reason };
  if (job !== null) {
    await record({
      workspaceId,
      kind: "job.crashed",
      botId: after.botId,
      jobId,
      text: `QA: the run working on "${after.title}" was crashed; its lease lapsed with nothing waiting on it.`,
      data: { token: outcome.token, sessions: outcome.sessions },
    });
  }
  return { ok: true, job: after, token: outcome.token.replace(/^dead_/, ""), sessions: outcome.sessions };
}
