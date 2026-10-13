import type { ToolContext } from "eve/tools";

import { sessionBinding } from "../../../lib/computer/screens";
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
    await appendJournal(workspaceId, target, ctx.session.id, entry);
  } catch {
    // A diary line is never worth failing the work for.
  }
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
