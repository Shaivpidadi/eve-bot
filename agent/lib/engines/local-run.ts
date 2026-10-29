import { getBot } from "../bots";
import { checkpointComputerFor, ensureComputerRestoredFor } from "../computer-backup";
import { computerControl } from "../computer/control";
import { killRunCommand, runCommand } from "../computer/shell";
import { bindRun, describeRunRefusal, getJob } from "../jobs";
import { publicOrigin } from "../self";
import { effectiveEnv } from "../settings/store";
import { deleteDoc, readDoc, writeDoc } from "../store";
import { harnessBuiltins, harnessInstructions } from "./harness-options";
import { ENGINE_NAMES, type LocalEngine } from "./index";
import {
  installCommand,
  launchCommand,
  type LocalRunRecord,
  lookResult,
  newRunId,
  newRunSecret,
  parseLook,
  readCommand,
  runDir,
  runSecretHash,
  runSecretKey,
  signIn,
  toolsUrl,
} from "./local";
import type { HarnessLook, HarnessStart } from "./sessions";

/**
 * The plan engines' runs on the team's computer (see `./local` for what they
 * are): started, looked at and stopped from `run_job`'s steps through
 * `./sessions`, as a durable-harness session is.
 */

const encoder = new TextEncoder();

/** Which secret a run was given, so stopping it can forget the secret. */
const byRunKey = (runId: string) => `engine-runs/by-run/${runId}.json`;

