import type { ToolContext } from "eve/tools";

import { MAX_LARGE_ARTIFACT_BYTES, saveLargeArtifact } from "../../../lib/artifacts";
import { COMPUTER_SCRIPT } from "../../../lib/computer/script";
import { toolHands } from "../../../lib/hands";
import { attachArtifact } from "../../../lib/jobs";
import { operator } from "../../../lib/session";
import { effectiveEnv } from "../../../lib/settings/store";
import type { JobArtifact } from "../../../lib/types";
import { journal } from "./journal";
import { sessionState } from "./session-state";

/**
 * A video of a job's browser work (`BOT_BROWSER_RECORDING`), through
 * agent-browser's `record`: started with the run's first browser action,
 * stopped when the Bot finishes the job, and kept with the job's files.
 *
 * What it can show: Chrome paints only the tab in front, so the video moves
 * while this run's tab is on the screen and holds still while another Bot's
 * is. A job that ends any other way (cancelled, failed) has its tab closed and
 * its agent-browser session ended (the teammate's tabs hook, or the tab sweep),
 * which stops the recording; that video is not kept.
 *
 * agent-browser hands frames to ffmpeg, which the computer installs the first
 * time a recording is wanted (`bot-computer recorder`), in the background: the
 * first job after turning this on starts recording once that is done.
 */

export const RECORDING_FILE = "browser.webm";
/** A timeline more than a film: actions read clearly, and an hour stays small. */
const FPS = "2";
/** Longer than this, the recording stops; the job goes on. */
export const MAX_RECORDING_MS = 30 * 60_000;
/** How often a run whose computer is still installing ffmpeg asks again. */
const RECHECK_MS = 60_000;

export const recordingOn = (env: Readonly<Record<string, string | undefined>>): boolean => /^(1|on|true|yes)$/i.test(env.BOT_BROWSER_RECORDING?.trim() ?? "");

type Recording = { readonly state: "waiting"; readonly checkedAt: number } | { readonly state: "on"; readonly startedAt: number } | { readonly state: "stopped" };

const recordings = sessionState<Recording>();

/** Runs one agent-browser command in this run's tab; failures come back as data. */
export type RunInTab = (args: readonly string[]) => Promise<{ readonly ok: boolean; readonly output: string; readonly error?: string }>;

/** What to do next for a run's recording. Pure, for tests. */
export function nextStep(current: Recording | undefined, now: number): "nothing" | "check" | "stop" {
  if (current === undefined) return "check";
  if (current.state === "stopped") return "nothing";
  if (current.state === "waiting") return now - current.checkedAt >= RECHECK_MS ? "check" : "nothing";
  return now - current.startedAt > MAX_RECORDING_MS ? "stop" : "nothing";
}

/**
 * Called before each browser action once the run's tab is ready: starts the
 * recording when it is on and ffmpeg is there, and stops one that has run too
 * long. Never fails the action.
 */
export async function keepRecording(ctx: ToolContext, run: RunInTab, directory: string): Promise<void> {
  if (!recordingOn(await effectiveEnv())) return;
  const now = Date.now();
  const step = nextStep(recordings.get(ctx.session.id), now);
  if (step === "nothing") return;
  if (step === "stop") {
    await run(["record", "stop"]);
    recordings.set(ctx.session.id, { state: "stopped" });
    await journal(ctx, { kind: "progress", text: "Stopped recording the browser: it reached 30 minutes." });
    return;
  }
  const asked = await (await toolHands(ctx)).shell.run(`${COMPUTER_SCRIPT} recorder`, { timeoutMs: 20_000 });
  if (!/"ready":true/.test(asked.stdout)) {
    recordings.set(ctx.session.id, { state: "waiting", checkedAt: now });
    return;
  }
  const started = await run(["record", "start", `${directory}/${RECORDING_FILE}`, "--fps", FPS]);
  // Already recording: this process restarted while the run went on.
  if (started.ok || /already active/i.test(`${started.output} ${started.error ?? ""}`)) {
    recordings.set(ctx.session.id, { state: "on", startedAt: now });
  } else {
    recordings.set(ctx.session.id, { state: "waiting", checkedAt: now });
  }
}

/**
 * At the end of a job: stops the run's recording, if it made one, and keeps it
 * with the job's files. A run that never used the browser is not touched, so
 * finishing a job never starts a screen.
 */
export async function keepJobRecording(ctx: ToolContext, jobId: string, directory: string, stop: () => Promise<unknown>): Promise<JobArtifact | null> {
  const path = `${directory}/${RECORDING_FILE}`;
  const sandbox = await ctx.getSandbox();
  // Another process may have started it, so the file is what says there is one. It
  // can still be empty: ffmpeg writes only once it has frames, so a short run's
  // video appears when the recording stops.
  const exists = await sandbox.run({ command: `test -e '${path.replaceAll("'", "")}'` });
  if (exists.exitCode !== 0) return null;
  if (recordings.get(ctx.session.id)?.state !== "stopped") await stop();
  recordings.set(ctx.session.id, { state: "stopped" });

  const bytes = await sandbox.readBinaryFile({ path });
  await sandbox.run({ command: `rm -f '${path.replaceAll("'", "")}'` });
  if (bytes === null || bytes.byteLength === 0) return null;
  if (bytes.byteLength > MAX_LARGE_ARTIFACT_BYTES) {
    await journal(ctx, { kind: "progress", text: `The browser recording was not kept: ${Math.round(bytes.byteLength / 1_048_576)} MB is over the 50 MB limit.` }, jobId);
    return null;
  }
  const { workspaceId } = operator(ctx);
  const artifact = await saveLargeArtifact({ workspaceId, name: "Browser recording.webm", mediaType: "video/webm", bytes });
  const attached = await attachArtifact(workspaceId, jobId, artifact, ctx.session.id);
  if (!attached.ok) return null;
  await journal(ctx, { kind: "artifact", text: "Saved the browser recording", data: { id: artifact.id, name: artifact.name } }, jobId);
  return artifact;
}
