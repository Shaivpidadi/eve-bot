import { BUDGET_HALT_REASON } from "../../../lib/budget";
import { sessionBinding } from "../../../lib/computer/screens";
import { getJob } from "../../../lib/jobs";
import { CANCELLED_STOP_REASON } from "../../../lib/run-stop";

import { sessionState } from "./session-state";

/**
 * Why a Bot's session must make no further model call, or null.
 *
 * Two things stop a run between its steps: its job was cancelled, and the
 * workspace budget halted it (`hooks/usage.ts` marks that after a step). The
 * teammate's dynamic model checks both on every `step.started` (`agent.ts`),
 * which eve runs before the model call and before it compacts a long history;
 * a throw there fails the step as a model selection, so a stopped run pays for
 * neither. (eve 0.68 stopped letting a throwing hook end a turn, so this is the
 * only check inside the session.) `run_job` also cancels the Bot's turn when
 * its look at the job finds it cancelled or halted. A read that fails lets the
 * step through: the refusals on every write and guarded action still hold.
 */
const halted = sessionState<true>();
const cancelled = sessionState<true>();
const jobs = sessionState<string>();

/** Which step a `step.started` event is for, from its data; null when it does not say. */
export function stepOf(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const { turnId, stepIndex, sequence } = data as { turnId?: unknown; stepIndex?: unknown; sequence?: unknown };
  return typeof turnId === "string" && typeof stepIndex === "number" ? `${turnId}:${stepIndex}:${String(sequence)}` : null;
}

/** The budget halted this session's run (set by the usage hook). */
export function markHalted(sessionId: string): void {
  halted.set(sessionId, true);
}

export function isHalted(sessionId: string): boolean {
  return halted.get(sessionId) === true;
}

export async function stopReason(sessionId: string, workspace: () => string, step: string | null = null): Promise<string | null> {
  if (halted.get(sessionId) === true) return BUDGET_HALT_REASON;
  if (cancelled.get(sessionId) === true) return CANCELLED_STOP_REASON;
  void step;
  if (!(await jobIsCancelled(sessionId, workspace))) return null;
  cancelled.set(sessionId, true);
  return CANCELLED_STOP_REASON;
}

async function jobIsCancelled(sessionId: string, workspace: () => string): Promise<boolean> {
  try {
    const workspaceId = workspace();
    let jobId = jobs.get(sessionId);
    if (jobId === undefined) {
      const binding = await sessionBinding(workspaceId, sessionId);
      if (binding === null) return false;
      jobId = binding.jobId;
      jobs.set(sessionId, jobId);
    }
    return (await getJob(workspaceId, jobId))?.status === "cancelled";
  } catch {
    return false;
  }
}
