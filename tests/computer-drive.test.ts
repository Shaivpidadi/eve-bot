import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { bindDrive, claimDrive, driveMounts, driveSize, driveWanted } from "../agent/lib/computer-drive";

/**
 * The team computer's work on a Vercel Drive: opt-in on Vercel only, made before
 * a new machine, bound on every machine a session gets, and never restored over
 * once it holds the team's work.
 */

type Answer = { exitCode: number; stdout: string; stderr: string };
const ok = (stdout: string): Answer => ({ exitCode: 0, stdout, stderr: "" });

/** A machine that answers commands by what they contain, and remembers every one it ran. */
function machine(answers: Record<string, Answer>) {
  const ran: string[] = [];
  const answer = (command: string): Answer => {
    ran.push(command);
    const key = Object.keys(answers).find((part) => command.includes(part));
    return key === undefined ? ok("") : answers[key]!;
  };
  return {
    ran,
    /** As the computer's io (`ComputerIo`). */
    io: {
      run: async (command: string) => answer(command),
      readBinaryFile: async () => null,
      writeBinaryFile: async () => undefined,
    },
    /** As eve's sandbox session. */
    sandbox: { run: async (input: { command: string }) => answer(input.command) },
  };
}
const noEnsure = { ensure: async () => undefined };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("../agent/lib/computer/runtime");
  vi.resetModules();
});

describe("drive settings", () => {
  it("is on only when asked, and never for a local computer", () => {
    expect(driveWanted({})).toBe(false);
    expect(driveWanted({ BOT_COMPUTER_DRIVE: "on" })).toBe(true);
    expect(driveWanted({ BOT_COMPUTER_DRIVE: "1", BOT_COMPUTER: "local" })).toBe(false);
    expect(driveMounts({})).toBeUndefined();
    expect(driveMounts({ BOT_COMPUTER_DRIVE: "on" })).toEqual({ "/team": { drive: "bot-computer", mode: "read-write" } });
  });

  it("sizes the drive only when told to", () => {
    expect(driveSize({})).toBeUndefined();
    expect(driveSize({ BOT_COMPUTER_DRIVE_GB: "1" })).toBe(1024 ** 3);
    expect(driveSize({ BOT_COMPUTER_DRIVE_GB: "lots" })).toBeUndefined();
  });
});

describe("bindDrive", () => {
  it("reads what the computer bound, and whether the drive is new", async () => {
    const box = machine({ " drive /team": ok('{"ok":true,"fresh":true,"bound":"shared bots downloads chrome"}\n') });
    expect(await bindDrive(box.io, noEnsure)).toEqual({ fresh: true, bound: ["shared", "bots", "downloads", "chrome"] });
    expect(box.ran).toEqual(["/workspace/.computer/bin/bot-computer drive /team"]);
  });

  it("is nothing on a machine that has not mounted the drive yet, and an error otherwise", async () => {
    expect(await bindDrive(machine({ drive: { exitCode: 1, stdout: '{"ok":false,"error":"no drive is mounted at /team"}', stderr: "" } }).io, noEnsure)).toBeNull();
    await expect(bindDrive(machine({ drive: { exitCode: 1, stdout: '{"ok":false,"error":"could not bind /team/bots over /workspace/bots"}', stderr: "" } }).io, noEnsure)).rejects.toThrow(
      "could not bind",
    );
  });

  it("claims the drive with a marker on it", async () => {
    const box = machine({});
    await claimDrive(box.io);
    expect(box.ran).toEqual(["sudo -n touch /team/.bot-drive"]);
  });
});

describe("restoring with a drive", () => {
  async function restoreWith(answers: Record<string, Answer>) {
    vi.stubEnv("BOT_STORE", "memory");
    vi.stubEnv("BOT_COMPUTER_DRIVE", "on");
    vi.doMock("../agent/lib/computer/runtime", async (original) => ({ ...(await original<object>()), ensureRuntime: async () => undefined }));
    const { ensureComputerRestored } = await import("../agent/lib/computer-backup");
    const box = machine(answers);
    const ctx = { getSandbox: async () => box.sandbox, session: { id: "s1" } } as unknown as Parameters<typeof ensureComputerRestored>[0];
    await ensureComputerRestored(ctx);
    return box.ran;
  }

  it("leaves a drive that holds the team's work alone", async () => {
    const ran = await restoreWith({ " drive /team": ok('{"ok":true,"fresh":false,"bound":"shared bots downloads chrome"}') });
    expect(ran).toEqual(["/workspace/.computer/bin/bot-computer drive /team"]);
  });

  it("claims a new drive once there is nothing to restore", async () => {
    const ran = await restoreWith({ " drive /team": ok('{"ok":true,"fresh":true,"bound":"shared bots downloads chrome"}') });
    expect(ran).toEqual(["/workspace/.computer/bin/bot-computer drive /team", "sudo -n touch /team/.bot-drive"]);
  });
});

describe("the team computer's hooks", () => {
  it("makes a new machine with its own open options when a resume finds the old one gone, then readies it", async () => {
    vi.stubEnv("BOT_STORE", "memory");
    const { TeamComputer, innerImplementation, readMachineRecord } = await import("../agent/lib/team-computer");
    const events: string[] = [];
    const sandbox = { id: "native" };
    const inner = {
      prepare: async () => ({}),
      resume: async () => {
        throw new Error("gone");
      },
      start: async (_ctx: unknown, open: unknown) => {
        events.push(`start ${JSON.stringify(open)}`);
        return { handle: { sandbox, onRuntimeShutdown: async () => undefined }, state: { sandboxName: "eve-sbx-vercel-1" } };
      },
    };
    const environment = { [Symbol.for("eve.sandbox-provider-runtime")]: { implementation: inner } };
    const team = innerImplementation(
      TeamComputer.environment({
        provider: "vercel",
        environment,
        open: { mounts: { "/team": { drive: "bot-computer", mode: "read-write" } } },
        beforeStart: async () => {
          events.push("beforeStart");
        },
        onMachine: async (_sandbox, state) => {
          events.push(`ready ${JSON.stringify(state)}`);
          throw new Error("bind failed");
        },
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const handle = await team.resume({ session: { id: "s1" } } as never, {} as never, { team: true } as never);
    expect((handle.sandbox as unknown as { id: string }).id).toBe("s1");
    expect(events).toEqual([
      "beforeStart",
      'start {"mounts":{"/team":{"drive":"bot-computer","mode":"read-write"}}}',
      'ready {"sandboxName":"eve-sbx-vercel-1"}',
    ]);
    expect(warn).toHaveBeenCalledWith("[computer]", "bind failed");
    expect((await readMachineRecord())?.state).toEqual({ sandboxName: "eve-sbx-vercel-1" });
  });
});

describe("bot-computer drive", () => {
  it("keeps the drive itself and the browser profiles on it away from a Bot's shell", async () => {
    const source = readFileSync(path.resolve(import.meta.dirname, "../agent/lib/computer/script.ts"), "utf8");
    const drive = /cmd_drive\(\) \{[^]*?\n\}/.exec(source)?.[0] ?? "";
    expect(drive).toContain('sudo -n chown root:root "$mount" && sudo -n chmod 700 "$mount"');
    expect(drive).toMatch(/\[ "\$name" = chrome \]; then sudo -n chmod 700 "\$src"/);
  });
});
