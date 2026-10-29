import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A replacement computer whose restore failed is never backed up: its archive
 * would replace the latest backup, which is then deleted, and the team's work
 * with it.
 */

type Answer = { exitCode: number; stdout: string; stderr: string };
const ok = (stdout = ""): Answer => ({ exitCode: 0, stdout, stderr: "" });
const text = (bytes: Uint8Array | null) => (bytes === null ? null : new TextDecoder().decode(bytes));

/** A computer whose files are a map; tar packs and unpacks the map, and restores fail while `restoreFails` is set. */
function computer(files: Record<string, string>, drive?: { fresh: boolean }) {
  const state = {
    files: { ...files },
    marker: null as string | null,
    archive: null as Uint8Array | null,
    upload: null as Uint8Array | null,
    restoreFails: false,
    driveClaimed: false,
  };
  const run = (command: string): Answer => {
    if (command.includes(" drive /team")) {
      return drive === undefined
        ? { exitCode: 1, stdout: '{"ok":false,"error":"no drive is mounted at /team"}', stderr: "" }
        : ok(JSON.stringify({ ok: true, fresh: drive.fresh, bound: "shared bots downloads chrome" }));
    }
    if (command.includes("touch /team/.bot-drive")) {
      state.driveClaimed = true;
      return ok();
    }
    if (command.includes("uname -m")) return ok("x86_64\n");
    if (command.startsWith("cat ") && command.includes("/generation")) return ok(state.marker ?? "");
    if (command.includes("tar -czf")) {
      state.marker = /printf '%s' '([^']+)'/.exec(command)![1]!;
      state.archive = new TextEncoder().encode(JSON.stringify(state.files));
      return ok(`${state.archive.byteLength}\n`);
    }
    if (command.includes("tar -xzf")) {
      if (state.restoreFails) return { exitCode: 2, stdout: "", stderr: "tar: Unexpected EOF in archive" };
      Object.assign(state.files, JSON.parse(text(state.upload)!));
      return ok();
    }
    return ok();
  };
  const sandbox = {
    run: async (input: { command: string }) => run(input.command),
    writeBinaryFile: async (input: { content: Uint8Array }) => {
      state.upload = input.content;
    },
    readBinaryFile: async () => state.archive,
  };
  /** The same computer as a plan engine's run reaches it (`ComputerIo`). */
  const io = {
    run: async (command: string) => run(command),
    writeBinaryFile: async (_path: string, content: Uint8Array) => {
      state.upload = content;
    },
    readBinaryFile: async () => state.archive,
  };
  return { state, sandbox, io };
}

const ctxFor = (sandbox: unknown) =>
  ({
    getSandbox: async () => sandbox,
    session: { id: "s1", auth: { initiator: { principalId: "owner", attributes: { workspaceId: "w1" } } } },
  }) as never;

async function load(env: Record<string, string> = {}) {
  vi.stubEnv("BOT_STORE", "memory");
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const feed: string[] = [];
  vi.doMock("../agent/lib/activity", () => ({ record: async (entry: { kind: string; text: string }) => void feed.push(`${entry.kind}: ${entry.text}`) }));
  vi.doMock("../agent/lib/computer/runtime", async (original) => ({ ...(await original<object>()), ensureRuntime: async () => undefined }));
  const backup = await import("../agent/lib/computer-backup");
  const store = await import("../agent/lib/store");
  const { COMPUTER_NAME } = await import("../agent/lib/computer");
  const manifest = async () =>
    (await store.readDoc<{ generation: string; archiveKey: string }>(`computer/${COMPUTER_NAME}/manifest.json`))?.value ?? null;
  return { backup, store, manifest, feed };
}

const at = (time: string) => vi.setSystemTime(new Date(`2026-10-26T${time}:00Z`));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.doUnmock("../agent/lib/activity");
  vi.doUnmock("../agent/lib/computer/runtime");
  vi.resetModules();
});

describe("backing up a replaced computer", () => {
  it("keeps the latest backup while the restore fails, and backs up again once it succeeds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("12:00");
    const { backup, store, manifest, feed } = await load();

    const original = computer({ "workspace/report.md": "three weeks of work" });
    await backup.checkpointComputer(ctxFor(original.sandbox), { minIntervalMs: 0 });
    const saved = (await manifest())!;
    expect(text(await store.readBytes(saved.archiveKey))).toContain("three weeks of work");

    // The computer is replaced, and its restore fails.
    at("13:00");
    const replacement = computer({});
    replacement.state.restoreFails = true;
    expect(await backup.ensureComputerRestored(ctxFor(replacement.sandbox))).toBe(false);

    at("14:30");
    await backup.checkpointComputer(ctxFor(replacement.sandbox), { minIntervalMs: 0 });
    expect(await manifest()).toEqual(saved);
    expect(text(await store.readBytes(saved.archiveKey))).toContain("three weeks of work");
    expect(replacement.state.marker).toBeNull();
    expect(feed.at(-1)).toMatch(/^computer.failed: Could not restore the computer from its backup/);

    // The restore works on the next try, and backups carry on.
    at("15:00");
    replacement.state.restoreFails = false;
    await backup.checkpointComputer(ctxFor(replacement.sandbox), { minIntervalMs: 0 });
    expect(replacement.state.files).toEqual({ "workspace/report.md": "three weeks of work" });
    const next = (await manifest())!;
    expect(next.generation).not.toBe(saved.generation);
    expect(text(await store.readBytes(next.archiveKey))).toContain("three weeks of work");
    expect(await store.readBytes(saved.archiveKey)).toBeNull();
  });

  it("restores and backs up a replaced computer for a plan engine's run, which holds only its io", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("12:00");
    const { backup, manifest, store, feed } = await load();

    const original = computer({ "workspace/report.md": "three weeks of work" });
    await backup.checkpointComputer(ctxFor(original.sandbox), { minIntervalMs: 0 });
    const saved = (await manifest())!;

    // The computer is replaced, and a Claude Code run on the owner's plan is the next to start.
    at("13:00");
    const replacement = computer({});
    expect(await backup.ensureComputerRestoredFor("w1", replacement.io)).toBe(true);
    expect(replacement.state.files).toEqual({ "workspace/report.md": "three weeks of work" });
    expect(feed.at(-1)).toMatch(/^computer.restored: /);

    // What the run writes is backed up with what was restored.
    at("14:00");
    replacement.state.files["workspace/bots/Atlas/notes.md"] = "the run's notes";
    await backup.checkpointComputerFor("w1", replacement.io, { minIntervalMs: 0 });
    const next = (await manifest())!;
    expect(next.generation).not.toBe(saved.generation);
    expect(text(await store.readBytes(next.archiveKey))).toContain("three weeks of work");
    expect(text(await store.readBytes(next.archiveKey))).toContain("the run's notes");
  });

  it("never claims or backs up a new drive whose restore failed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("12:00");
    const { backup, store, manifest } = await load({ BOT_COMPUTER_DRIVE: "on" });

    const original = computer({ "workspace/report.md": "three weeks of work" }, { fresh: false });
    await backup.checkpointComputer(ctxFor(original.sandbox), { minIntervalMs: 0 });
    const saved = (await manifest())!;

    at("13:00");
    const replacement = computer({}, { fresh: true });
    replacement.state.restoreFails = true;
    await backup.checkpointComputer(ctxFor(replacement.sandbox), { minIntervalMs: 0 });
    expect(replacement.state.driveClaimed).toBe(false);
    expect(await manifest()).toEqual(saved);
    expect(text(await store.readBytes(saved.archiveKey))).toContain("three weeks of work");
  });
});
