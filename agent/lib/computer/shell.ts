import { randomUUID } from "node:crypto";

import type { RuntimeSandboxSession, SandboxRunOptions } from "eve/sandbox";
import { defineTool, type ToolContext } from "eve/tools";
import { always } from "eve/tools/approval";
import { bash, type BashToolOutput } from "eve/tools/bash";
import { readFile } from "eve/tools/read_file";
import { writeFile } from "eve/tools/write_file";

import { isolateShell, sandboxIo, shellQuote, type CommandResult, type ShellIsolation } from "./runtime";
import { SHELL_HELPER, SHELL_REFUSED_EXIT, SHELL_REFUSED_MARK } from "./shell-helper";

/**
 * A Bot's shell, kept off the team's browser.
 *
 * The browser's DevTools, its profiles and the team's sign-in jar live on the
 * same computer as every Bot's `bash`. Instructions alone telling a Bot not to
 * drive the browser from the shell would leave the approval gate in front of
 * every consequential click one prompt injection away from bypassed. So the
 * Bot's `bash`, `read_file` and `write_file` run as the computer's unprivileged
 * `bot` user, which cannot read the browser's files nor connect to its ports
 * (see `shell-helper.ts` for the fence), while eve, the gated browser tools,
 * the console, backups and the operator's terminal keep the computer's own user.
 *
 * Fail closed: when the computer cannot have the fence (no sudo, neither
 * iptables nor Landlock), every command is refused with the reason, never run
 * unfenced. `BOT_SHELL_ISOLATION=off` is the explicit way out, for a computer
 * that has no browser worth guarding: the shell then runs as the computer's
 * user and every command waits for a person's approval.
 */

export const shellIsolationOff = (): boolean => process.env.BOT_SHELL_ISOLATION?.trim().toLowerCase() === "off";

/** The Bot shell cannot run fenced off the browser here, so it does not run. */
export class ShellUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShellUnavailable";
  }
}

const encode = (text: string) => Buffer.from(text, "utf8").toString("base64");

/** The helper invocation for one subcommand; every argument is base64 or a fixed word, so nothing is interpreted twice. */
export function helperCommand(subcommand: "run" | "kill" | "read" | "write" | "check", args: readonly string[] = []): string {
  return ["sudo", "-n", "python3", "-I", SHELL_HELPER, subcommand, ...args].map(shellQuote).join(" ");
}

/** One command as the Bot, tagged with the session it runs for (`BOT_RUN`) so a cancel can stop it. */
export function runCommand(
  command: string,
  options: { workingDirectory?: string; env?: Record<string, string>; runId?: string } = {},
): string {
  return helperCommand("run", [
    encode(command),
    encode(options.workingDirectory ?? ""),
    encode(JSON.stringify(options.env ?? {})),
    encode(options.runId ?? ""),
  ]);
}

/** Stops every command tagged with one of these sessions, and what they started. */
export function killRunCommand(runId: string): string {
  return helperCommand("kill", [encode(runId)]);
}

/**
 * Stops a cancelled run's shell commands on the computer, when it is up.
 * Bounded and best effort: the cancel already stands without it, and a
 * stopped computer runs nothing to stop. Answers how many processes ended.
 */
