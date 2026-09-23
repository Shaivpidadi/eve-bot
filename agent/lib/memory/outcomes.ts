import { record } from "../activity";
import { getBot } from "../bots";
import { getJob } from "../jobs";
import type { JobResult } from "../types";
import { capture, type CaptureResult, defaultDeps } from "./capture";
import { trace } from "./provider";
import { fieldFor } from "./store";

/**
 * Learning from what a person did, not only from what they said.
 *
 * Sending a job back with a note, and declining an action a Bot asked
 * approval for, are the strongest signals a person gives about how they want
 * things done, and they arrive without anyone saying "remember". Each runs
 * through the same gatekeeper pipeline as a conversation, with its own
 * questions: does the note say something general, does the decline imply a
 * rule. Nothing here may fail the job or the approval it hangs off.
 */

/** A note on a job sent back for changes: what does it say about how this person wants work done? */
export async function learnFromFeedback(workspaceId: string, jobId: string, note: string, result: JobResult | null): Promise<CaptureResult | null> {
  try {
    const job = await getJob(workspaceId, jobId);
    if (job === null || note.trim() === "") return null;
    const bot = await getBot(workspaceId, job.botId);
    await trace(workspaceId, "profile", "capturing", `feedback on ${jobId}: ${note.length} chars`);
    const outcome = await capture(
      {
        workspaceId,
        mode: "feedback",
        person: note,
        reply: [`Job: ${job.title}`, `Brief: ${job.brief.slice(0, 2_000)}`, result === null ? "" : `Result: ${result.summary}\n${result.deliverable.slice(0, 2_000)}`].join("\n"),
        source: { who: "auto", name: bot?.name, room: job.room, jobId },
        operationId: `feedback:${jobId}:${job.attempts}:${hash(note)}`,
      },
      defaultDeps(workspaceId),
    );
    await trace(workspaceId, "profile", "done", describe(outcome));
    await announce(workspaceId, job.botId, jobId, outcome, `From your note on "${job.title}"`);
    return outcome;
  } catch (error) {
    await trace(workspaceId, "profile", "failed", `feedback: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** A declined approval: does saying no here amount to a standing rule? */
export async function learnFromDenial(
  workspaceId: string,
  denial: { readonly jobId: string; readonly botId: string; readonly requestId: string; readonly toolName: string; readonly prompt: string; readonly input: unknown },
): Promise<CaptureResult | null> {
  try {
    const job = await getJob(workspaceId, denial.jobId);
    const bot = await getBot(workspaceId, denial.botId);
    const input = denial.input === undefined ? "" : JSON.stringify(denial.input).slice(0, 800);
    await trace(workspaceId, "craft", "capturing", `denial of ${denial.toolName} on ${denial.jobId}`);
    const outcome = await capture(
      {
        workspaceId,
        mode: "denial",
        person: [`The person declined this action: ${denial.toolName}`, denial.prompt.slice(0, 1_000), input === "" ? "" : `Arguments: ${input}`].join("\n"),
        reply: job === null ? "" : [`Job: ${job.title}`, `Brief: ${job.brief.slice(0, 2_000)}`].join("\n"),
        source: { who: "auto", name: bot?.name, room: job?.room ?? null, jobId: denial.jobId },
        operationId: `denial:${denial.jobId}:${denial.requestId}`,
      },
      defaultDeps(workspaceId),
    );
    await trace(workspaceId, "craft", "done", describe(outcome));
    await announce(workspaceId, denial.botId, denial.jobId, outcome, `From declining ${denial.toolName}`);
    return outcome;
  } catch (error) {
    await trace(workspaceId, "craft", "failed", `denial: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

const describe = (outcome: CaptureResult) =>
  `gate=${outcome.gate} proposed=${outcome.proposed} saved=${outcome.saved.length} updated=${outcome.updated.length} retired=${outcome.retired.length} fields=${outcome.fields.length}${outcome.error === undefined ? "" : ` extractor failed: ${outcome.error}`}`;

/** Tells the thread what was learned, the same way the capture hook does. */
async function announce(workspaceId: string, botId: string, jobId: string, outcome: CaptureResult, lead: string): Promise<void> {
  const changed = [...outcome.saved, ...outcome.updated, ...outcome.retired];
  if (changed.length + outcome.fields.length === 0) return;
  const parts = [
    outcome.fields.length === 0 ? null : `Noted: ${outcome.fields.map((change) => `${fieldFor(change.slot, change.field)?.label ?? change.field} is ${change.value}`).join(" · ")}`,
    outcome.saved.length === 0 ? null : `Remembered: ${outcome.saved.map((entry) => entry.text).join(" · ")}`,
    outcome.updated.length === 0 ? null : `Updated: ${outcome.updated.map((entry) => entry.text).join(" · ")}`,
    outcome.retired.length === 0 ? null : `No longer true: ${outcome.retired.map((entry) => entry.text).join(" · ")}`,
  ].filter((part): part is string => part !== null);
  await record({
    workspaceId,
    kind: "memory.saved",
    botId,
    jobId,
    text: `${lead} — ${parts.join(" — ")}`,
    data: { slots: [...new Set([...changed, ...outcome.fields].map((item) => item.slot))], ids: changed.map((entry) => entry.id), gate: outcome.gate },
  }).catch(() => undefined);
}

/** A short stable digest, so the same note captured twice writes once. */
function hash(text: string): string {
  let value = 0;
  for (let index = 0; index < text.length; index += 1) value = (value * 31 + text.charCodeAt(index)) >>> 0;
  return value.toString(36);
}
