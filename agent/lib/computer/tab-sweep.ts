import { handsFor } from "../hands";
import { getJob } from "../jobs";
import type { Hands } from "../hands/types";
import { computerControl } from "./control";
import { forgetRunTabs, readRunTabs, runSessionName } from "./screens";

const OVER = new Set(["done", "failed", "cancelled"]);

/**
 * Closes the tabs of runs whose jobs are over.
 *
 * Each run works in a tab of the team's one browser and records it (see
 * `noteRunTab`). Since eve 0.79 a run's session parks after its turn rather
 * than ending, so "the session ended" never comes to close it; the job closing
 * is what says the tab is done. A job still open (waiting for a sign-off, a
 * takeover, its next routine cycle) keeps its tab. Only tabs a run recorded are
 * ever closed, never one a person opened. The run's agent-browser session
 * goes with its tab, and the recording it made with it. Best-effort: a tab that
 * will not close is tried again next time.
 */
export async function closeFinishedTabs(workspaceId: string, hands: Pick<Hands, "browser">, keep?: string): Promise<number> {
  const tabs = await readRunTabs(workspaceId);
  const finished: string[] = [];
  for (const [targetId, tab] of Object.entries(tabs)) {
    if (targetId === keep) continue;
    const job = await getJob(workspaceId, tab.jobId).catch(() => undefined);
    if (job === undefined) continue;
    if (job !== null && !OVER.has(job.status)) continue;
    const closed = await hands.browser.close(tab.n, targetId).catch(() => ({ ok: false }));
    if (!closed.ok) continue;
    await hands.browser.endRun(runSessionName(tab.sessionId)).catch(() => undefined);
    finished.push(targetId);
  }
  await forgetRunTabs(workspaceId, finished);
  return finished.length;
}

/**
 * The same sweep as a job ends (`run_job`): a run's turn settles before its job
 * is marked over, so the run's own pass (the teammate's tabs hook) keeps the
 * tab, and without this it would wait for another Bot's run. Only a computer
 * that is already running is touched.
 */
export async function sweepFinishedTabs(workspaceId: string): Promise<number> {
  const control = computerControl();
  if ((await control.availability()).state !== "running") return 0;
  const io = await control.io();
  return io === null ? 0 : closeFinishedTabs(workspaceId, handsFor(io));
}
