import { BUDGET_HALT_REASON } from "../../../lib/budget";
import { sessionBinding } from "../../../lib/computer/screens";
import { getJob } from "../../../lib/jobs";
import { CANCELLED_STOP_REASON } from "../../../lib/run-stop";

import { sessionState } from "./session-state";

/**
 * Why a Bot's session must make no further model call, or null.
 *
 * Two things stop a run between its steps: its job was cancelled, and the
 * workspace budget halted it (`hooks/usage.ts` marks that after a step). Both
 * are checked twice per step, each time before a model call can be made:
 *
 * - by the teammate's dynamic model on `step.started` (`agent.ts`), which eve
 *   runs before it compacts a long history, so a stopped run does not pay for
 *   a compaction either (a throw there fails the step as a model selection);
 * - by the `fence` and `usage` hooks on `step.started`, which eve runs after
 *   compaction and before the model request (a throw there fails the turn).
 *
 * A job read made for one is reused by the other for the same step (eve gives
 * both the step's turn, index and sequence). A read that fails lets the step
 * through: the refusals on every write and guarded action still hold.
 */
const halted = sessionState<true>();
const cancelled = sessionState<true>();
const jobs = sessionState<string>();
const lastLook = sessionState<{ readonly step: string; readonly cancelled: boolean }>();

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
  const recent = lastLook.get(sessionId);
  const isCancelled = step !== null && recent?.step === step ? recent.cancelled : await jobIsCancelled(sessionId, workspace);
  if (step !== null) lastLook.set(sessionId, { step, cancelled: isCancelled });
  if (!isCancelled) return null;
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