/** The Bot's own folder on the computer, as its eve jobs use it (see `generations.ts`). */
const botFolder = (name: string) => `/workspace/bots/${name.replace(/[^A-Za-z0-9 _.-]/g, "").trim() || "bot"}`;

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export async function startLocalRun(
  engine: LocalEngine,
  input: { readonly workspaceId: string; readonly jobId: string; readonly token: string; readonly brief: string },
): Promise<HarnessStart> {
  const name = ENGINE_NAMES[engine];
  const env = await effectiveEnv(input.workspaceId);
  const login = signIn(engine, env);
  if (login === null) return { ok: false, error: `${name} has no sign-in saved (Settings → Engines).` };
  const io = await computerControl().io().catch(() => null);
  if (io === null) return { ok: false, error: `The team's computer starts with the first job an eve Bot runs, and it has not started yet. Give an eve Bot something to do once, then run this again.` };

  const installed = await io.run(installCommand(engine), { timeoutMs: 600_000 });
  if (installed.exitCode !== 0) return { ok: false, error: `Could not install ${name} on the team's computer: ${(installed.stdout + installed.stderr).trim().slice(-400)}` };

  const runId = newRunId();
  const bound = await bindRun(input.workspaceId, input.jobId, input.token, runId);
  if (!bound.ok) return { ok: false, error: describeRunRefusal(bound.reason, input.jobId) };
  // A replaced computer gets its files back before the run touches them, as an eve Bot's job brief does.
  await ensureComputerRestoredFor(input.workspaceId, io);

  // The run's secret: its MCP calls act for this job's run, and nothing else, until it stops.
  const secret = newRunSecret();
  const hash = runSecretHash(secret);
  const record: LocalRunRecord = { workspaceId: input.workspaceId, jobId: input.jobId, runId, engine, at: new Date().toISOString() };
  await writeDoc(runSecretKey(hash), record);
  await writeDoc(byRunKey(runId), { hash });

  const job = await getJob(input.workspaceId, input.jobId);
  const bot = job === null ? null : await getBot(input.workspaceId, job.botId);
  const folder = botFolder(bot?.name ?? "bot");
  const dir = runDir(runId);
  const prepared = await io.run(
    [
      `mkdir -p ${quote(dir)} ${quote(folder)}`,
      `if getent group bot-team >/dev/null 2>&1; then chgrp bot-team ${quote(dir)} ${quote(folder)} 2>/dev/null || true; fi`,
      `chmod 2770 ${quote(dir)}; chmod g+rwXs ${quote(folder)} 2>/dev/null || true`,
    ].join("; "),
    { timeoutMs: 30_000 },
  );
  if (prepared.exitCode !== 0) return { ok: false, error: `Could not prepare the run's folder on the computer: ${prepared.stderr.trim().slice(-300)}` };

  const instructions = [
    harnessInstructions(env),
    "You run in a terminal session that ends with your turn: anything a person must approve (an email, a connector change) is decided after you finish, so say in your result that it is waiting for approval.",
  ].join("\n");
  const files: Record<string, string> = {
    "brief.md": input.brief,
    "instructions.md": instructions,
    "prompt.md": `${instructions}\n\n${input.brief}`,
  };
  // Codex keeps its sign-in in its home: the run's own, so it is gone with the run (and read back for a refreshed one).
  for (const [path, text] of Object.entries(login.files)) files[path.replace(/^\.codex\//, "codex-home/")] = text;
  if (Object.keys(login.files).length > 0) await io.run(`mkdir -p ${quote(`${dir}/codex-home`)} && chmod 2770 ${quote(`${dir}/codex-home`)}`, { timeoutMs: 15_000 });
  for (const [path, text] of Object.entries(files)) await io.writeBinaryFile(`${dir}/${path}`, encoder.encode(text));
  await io.run(`chmod -R g+rw ${quote(dir)}`, { timeoutMs: 15_000 });

  const base = (await publicOrigin()) ?? `http://localhost:${process.env.PORT ?? "3000"}`;
  const launch = launchCommand({
    engine,
    runId,
    workingDirectory: folder,
    brief: input.brief,
    instructions,
    toolsUrl: toolsUrl(base, env),
    secret,
    model: (engine === "claude-code-local" ? env.BOT_LOCAL_CLAUDE_MODEL : env.BOT_LOCAL_CODEX_MODEL)?.trim() || null,
    builtins: harnessBuiltins(env),
    env: login.env,
  });
  const runEnv: Record<string, string> = {
    ...login.env,
    BOT_RUN_SECRET: secret,
    ...(Object.keys(login.files).length > 0 ? { CODEX_HOME: `${dir}/codex-home` } : {}),
  };
  const started = await io.run(runCommand(launch, { workingDirectory: folder, env: runEnv, runId }), { timeoutMs: 30_000 });
  if (started.exitCode !== 0) {
    await forget(runId);
    return { ok: false, error: `Could not start ${name} on the team's computer: ${(started.stdout + started.stderr).trim().slice(-400)}` };
  }
  return { ok: true, sessionId: runId };
}

/** What the run wrote since `cursor` (a byte offset into its event stream), and whether it ended. */
export async function lookAtLocalRun(engine: LocalEngine, runId: string, cursor: string | null): Promise<HarnessLook> {
  const offset = Number(cursor ?? 0) || 0;
  const io = await computerControl().io().catch(() => null);
  if (io === null) return { kind: "working", cursor, spend: [], said: [], partial: "", heard: cursor };
  const read = await io.run(readCommand(runId, offset), { timeoutMs: 30_000 });
  const look = parseLook(read.stdout, offset);
  let result = lookResult(look, "");
  if (look.ended && look.outcome === null && look.exitCode !== 0) {
    // How the turn ended may have been read on an earlier look: the stream's last lines say it again, else the CLI's errors.
    const tail = await io.run(`tail -c 16384 ${quote(`${runDir(runId)}/events.jsonl`)} 2>/dev/null | tail -n +2`, { timeoutMs: 15_000 });
    const earlier = parseLook(`exit:${look.exitCode}\n---\n${tail.stdout}`, 0).outcome;
    const stderr = earlier === null ? (await io.run(`tail -c 2000 ${quote(`${runDir(runId)}/stderr.log`)} 2>/dev/null`, { timeoutMs: 15_000 })).stdout : "";
    result = earlier?.ok === false ? { kind: "ended", ok: false, error: earlier.error ?? "The turn failed." } : lookResult(look, stderr);
  }
  const env = await effectiveEnv().catch(() => process.env);
  // Spend: what the CLI says the turn cost where a key pays for it; a plan's turn costs nothing here, and still counts.
  const paid = signIn(engine, env)?.paid ?? false;
  const spend = look.outcome === null ? [] : [{ usd: paid ? (look.outcome.usd ?? 0) : 0, model: look.outcome.model ?? ENGINE_NAMES[engine] }];
  const heard = String(look.cursor);
  // The run's work is backed up as it goes, and once more when it ends, as an eve Bot's progress notes and finish do.
  const workspaceId = (await recordOf(runId))?.workspaceId;
  if (workspaceId !== undefined) await checkpointComputerFor(workspaceId, io, result.kind === "working" ? {} : { minIntervalMs: 60_000 });
  return result.kind === "working"
    ? { kind: "working", cursor: heard, spend, said: look.said, partial: "", heard }
    : result.ok
      ? { kind: "ended", ok: true, spend, said: look.said, partial: "", heard }
      : { kind: "ended", ok: false, error: result.error, spend, said: look.said, partial: "", heard };
}

/**
 * Stops the run for good: whatever is left of the CLI and what it started is
 * killed (they share the run's process group), its secret is forgotten, and a
 * Codex sign-in the CLI refreshed while it ran is kept for the next one.
 */
export async function stopLocalRun(engine: LocalEngine, runId: string): Promise<void> {
  const io = await computerControl().io().catch(() => null);
  if (io !== null) {
    await io.run(killRunCommand(runId), { timeoutMs: 20_000 }).catch(() => undefined);
    if (engine === "codex-local") await keepRefreshedCodexSignIn(io, runId).catch(() => undefined);
    await io.run(`rm -rf ${quote(`${runDir(runId)}/codex-home`)}`, { timeoutMs: 15_000 }).catch(() => undefined);
  }
  await forget(runId);
}

async function recordOf(runId: string): Promise<LocalRunRecord | null> {
  const by = (await readDoc<{ hash: string }>(byRunKey(runId)).catch(() => null))?.value;
  return by === undefined ? null : ((await readDoc<LocalRunRecord>(runSecretKey(by.hash)).catch(() => null))?.value ?? null);
}

async function forget(runId: string): Promise<void> {
  const by = (await readDoc<{ hash: string }>(byRunKey(runId)).catch(() => null))?.value;
  if (by !== undefined) await deleteDoc(runSecretKey(by.hash)).catch(() => undefined);
  await deleteDoc(byRunKey(runId)).catch(() => undefined);
}

/** Codex rewrites `auth.json` when it refreshes its sign-in; the saved copy follows, or the next run would sign in with a spent one. */
async function keepRefreshedCodexSignIn(io: NonNullable<Awaited<ReturnType<ReturnType<typeof computerControl>["io"]>>>, runId: string): Promise<void> {
  const read = await io.run(`cat ${quote(`${runDir(runId)}/codex-home/auth.json`)} 2>/dev/null`, { timeoutMs: 15_000 });
  const now = read.stdout.trim();
  if (read.exitCode !== 0 || now === "") return;
  const env = await effectiveEnv();
  if (now === env.BOT_LOCAL_CODEX_AUTH?.trim()) return;
  try {
    JSON.parse(now);
  } catch {
    return;
  }
  const { saveSettings } = await import("../settings/store");
  await saveSettings({ workspaceId: env.BOT_DEFAULT_WORKSPACE ?? "default", owner: true, by: "codex" }, { BOT_LOCAL_CODEX_AUTH: now });
}

/** The run a secret stands for, or null when it is unknown or the run has stopped. */
export async function runForSecret(secret: string): Promise<LocalRunRecord | null> {
  if (secret.length < 20) return null;
  return (await readDoc<LocalRunRecord>(runSecretKey(runSecretHash(secret))).catch(() => null))?.value ?? null;
}
