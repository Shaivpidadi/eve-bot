import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { archivePaths, type ComputerIo } from "../agent/lib/computer/runtime";

/**
 * A rewind point archives the job's paths, and a Bot's folder is its name:
 * "QA fixture" has a space. The script runs here in bash against a scratch
 * root, with `tar` standing in as a function that records the paths it was
 * given, so what is checked is the shell's quoting itself.
 */
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratchComputer() {
  const root = mkdtempSync(join(tmpdir(), "archive-paths-"));
  roots.push(root);
  const args = join(root, "tar-args");
  const io: ComputerIo = {
    run: async (command) => {
      const script = [`tar() { printf '%s\\n' "$@" > ${JSON.stringify(args)}; }`, command.replaceAll('"/$p"', `"${root}/$p"`).replaceAll("/tmp/bot-computer", join(root, "tmp"))].join("\n");
      try {
        return { exitCode: 0, stdout: execFileSync("bash", ["-c", script], { encoding: "utf8" }), stderr: "" };
      } catch (error) {
        const failed = error as { status?: number; stdout?: string; stderr?: string };
        return { exitCode: failed.status ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
      }
    },
    readBinaryFile: async () => new Uint8Array([1]),
    writeBinaryFile: async () => undefined,
  };
  const make = (path: string) => {
    mkdirSync(join(root, path), { recursive: true });
    writeFileSync(join(root, path, "a.txt"), "a");
  };
  return { io, make, archived: () => readFileSync(args, "utf8").trim().split("\n").slice(-2) };
}

describe("archivePaths", () => {
  it("keeps a path with spaces as one path, and leaves out what does not exist", async () => {
    const computer = scratchComputer();
    computer.make("workspace/bots/QA fixture qa-1");
    const bytes = await archivePaths(computer.io, ["/workspace/bots/QA fixture qa-1", "/workspace/bots/Other Bot", "/workspace/shared/missing.txt"]);
    expect(bytes).not.toBeNull();
    // The last arguments tar got, after its options: the one folder that exists, whole.
    expect(computer.archived()).toEqual(["/", "workspace/bots/QA fixture qa-1"]);
  });

  it("says there is nothing to archive when none of the paths exist", async () => {
    const computer = scratchComputer();
    expect(await archivePaths(computer.io, ["/workspace/bots/Nobody here"])).toBeNull();
  });
});
