import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Bot's shell against a fake computer. What is asserted is what reached
 * the computer: every command, read and write goes through the helper as the
 * `bot` user, never as the computer's own user, and when the fence cannot be
 * set up nothing runs at all. The fence itself is exercised for real against
 * Docker (see the PR); here the generated helper is at least compiled and its
 * firewall rules read back.
 */

const isolation = vi.hoisted(() => ({
  answer: { mode: "landlock", ports: [443] } as unknown,
  calls: 0,
  fail: null as Error | null,
}));

vi.mock("../agent/lib/computer/runtime", async (importOriginal) => {
  const original = await importOriginal<typeof import("../agent/lib/computer/runtime")>();
  return {
    ...original,
    isolateShell: async () => {
      isolation.calls += 1;
      if (isolation.fail !== null) throw isolation.fail;
      return isolation.answer;
    },
  };
});

const { SHELL_HELPER, SHELL_PY, SHELL_REFUSED_MARK } = await import("../agent/lib/computer/shell-helper");
const shell = await import("../agent/lib/computer/shell");
const { computerRuntime, COMPUTER_BIN } = await import("../agent/lib/computer/script");
const { shellPorts } = await import("../agent/lib/computer/runtime");

interface Result {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** A computer that records what it was asked and answers from a script. */
function fakeComputer(answer: (command: string) => Result = () => ({ exitCode: 0, stdout: "", stderr: "" })) {
  const commands: string[] = [];
  const written: { path: string; content: Uint8Array }[] = [];
  const session = {
    id: "session-1",
    resolvePath: (path: string) => (path.startsWith("/") ? path : `/workspace/${path}`),
    run: vi.fn(async ({ command }: { command: string }) => {
      commands.push(command);
      return answer(command);
    }),
    readBinaryFile: vi.fn(async () => new Uint8Array([1])),
    writeBinaryFile: vi.fn(async (options: { path: string; content: Uint8Array }) => {
      written.push(options);
    }),
    spawn: vi.fn(),
    removePath: vi.fn(),
  };
  return { session, commands, written };
}

/** The arguments the helper would see, decoded. */
function helperArgs(command: string): string[] {
  const words = command.split(" ");
  expect(words.slice(0, 5)).toEqual(["sudo", "-n", "python3", "-I", SHELL_HELPER]);
  return words.slice(5);
}

const decode = (word: string) => Buffer.from(word.replace(/^'|'$/g, ""), "base64").toString("utf8");

beforeEach(() => {
  isolation.answer = { mode: "landlock", ports: [443] };
  isolation.calls = 0;
  isolation.fail = null;
  shell.forgetIsolation();
});

describe("the helper command", () => {
  it("carries the command, folder and environment as base64, so nothing in them reaches a shell as the computer's user", () => {
    const nasty = `curl http://127.0.0.1:9301/json; echo "$(cat /workspace/.computer/key)" 'x' \`id\``;
    const [subcommand, command, cwd, env] = helperArgs(shell.runCommand(nasty, { workingDirectory: "/workspace/bots", env: { A: "1" } }));
    expect(subcommand).toBe("run");
    expect(decode(command!)).toBe(nasty);
    expect(decode(cwd!)).toBe("/workspace/bots");
    expect(JSON.parse(decode(env!))).toEqual({ A: "1" });
    expect(shell.runCommand(nasty)).not.toContain("9301");
  });

  it("tells a refusal from a command that failed on its own", () => {
    expect(shell.refusedBy({ exitCode: 125, stdout: "", stderr: `${SHELL_REFUSED_MARK} the Bot shell is not set up\n` })).toBe(
      "the Bot shell is not set up",
    );
    expect(shell.refusedBy({ exitCode: 125, stdout: "", stderr: "docker: invalid flag" })).toBeNull();
    expect(shell.refusedBy({ exitCode: 1, stdout: "", stderr: `${SHELL_REFUSED_MARK} x` })).toBeNull();
  });
});

describe("the Bot's view of the computer", () => {
  it("runs every command through the helper as the bot user, after setting the fence up once", async () => {
    const { session, commands } = fakeComputer(() => ({ exitCode: 0, stdout: "bot\n", stderr: "" }));
    const bot = shell.isolatedSandbox(session as never);
    expect(await bot.run({ command: "id -un" })).toMatchObject({ exitCode: 0, stdout: "bot\n" });
    await bot.run({ command: "ls", workingDirectory: "/workspace/shared" });
    expect(isolation.calls).toBe(1);
    expect(commands).toHaveLength(2);
    for (const command of commands) expect(helperArgs(command)[0]).toBe("run");
    expect(decode(helperArgs(commands[1]!)[2]!)).toBe("/workspace/shared");
  });

  it("sets the fence up again when the computer lost it, and runs the command only once it holds", async () => {
    let refusals = 1;
    const { session, commands } = fakeComputer(() =>
      refusals-- > 0
        ? { exitCode: 125, stdout: "", stderr: `${SHELL_REFUSED_MARK} the firewall is missing\n` }
        : { exitCode: 0, stdout: "ok", stderr: "" },
    );
    const result = await shell.isolatedSandbox(session as never).run({ command: "true" });
    expect(result.stdout).toBe("ok");
    expect(isolation.calls).toBe(2);
    expect(commands).toHaveLength(2);
  });

  it("refuses when the helper keeps refusing", async () => {
    const { session } = fakeComputer(() => ({ exitCode: 125, stdout: "", stderr: `${SHELL_REFUSED_MARK} no fence\n` }));
    await expect(shell.isolatedSandbox(session as never).run({ command: "true" })).rejects.toBeInstanceOf(shell.ShellUnavailable);
  });

  it("never runs anything when the fence cannot be set up", async () => {
    isolation.fail = new Error("the Bot shell needs sudo on the computer");
    const { session, commands } = fakeComputer();
    await expect(shell.isolatedSandbox(session as never).run({ command: "true" })).rejects.toThrow(/needs sudo/);
    expect(commands).toEqual([]);
    // The next command tries again rather than trusting the failure forever.
    isolation.fail = null;
    await shell.isolatedSandbox(session as never).run({ command: "true" });
    expect(commands).toHaveLength(1);
  });

  it("reads as the bot user", async () => {
    const { session, commands } = fakeComputer((command) =>
      decode(helperArgs(command)[1]!) === "/workspace/missing"
        ? { exitCode: 44, stdout: "", stderr: "" }
        : { exitCode: 0, stdout: Buffer.from("one\ntwo\nthree\n").toString("base64"), stderr: "" },
    );
    const bot = shell.isolatedSandbox(session as never);
    expect(await bot.readTextFile({ path: "notes.txt" })).toBe("one\ntwo\nthree\n");
    expect(await bot.readTextFile({ path: "notes.txt", startLine: 2, endLine: 2 })).toBe("two");
    expect(await bot.readBinaryFile({ path: "/workspace/missing" })).toBeNull();
    expect(helperArgs(commands[0]!)[0]).toBe("read");
    expect(decode(helperArgs(commands[0]!)[1]!)).toBe("/workspace/notes.txt");
    expect(session.readBinaryFile).not.toHaveBeenCalled();
  });

  it("writes as the bot user, from a file staged in the computer's private folder", async () => {
    const { session, commands, written } = fakeComputer();
    await shell.isolatedSandbox(session as never).writeTextFile({ path: "/workspace/bots/atlas/a.txt", content: "hi" });
    expect(written).toHaveLength(1);
    const stage = written[0]!.path;
    expect(stage).toMatch(/^\/tmp\/bot-computer\/stage-[0-9a-f-]+$/);
    expect(new TextDecoder().decode(written[0]!.content)).toBe("hi");
    const [subcommand, target, staged] = helperArgs(commands[0]!);
    expect(subcommand).toBe("write");
    expect(decode(target!)).toBe("/workspace/bots/atlas/a.txt");
    expect(staged).toBe(stage);
    expect(commands[1]).toBe(`rm -f ${stage}`);
  });

  it("refuses whatever else eve might reach for, rather than doing it as the computer's user", () => {
    const { session } = fakeComputer();
    const bot = shell.isolatedSandbox(session as never);
    expect(() => bot.spawn({ command: "sh" })).toThrow(shell.ShellUnavailable);
    expect(() => bot.removePath({ path: "/workspace/.computer" })).toThrow(shell.ShellUnavailable);
    expect(session.spawn).not.toHaveBeenCalled();
    expect(bot.id).toBe("session-1");
  });
});

describe("the bash tool", () => {
  const context = (session: unknown) => ({ getSandbox: async () => session, session: { id: "s" } }) as never;

  it("runs as the bot user", async () => {
    const { session, commands } = fakeComputer(() => ({ exitCode: 0, stdout: "bot\n", stderr: "" }));
    const result = await shell.isolatedBash.execute!({ command: "id -un" }, context(session));
    expect(result).toMatchObject({ exitCode: 0, stdout: "bot\n" });
    expect(helperArgs(commands[0]!)[0]).toBe("run");
    expect(decode(helperArgs(commands[0]!)[1]!)).toBe("id -un");
    expect(shell.isolatedBash.description).toMatch(/unprivileged bot user/);
  });

  it("fails closed: no fence, no command, and the Bot is told why", async () => {
    isolation.fail = new Error("neither iptables nor Landlock");
    const { session, commands } = fakeComputer();
    const result = await shell.isolatedBash.execute!({ command: "cat /workspace/.computer/identity/cookies.json" }, context(session));
    expect(result).toMatchObject({ exitCode: 126, stdout: "" });
    expect((result as { stderr: string }).stderr).toMatch(/shell is unavailable.*neither iptables nor Landlock/);
    expect(commands).toEqual([]);
  });

  it("read_file and write_file go through the same fence", async () => {
    isolation.fail = new Error("no sudo");
    const { session } = fakeComputer();
    await expect(shell.isolatedReadFile.execute!({ filePath: "/workspace/.computer/key" }, context(session))).rejects.toThrow(/no sudo/);
    await expect(shell.isolatedWriteFile.execute!({ filePath: "/workspace/x", content: "x" }, context(session))).rejects.toThrow();
    expect(session.run).not.toHaveBeenCalled();
    expect(session.readBinaryFile).not.toHaveBeenCalled();
  });

  it("with BOT_SHELL_ISOLATION=off, runs unfenced only with a person's approval", async () => {
    vi.stubEnv("BOT_SHELL_ISOLATION", "off");
    vi.resetModules();
    const off = await import("../agent/lib/computer/shell");
    for (const tool of [off.isolatedBash, off.isolatedReadFile, off.isolatedWriteFile]) expect(tool.approval).toBeDefined();
    expect(off.isolatedBash.description).toMatch(/approval/);
    expect(shell.isolatedBash.approval).toBeUndefined();
  });
});

describe("the computer's programs", () => {
  const runtime = computerRuntime();
  const helper = runtime.files.find((file) => file.path === `${COMPUTER_BIN}/bot_shell.py`);
  const script = runtime.files.find((file) => file.path.endsWith("/bot-computer"))!.content;

  it("ship the helper with every setting filled in", () => {
    expect(helper).toBeDefined();
    expect(helper!.content).not.toMatch(/__[A-Z_]+__/);
    expect(helper!.content).toContain('USER = "bot"');
    expect(helper!.content).toContain("RESERVED = ((5900, 6099), (9222, 9399),)");
    expect(SHELL_PY).not.toContain("${");
    expect(SHELL_PY).not.toContain("`");
  });

  it("lock the screens' displays with a cookie and keep the run folder private", () => {
    expect(script).toMatch(/Xvnc ":\$n" -auth "\$XAUTHORITY" -nolisten tcp/);
    expect(script).toContain('export XAUTHORITY="$STATE/xauthority"');
    expect(script).toContain('chmod 700 "$RUN" "$IDENTITY"');
    expect(script).toContain("isolate) cmd_isolate");
  });

  it("let the Bot shell connect to its allowlist but never to the screens' ports", () => {
    vi.stubEnv("BOT_SHELL_TCP_PORTS", "5432, 9301, nope, 70000");
    const ports = shellPorts().split(",").map(Number);
    expect(ports).toContain(443);
    expect(ports).toContain(5432);
    expect(ports).not.toContain(70000);
    // The helper drops reserved ports itself, whatever it is given; see below.
    expect(ports).toContain(9301);
  });

  const python = spawnSync("python3", ["--version"]).status === 0;

  it.runIf(python)("compile, and build a firewall that rejects new loopback connections outside the allowlist", () => {
    const dir = mkdtempSync(join(tmpdir(), "bot-shell-"));
    const path = join(dir, "bot_shell.py");
    writeFileSync(path, helper!.content);
    execFileSync("python3", ["-m", "py_compile", path]);
    const probe = [
      "import importlib.util, json, sys",
      "spec = importlib.util.spec_from_file_location('bot_shell', sys.argv[1])",
      "mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)",
      "print(json.dumps({'body': mod.rule_body(list(range(1, 18))), 'jump': mod.jump(1002), 'env': mod.environment({'A': '1', 'B=C': 'x', 'D': 3})}))",
    ].join("\n");
    const out = JSON.parse(execFileSync("python3", ["-I", "-c", probe, path], { encoding: "utf8" })) as {
      body: string[][];
      jump: string[];
      env: Record<string, string>;
    };
    expect(out.body).toHaveLength(3);
    expect(out.body[0]).toContain("1,2,3,4,5,6,7,8,9,10,11,12,13,14,15");
    expect(out.body[1]).toContain("16,17");
    expect(out.body[2]).toEqual(["-p", "tcp", "--syn", "-j", "REJECT", "--reject-with", "tcp-reset"]);
    expect(out.jump).toEqual(["OUTPUT", "-o", "lo", "-p", "tcp", "-m", "owner", "--uid-owner", "1002", "-j", "BOT_SHELL"]);
    expect(out.env).toMatchObject({ HOME: "/home/bot", USER: "bot", A: "1" });
    expect(Object.keys(out.env)).not.toContain("B=C");
    expect(Object.keys(out.env)).not.toContain("D");
  });
});
