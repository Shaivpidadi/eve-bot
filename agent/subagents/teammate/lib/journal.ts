import type { ToolContext } from "eve/tools";

import { sessionBinding } from "../../../lib/computer/screens";
import { getBot } from "../../../lib/bots";
import { takeGeneration } from "../../../lib/generations";
import { toolHands } from "../../../lib/hands";
import { appendJournal } from "../../../lib/jobs";
import type { NewEntry } from "../../../lib/journal";
import { operator } from "../../../lib/session";
import { sessionState } from "./session-state";

/**
 * The teammate's side of the job journal (see `lib/journal.ts`): one call
 * from any tool, which finds the run's job through its screen binding and
 * writes under the run fence. A session bound to no job, a superseded run,
 * or a store that is down writes nothing and never fails the step: the
 * diary is for the next run and the operator, not a condition of this one.
 */
export async function journal(ctx: ToolContext, entry: NewEntry, jobId?: string): Promise<void> {
  try {
    const { workspaceId } = operator(ctx);
    const target = jobId ?? (await sessionBinding(workspaceId, ctx.session.id))?.jobId;
    if (target === undefined || target === null) return;
    const written = await appendJournal(workspaceId, target, ctx.session.id, entry);
    // A decision is a point worth going back to.
    if (written.ok && entry.kind === "decision") await markPoint(ctx, written.job.id, "decision");
  } catch {
    // A diary line is never worth failing the work for.
  }
}

/**
 * Saves what the job owns as it is now, at the journal's current length, so a
 * person can rewind the job to this point (see `lib/generations.ts`). Bounded
 * and best-effort: a point that cannot be saved is a point that cannot be
 * rewound to, never a failed step.
 */
export async function markPoint(ctx: ToolContext, jobId?: string, reason = "point"): Promise<void> {
  try {
    const { workspaceId } = operator(ctx);
    const target = jobId ?? (await sessionBinding(workspaceId, ctx.session.id))?.jobId;
    if (target === undefined || target === null) return;
    const { getJob } = await import("../../../lib/jobs");
    const job = await getJob(workspaceId, target);
    if (job === null || job.lease?.session !== ctx.session.id) return;
    const bot = await getBot(workspaceId, job.botId);
    if (bot === null) return;
    const hands = await toolHands(ctx);
    await Promise.race([
      takeGeneration(hands, { workspaceId, job, botName: bot.name, index: (job.journal ?? []).length, reason }),
      new Promise((resolve) => setTimeout(resolve, 60_000)),
    ]);
  } catch (error) {
    console.warn(`[bot] could not save a rewind point: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Rewind points being saved, per run. A model can ask for several tools in one
 * step, which run side by side: "decided: write b next" alongside the write of
 * b. The decision's point must be the files before that write, so the tools
 * that change files wait for a point in flight (see `holdPoint`) first.
 */
const savingPoint = sessionState<Promise<void>>();

/**
 * Marks that a point is about to be saved for this run. Call it before the first
 * `await` of the tool that saves it: tools of one step start in the order the
 * model asked for them, so a write asked for after it then waits.
 */
export function holdPoint(ctx: ToolContext): () => void {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = savingPoint.get(ctx.session.id) ?? Promise.resolve();
  const chained = previous.then(() => held);
  savingPoint.set(ctx.session.id, chained);
  return () => {
    release();
    if (savingPoint.get(ctx.session.id) === chained) savingPoint.delete(ctx.session.id);
  };
}

/** Waits for a rewind point this run is saving, before a tool changes files. */
export async function afterPoint(ctx: ToolContext): Promise<void> {
  await savingPoint.get(ctx.session.id);
}

/** The address each run last recorded, so a page is journaled once per visit and not per action on it. */
const lastPage = sessionState<string>();

/** Records that the run's tab is on `url`, when that is news. */
export async function journalPage(ctx: ToolContext, url: string, title: string | null = null): Promise<void> {
  const clean = url.trim().slice(0, 500);
  if (clean === "" || clean === "about:blank" || lastPage.get(ctx.session.id) === clean) return;
  lastPage.set(ctx.session.id, clean);
  let where = clean;
  try {
    const parsed = new URL(clean);
    where = title ? `${title} (${parsed.host})` : `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`.slice(0, 160);
  } catch {
    // Not a web address; the text is the address itself.
  }
  await journal(ctx, { kind: "page", text: `Opened ${where}`, data: { url: clean, ...(title ? { title } : {}) } });
}

/** Forgets the last page, for a run whose tab was replaced. */
export function forgetPage(ctx: ToolContext): void {
  lastPage.delete(ctx.session.id);
}
