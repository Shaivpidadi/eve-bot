import { getJob } from "../jobs";
import type { Hands } from "../hands/types";
import { forgetRunTabs, readRunTabs } from "./screens";

const OVER = new Set(["done", "failed", "cancelled"]);

/**
 * Closes the tabs of runs whose jobs are over.
 *
 * Each run works in a tab of the team's one browser and records it (see
 * `noteRunTab`). Since eve 0.79 a run's session parks after its turn rather
 * than ending, so "the session ended" never comes to close it; the job closing
 * is what says the tab is done. A job still open (waiting for a sign-off, a
 * takeover, its next routine cycle) keeps its tab. Only tabs a run recorded are
 * ever closed, never one a person opened. Best-effort: a tab that will not
 * close is tried again next time.
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
    if (closed.ok) finished.push(targetId);
  }
  await forgetRunTabs(workspaceId, finished);
  return finished.length;
}
