import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ComputerIo } from "../agent/lib/computer/runtime";
import type { Hands } from "../agent/lib/hands/types";

/**
 * The hands contract: every operation the app needs from a machine reaches
 * it as the command that machine understands, and answers come back typed.
 * The Linux implementation is driven against a fake machine that records
 * what it was asked and answers like the computer script does. A second kind
 * of machine runs the same `contract` against its own fake.
 */

const SCRIPT = "/workspace/.computer/bin/bot-computer";

/** A machine that answers the computer script's commands with `{ ok: true, ... }` and keeps written files. */
function fakeMachine(answers: Record<string, Record<string, unknown>> = {}) {
  const commands: string[] = [];
  const files = new Map<string, Uint8Array>();
  const io: ComputerIo = {
    async run(command) {
      commands.push(command);
      const script = command.split("\n").pop()?.trim() ?? "";
      if (script.startsWith(SCRIPT) || command.startsWith(SCRIPT)) {
        const verb = command.slice(command.indexOf(SCRIPT) + SCRIPT.length).trim().split(" ")[0] ?? "";
        return { exitCode: 0, stdout: JSON.stringify({ ok: true, ...(answers[verb] ?? {}) }), stderr: "" };
      }
      if (command.startsWith("cat ")) return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async readBinaryFile(path) {
      return files.get(path) ?? null;
    },
    async writeBinaryFile(path, content) {
      files.set(path, content);
    },
  };
  const scriptCalls = () => commands.filter((command) => command.startsWith(SCRIPT)).map((command) => command.slice(SCRIPT.length).trim());
  return { io, commands, files, scriptCalls };
}

/** What any kind of hands must do, given a way to make one on a fake machine and read what it was asked. */
type Made = { hands: Hands; calls: () => string[]; files: Map<string, Uint8Array> };

function contract(name: string, make: () => Promise<Made>) {
  describe(`${name} hands`, () => {
    beforeEach(() => {
      vi.resetModules();
      vi.stubEnv("BOT_STORE", "memory");
    });

    it("runs a command and returns its result", async () => {
      const { hands } = await make();
      const result = await hands.shell.run("echo hi");
      expect(result).toMatchObject({ exitCode: 0 });
    });

    it("drives screens: start, capture, input, stop, status", async () => {
      const { hands, calls, files } = await make();
      const started = await hands.screen.ensure(2, { wait: false });
      expect(started).toMatchObject({ screen: 2 });
      files.set("/tmp/bot-computer/shot-2.jpg", new Uint8Array([1, 2, 3]));
      const shot = await hands.screen.capture(2, 55, "TARGET1");
      expect(shot).toMatchObject({ mediaType: "image/jpeg", url: "https://x", bytes: new Uint8Array([1, 2, 3]) });
      await hands.screen.input(2, { type: "key", key: "Enter" });
      await hands.screen.stop(2);
      expect((await hands.screen.status()).installed).toBe(true);
      expect(calls()).toEqual(
        expect.arrayContaining([
          "ensure 2",
          "shot 2 /tmp/bot-computer/shot-2.jpg 55 TARGET1",
          `input 2 '{"type":"key","key":"Enter"}'`,
          "stop 2",
          "status",
        ]),
      );
    });

    it("drives the browser and the sign-in jar", async () => {
      const { hands, calls } = await make();
      await hands.browser.raise(1);
      expect(await hands.browser.activate(1, "T1")).toMatchObject({ ok: true });
      await hands.browser.close(1, "T1");
      await hands.browser.open(1, "https://example.com/a", { ifBlank: true });
      await hands.browser.saveTabs(1);
      await hands.identity.sync(1);
      await hands.identity.export(1);
      expect(calls()).toEqual(
        expect.arrayContaining(["raise 1", "activate 1 T1", "close-tab 1 T1", "open 1 https://example.com/a if-blank", "tabs save 1", "identity sync 1", "identity export 1"]),
      );
    });

    it("refuses to open anything but a web address", async () => {
      const { hands } = await make();
      await expect(hands.browser.open(1, "javascript:alert(1)")).rejects.toThrow(/web addresses/);
      await expect(hands.browser.open(1, "file:///etc/passwd")).rejects.toThrow(/web addresses/);
    });

    it("fails cleanly when the machine says no", async () => {
      const { hands } = await make();
      // The fake answers activate with ok: true; a real refusal comes back as a ComputerError.
      const { ComputerError } = await import("../agent/lib/hands");
      expect(new ComputerError("x", "activate")).toBeInstanceOf(Error);
      await expect(hands.screen.capture(9, 50)).rejects.toThrow(/screenshot was not written/);
    });
  });
}

contract("linux", async () => {
  const machine = fakeMachine({
    ensure: { screen: 2, display: ":2", vnc: 5902, cdp: 9224, started: true, ms: 10 },
    shot: { url: "https://x", title: "X" },
    status: { version: "1", installed: true, gateway: true, screens: [] },
  });
  // Imported after the module reset: the runtime caches which machines it has verified.
  const { handsFor } = await import("../agent/lib/hands");
  return { hands: handsFor(machine.io), calls: machine.scriptCalls, files: machine.files };
});