export async function stopRunCommands(sessionIds: readonly string[], timeoutMs = 15_000): Promise<number> {
  if (sessionIds.length === 0 || shellIsolationOff()) return 0;
  const { computerControl } = await import("./control");
  const control = computerControl();
  if ((await control.availability()).state !== "running") return 0;
  const io = await control.io();
  if (io === null) return 0;
  let killed = 0;
  const work = (async () => {
    for (const id of sessionIds) {
      const result = await io.run(killRunCommand(id));
      const answer = JSON.parse(result.stdout.trim() || "{}") as { killed?: number };
      killed += typeof answer.killed === "number" ? answer.killed : 0;
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work, new Promise((resolve) => (timer = setTimeout(resolve, timeoutMs)))]).finally(() => clearTimeout(timer));
  return killed;
}

/** The helper refused, rather than the command failing on its own. */
export function refusedBy(result: CommandResult): string | null {
  if (result.exitCode !== SHELL_REFUSED_EXIT) return null;
  const line = result.stderr.split("\n").find((entry) => entry.startsWith(SHELL_REFUSED_MARK));
  return line === undefined ? null : line.slice(SHELL_REFUSED_MARK.length).trim();
}

/** How long a process trusts the fence it last set up; the helper still checks it before every command. */
const ISOLATION_TRUSTED_MS = 10 * 60_000;
let isolation: { at: number; result: Promise<ShellIsolation> } | null = null;
let announced: string | null = null;

type Session = Pick<RuntimeSandboxSession, "run" | "readBinaryFile" | "writeBinaryFile">;

function isolated(session: Session): Promise<ShellIsolation> {
  if (isolation !== null && Date.now() - isolation.at < ISOLATION_TRUSTED_MS) return isolation.result;
  const result = isolateShell(sandboxIo(session)).then(
    (answer) => {
      if (announced !== answer.mode) console.info(`[computer] Bot shell runs as its own user, fenced off the browser by ${answer.mode}.`);
      announced = answer.mode;
      return answer;
    },
    (error: unknown) => {
      isolation = null;
      announced = null;
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[computer] Bot shell refused: it cannot be fenced off the browser on this computer. ${reason}`);
      throw new ShellUnavailable(reason);
    },
  );
  isolation = { at: Date.now(), result };
  return result;
}

/** Forget the fence this process trusted, so the next command sets it up again. */
export function forgetIsolation(): void {
  isolation = null;
}

/** Runs one helper command, setting the fence up first and once more if the computer lost it. */
async function helper(session: Session, command: string, abortSignal?: AbortSignal): Promise<CommandResult> {
  await isolated(session);
  const run = () => session.run({ command, ...(abortSignal === undefined ? {} : { abortSignal }) });
  let result = await run();
  if (refusedBy(result) !== null) {
    forgetIsolation();
    await isolated(session);
    result = await run();
    const reason = refusedBy(result);
    if (reason !== null) throw new ShellUnavailable(reason);
  }
  return result;
}

function sliceLines(text: string, startLine?: number, endLine?: number): string {
  if (startLine === undefined && endLine === undefined) return text;
  const lines = text.split("\n");
  return lines.slice(Math.max(0, (startLine ?? 1) - 1), endLine ?? lines.length).join("\n");
}

/**
 * The computer as a Bot's shell sees it: commands, reads and writes run as the
 * `bot` user through the helper. Anything else eve might reach for is refused
 * rather than quietly done as the computer's own user.
 */
export function isolatedSandbox(session: RuntimeSandboxSession, runId?: string): RuntimeSandboxSession {
  const readBinaryFile = async (options: { path: string; abortSignal?: AbortSignal }): Promise<Uint8Array | null> => {
    const result = await helper(session, helperCommand("read", [encode(session.resolvePath(options.path))]), options.abortSignal);
    if (result.exitCode === 44) return null;
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Could not read ${options.path}.`);
    return new Uint8Array(Buffer.from(result.stdout.trim(), "base64"));
  };
  const writeBinaryFile = async (options: { path: string; content: Uint8Array; abortSignal?: AbortSignal }): Promise<void> => {
    // Staged as the computer's user in its private run folder; the helper hands the bytes to the Bot's own write.
    const stage = `/tmp/bot-computer/stage-${randomUUID()}`;
    await session.writeBinaryFile({ path: stage, content: options.content });
    try {
      const result = await helper(session, helperCommand("write", [encode(session.resolvePath(options.path)), stage]), options.abortSignal);
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Could not write ${options.path}.`);
    } finally {
      await Promise.resolve(session.run({ command: `rm -f ${shellQuote(stage)}` })).catch(() => undefined);
    }
  };
  const methods: Partial<RuntimeSandboxSession> = {
    async run(options: SandboxRunOptions) {
      const { command, workingDirectory, env, abortSignal } = options;
      return helper(
        session,
        runCommand(command, {
          ...(workingDirectory === undefined ? {} : { workingDirectory }),
          ...(env === undefined ? {} : { env }),
          ...(runId === undefined ? {} : { runId }),
        }),
        abortSignal,
      );
    },
    readBinaryFile,
    async readTextFile(options) {
      const bytes = await readBinaryFile(options);
      if (bytes === null) return null;
      const encoding = options.encoding ?? "utf-8";
      const text =
        encoding === "utf-8" || encoding === "utf8"
          ? new TextDecoder("utf-8", { fatal: true }).decode(bytes)
          : Buffer.from(bytes).toString(encoding as BufferEncoding);
      return sliceLines(text, options.startLine, options.endLine);
    },
    writeBinaryFile,
    async writeTextFile(options) {
      await writeBinaryFile({
        path: options.path,
        content: new Uint8Array(Buffer.from(options.content, (options.encoding ?? "utf8") as BufferEncoding)),
        ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
      });
    },
  };
  return new Proxy(session, {
    get(target, property) {
      if (property === "id") return target.id;
      if (property === "resolvePath") return target.resolvePath.bind(target);
      if (Object.hasOwn(methods, property)) return methods[property as keyof typeof methods];
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return () => {
        throw new ShellUnavailable(`${String(property)} is not available from a Bot's shell.`);
      };
    },
  });
}

/** The tool context with its sandbox swapped for the Bot shell's view of it. */
export function withIsolatedShell<C extends ToolContext>(ctx: C): C {
  return new Proxy(ctx, {
    get(target, property) {
      if (property === "getSandbox") return async () => isolatedSandbox(await target.getSandbox(), target.session.id);
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const OFF_NOTE = " Each command waits for a person's approval: this computer's shell is not fenced off the browser.";
const ON_NOTE =
  " Runs as the unprivileged bot user in /workspace: the browser, its sign-ins and its ports are out of reach from here; use the page tools for anything in the browser.";

/** eve's `bash`, run as the Bot's own user. */
export const isolatedBash = shellIsolationOff()
  ? defineTool({ ...bash, description: bash.description + OFF_NOTE, approval: always() })
  : defineTool({
      ...bash,
      description: bash.description + ON_NOTE,
      async execute(input, ctx) {
        try {
          // eve's bash answers with one result, never a stream.
          return (await bash.execute(input, withIsolatedShell(ctx))) as BashToolOutput;
        } catch (error) {
          if (!(error instanceof ShellUnavailable)) throw error;
          return {
            exitCode: 126,
            stdout: "",
            stderr: `The shell is unavailable: it cannot be kept off the team's browser on this computer (${error.message}). Use the page tools and the other tools instead, and say so in your summary.`,
            truncated: false,
          };
        }
      },
    });

/** eve's `read_file`, reading as the Bot's own user. */
export const isolatedReadFile = shellIsolationOff()
  ? defineTool({ ...readFile, approval: always() })
  : defineTool({ ...readFile, execute: (input, ctx) => readFile.execute(input, withIsolatedShell(ctx)) });

/** eve's `write_file`, writing as the Bot's own user. */
export const isolatedWriteFile = shellIsolationOff()
  ? defineTool({ ...writeFile, approval: always() })
  : defineTool({ ...writeFile, execute: (input, ctx) => writeFile.execute(input, withIsolatedShell(ctx)) });
