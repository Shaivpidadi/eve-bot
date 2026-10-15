import { listActions, type Action } from "./actions";
import { record } from "./activity";
import { getBot } from "./bots";
import { generationFor, listGenerations, restoreGeneration, scopeFor } from "./generations";
import type { Hands } from "./hands/types";
import { getJob, rewindJob } from "./jobs";
import type { Job } from "./types";

/**
 * "Rewind to here" on a job (plan item D5.2), everything but the session
 * handling, which only a channel route can do: what cannot be undone is
 * listed, the record goes back, and the job's files are restored.
 */
export interface RewindOutcome {
  readonly job: Job;
  readonly sessions: readonly string[];
  /** The step whose saved files were restored, or why none were. */
  readonly files: { readonly restoredFrom: number } | { readonly skipped: string };
  /** Outward actions after the point, which the next run is told not to repeat. */
  readonly kept: readonly string[];
}

const DONE: readonly Action["state"][] = ["succeeded", "delivery_unknown", "executing"];

/** Emails (and later, other outward actions) the job sent at or after `cutoff`: these stay done. */
export function keptActions(actions: readonly Action[], jobId: string, cutoff: string): string[] {
  return actions
    .filter((action) => action.jobId === jobId && action.createdAt >= cutoff && DONE.includes(action.state))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((action) => `${action.kind === "email.send" ? "Sent an email" : action.kind} to ${action.target.join(", ")} (${action.state === "succeeded" ? "sent" : "possibly sent"}, ${action.createdAt.slice(0, 16).replace("T", " ")} UTC)`);
}

export async function rewind(
  input: { readonly workspaceId: string; readonly jobId: string; readonly index: number; readonly by: string },
  hands: () => Promise<Pick<Hands, "files"> | null>,
): Promise<{ ok: true; outcome: RewindOutcome } | { ok: false; reason: string }> {
  const current = await getJob(input.workspaceId, input.jobId);
  if (current === null) return { ok: false, reason: `No job ${input.jobId} in this workspace.` };
  const journal = current.journal ?? [];
  const cutoff = journal[input.index]?.at ?? new Date().toISOString();
  const kept = keptActions(await listActions(input.workspaceId), input.jobId, cutoff);

  const rewound = await rewindJob(input.workspaceId, input.jobId, input.index, input.by, kept);
  if (!rewound.ok) return rewound;

  let files: RewindOutcome["files"];
  const generation = generationFor(await listGenerations(input.workspaceId, input.jobId), input.index);
  const bot = await getBot(input.workspaceId, rewound.before.botId);
  if (generation === null) files = { skipped: "No saved files at or before that step." };
  else if (bot === null) files = { skipped: "The job's Bot is no longer on the roster." };
  else {
    try {
      const machine = await hands();
      if (machine === null) files = { skipped: "The computer is not running." };
      else {
        await restoreGeneration(machine, generation, scopeFor(rewound.before, bot.name));
        files = { restoredFrom: generation.index };
      }
    } catch (error) {
      files = { skipped: error instanceof Error ? error.message : String(error) };
    }
  }

  await record({
    workspaceId: input.workspaceId,
    kind: "job.rewound",
    botId: rewound.job.botId,
    jobId: input.jobId,
    text:
      `${input.by} took "${rewound.job.title}" back to step ${input.index}` +
      ("restoredFrom" in files ? `; its files are as they were at step ${files.restoredFrom}` : `; files not restored (${files.skipped})`) +
      (kept.length > 0 ? `; ${kept.length} outward action(s) stay done` : "") +
      ".",
    data: { index: input.index, undone: journal.length - input.index, ...("restoredFrom" in files ? { restoredFrom: files.restoredFrom } : {}) },
  });
  return { ok: true, outcome: { job: rewound.job, sessions: rewound.sessions, files, kept } };
}
