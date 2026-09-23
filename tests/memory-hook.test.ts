import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HookContext, HookDefinition } from "eve/hooks";

import type { CaptureDeps, CaptureInput, Proposal } from "../agent/lib/memory/capture";
import { type HookDeps, memoryCaptureHook } from "../agent/lib/memory/hook";
import { learnFromDenial, learnFromFeedback } from "../agent/lib/memory/outcomes";
import { readEntries, readFields } from "../agent/lib/memory/store";
import { writeDoc } from "../agent/lib/store";

/**
 * The hook turns eve's event stream into one captured exchange per turn. These
 * drive it with the events eve would send and a fake pipeline, and check what
 * it gathered, what it skipped, and what it told the feed.
 */

type Events = NonNullable<HookDefinition["events"]>;
type Handler = (event: unknown, ctx: HookContext) => void | Promise<void>;

const ctxFor = (sessionId: string, options: { readonly automated?: boolean; readonly room?: string } = {}): HookContext =>
  ({
    session: {
      id: sessionId,
      auth: {
        current: {
          principalId: options.automated ? "runtime" : "operator",
          principalType: options.automated ? "runtime" : "user",
          authenticator: "test",
          attributes: { workspaceId: "wsh", room: options.room ?? "desk" },
        },
        initiator: null,
      },
      turn: { id: "t", sequence: 1 },
    },
    agent: { name: "bot-eve" },
    channel: {},
  }) as unknown as HookContext;

/** A test double for what the hook reaches for, remembering everything it was handed. */
function harness(options: { readonly proposals?: readonly Proposal[]; readonly extractThrows?: boolean; readonly binding?: { jobId: string; botId: string } | null } = {}) {
  const captured: CaptureInput[] = [];
  const traces: string[] = [];
  const recorded: { kind: string; text: string; botId: string | null; jobId: string | null }[] = [];
  const denials: unknown[] = [];
  const deps = (): CaptureDeps => ({
    judge: null,
    extract: async (input) => {
      captured.push(input);
      if (options.extractThrows) throw new Error("extractor down");
      return options.proposals ?? [];
    },
    floor: 0.7,
    existing: async () => [],
  });
  const io: Partial<HookDeps> = {
    deps,
    trace: async (_ws, slot, stage, detail) => void traces.push(`${slot}:${stage}${detail ? ` ${detail}` : ""}`),
    record: (async (input) => {
      recorded.push({ kind: input.kind, text: input.text, botId: input.botId ?? null, jobId: input.jobId ?? null });
      return { id: "act", workspaceId: "wsh", at: "", kind: input.kind, botId: null, jobId: null, text: input.text };
    }) as HookDeps["record"],
    jobOf: async (_ws, messages) => {
      const text = messages.map((message) => (typeof message.content === "string" ? message.content : "")).join("\n");
      const match = /^id: (job_\w+)$/m.exec(text);
      return match ? { jobId: match[1]!, botId: "bot_a", botName: "Atlas" } : null;
    },
    binding: (async () => (options.binding === undefined ? { jobId: "job_1", botId: "bot_a", n: 1 } : options.binding)) as HookDeps["binding"],
    denial: (async (_ws: string, denial: unknown) => void denials.push(denial)) as unknown as HookDeps["denial"],
  };
  return { io, captured, traces, recorded, denials };
}

const fire = async (hook: HookDefinition, name: keyof Events, event: unknown, ctx: HookContext) => {
  const handler = (hook.events as Record<string, Handler | undefined>)[name];
  if (handler === undefined) throw new Error(`no handler for ${name}`);
  await handler(event, ctx);
};

const started = (turnId: string) => ({ type: "turn.started", data: { turnId, sequence: 1 } });
const received = (message: string) => ({ type: "message.received", data: { message, sequence: 1, turnId: "t" } });
const completedMessage = (message: string | null) => ({ type: "message.completed", data: { message, finishReason: "stop", sequence: 1, stepIndex: 0, turnId: "t" } });
const completedTurn = (turnId: string) => ({ type: "turn.completed", data: { turnId, sequence: 2 } });

describe("the capture hook, on a conversation", () => {
  beforeEach(() => {
    vi.stubEnv("BOT_STORE", "memory");
  });

  it("gathers what the person said and what came back, captures at the end of the turn, and tells the feed", async () => {
    const h = harness({ proposals: [{ op: "add", slot: "profile", text: "Prefers summaries as three bullets.", kind: "preference" }] });
    const hook = memoryCaptureHook("conversation", h.io);
    const ctx = ctxFor("s1");
    await fire(hook, "turn.started", started("t1"), ctx);
    await fire(hook, "message.received", received("From now on I prefer three-bullet summaries."), ctx);
    await fire(hook, "message.completed", completedMessage("Noted."), ctx);
    await fire(hook, "message.completed", completedMessage(null), ctx);
    await fire(hook, "turn.completed", completedTurn("t1"), ctx);

    expect(h.captured).toHaveLength(1);
    expect(h.captured[0]).toMatchObject({ workspaceId: "wsh", mode: "conversation", person: "From now on I prefer three-bullet summaries.", reply: "Noted.", operationId: "s1:t1" });
    expect(h.captured[0]!.source).toEqual({ who: "auto", room: "desk" });
    expect(h.recorded).toEqual([{ kind: "memory.saved", text: "Remembered: Prefers summaries as three bullets.", botId: null, jobId: null }]);
    expect(h.traces.some((line) => line.startsWith("profile:capturing"))).toBe(true);
    expect(h.traces.some((line) => line.startsWith("profile:done gate=cues"))).toBe(true);
  });

  it("keeps turns apart: the second exchange does not carry the first", async () => {
    const h = harness();
    const hook = memoryCaptureHook("conversation", h.io);
    const ctx = ctxFor("s2");
    await fire(hook, "turn.started", started("t1"), ctx);
    await fire(hook, "message.received", received("I always want dates like 21 Sep 2026."), ctx);
    await fire(hook, "message.completed", completedMessage("Sure."), ctx);
    await fire(hook, "turn.completed", completedTurn("t1"), ctx);
    await fire(hook, "turn.started", started("t2"), ctx);
    await fire(hook, "message.received", received("I never want exclamation marks, remember that."), ctx);
    await fire(hook, "message.completed", completedMessage("Understood."), ctx);
    await fire(hook, "turn.completed", completedTurn("t2"), ctx);
    expect(h.captured.map((input) => input.person)).toEqual(["I always want dates like 21 Sep 2026.", "I never want exclamation marks, remember that."]);
    expect(h.captured[1]!.reply).toBe("Understood.");
  });

  it("skips automated turns, turns with nothing from a person, and system deliveries", async () => {
    const h = harness();
    const hook = memoryCaptureHook("conversation", h.io);
    const scheduled = ctxFor("s3", { automated: true });
    await fire(hook, "turn.started", started("t1"), scheduled);
    await fire(hook, "message.received", received("Write the daily standup."), scheduled);
    await fire(hook, "turn.completed", completedTurn("t1"), scheduled);
    const quiet = ctxFor("s4");
    await fire(hook, "turn.started", started("t1"), quiet);
    await fire(hook, "message.received", received("Background task task_1 is completed."), quiet);
    await fire(hook, "message.completed", completedMessage("Atlas finished."), quiet);
    await fire(hook, "turn.completed", completedTurn("t1"), quiet);
    expect(h.captured).toEqual([]);
    expect(h.traces).toEqual(["profile:skipped automated turn", "profile:skipped no message from a person this turn"]);
    expect(h.recorded).toEqual([]);
  });

  it("survives an extractor that throws and says so in the trace", async () => {
    const h = harness({ extractThrows: true });
    const hook = memoryCaptureHook("conversation", h.io);
    const ctx = ctxFor("s5");
    await fire(hook, "turn.started", started("t1"), ctx);
    await fire(hook, "message.received", received("I prefer short answers, always."), ctx);
    await fire(hook, "message.completed", completedMessage("Ok."), ctx);
    await fire(hook, "turn.completed", completedTurn("t1"), ctx);
    expect(h.recorded).toEqual([]);
    expect(h.traces.at(-1)).toMatch(/profile:done gate=cues proposed=0 .*extractor failed: Error: extractor down/);
  });

  it("does nothing for a turn.completed it never saw the start of", async () => {
    const h = harness();
    const hook = memoryCaptureHook("conversation", h.io);
    await fire(hook, "turn.completed", completedTurn("t9"), ctxFor("s6"));
    expect(h.captured).toEqual([]);
    expect(h.traces).toEqual([]);
  });
});

describe("the capture hook, on a job", () => {
  beforeEach(() => {
    vi.stubEnv("BOT_STORE", "memory");
  });

  const brief = "You are Atlas.\n## Job\nid: job_77\ntitle: Weekly report\n\nWrite it.";

  it("gathers the brief, the replies and the tool results, names the Bot as the source, and learns to craft", async () => {
    const h = harness({ proposals: [{ op: "add", slot: "craft", text: "Export the CRM report as CSV; the PDF drops rows.", kind: "lesson" }] });
    const hook = memoryCaptureHook("job", h.io);
    const ctx = ctxFor("j1", { room: "bot-bot_a" });
    await fire(hook, "turn.started", started("t1"), ctx);
    await fire(hook, "message.received", received(brief), ctx);
    await fire(hook, "action.result", { type: "action.result", data: { result: { toolName: "page_get", output: { title: "Example Domain" } }, status: "ok", sequence: 1, stepIndex: 1, turnId: "t1" } }, ctx);
    // Without Jev a job's transcript has to have some substance before the gate opens; a real job's does.
    await fire(hook, "action.result", { type: "action.result", data: { result: { toolName: "page_read", output: "Rows: " + "row of the report, ".repeat(30) }, status: "ok", sequence: 1, stepIndex: 2, turnId: "t1" } }, ctx);
    await fire(hook, "message.completed", completedMessage("The PDF export lost rows, so I used CSV."), ctx);
    await fire(hook, "turn.completed", completedTurn("t1"), ctx);

    expect(h.captured).toHaveLength(1);
    const input = h.captured[0]!;
    expect(input.mode).toBe("job");
    expect(input.person).toBe(brief);
    expect(input.reply).toContain("The PDF export lost rows");
    expect(input.reply).toContain('[page_get] {"title":"Example Domain"}');
    expect(input.source).toEqual({ who: "auto", name: "Atlas", room: "bot-bot_a", jobId: "job_77" });
    expect(h.recorded[0]).toMatchObject({ kind: "memory.saved", botId: "bot_a", jobId: "job_77" });
    expect(h.recorded[0]!.text).toContain("Remembered: Export the CRM report as CSV");
  });

  it("skips a job turn whose brief carries no job id", async () => {
    const h = harness();
    const hook = memoryCaptureHook("job", h.io);
    const ctx = ctxFor("j2");
    await fire(hook, "turn.started", started("t1"), ctx);
    await fire(hook, "message.received", received("Do the thing, no id here."), ctx);
    await fire(hook, "message.completed", completedMessage("Done."), ctx);
    await fire(hook, "turn.completed", completedTurn("t1"), ctx);
    expect(h.captured).toEqual([]);
    expect(h.traces).toEqual(["craft:skipped no job id in the brief"]);
  });

  it("remembers what a Bot asked approval for and learns from the decline, not from the approval", async () => {
    const h = harness();
    const hook = memoryCaptureHook("job", h.io);
    const ctx = ctxFor("j3");
    const requests = [
      { requestId: "req_send", kind: "tool-approval", prompt: "Send the report to the board?", action: { toolName: "send_email", input: { to: "board@acme.example" } } },
      { requestId: "req_other", kind: "question", prompt: "Which quarter?" },
    ];
    await fire(hook, "input.requested", { type: "input.requested", data: { requests, sequence: 1, stepIndex: 1, turnId: "t1" } }, ctx);
    await fire(hook, "approval.settled", { type: "approval.settled", data: { requestId: "req_send", outcome: "approved", responderPrincipalId: "operator", sequence: 1, stepIndex: 1, turnId: "t1" } }, ctx);
    expect(h.denials).toEqual([]);
    await fire(hook, "input.requested", { type: "input.requested", data: { requests, sequence: 1, stepIndex: 1, turnId: "t1" } }, ctx);
    await fire(hook, "approval.settled", { type: "approval.settled", data: { requestId: "req_send", outcome: "cancelled", responderPrincipalId: "operator", sequence: 1, stepIndex: 1, turnId: "t1" } }, ctx);
    expect(h.denials).toEqual([
      { jobId: "job_1", botId: "bot_a", requestId: "req_send", toolName: "send_email", prompt: "Send the report to the board?", input: { to: "board@acme.example" } },
    ]);
    // A decline for a request it never saw, or on a session with no job, is ignored.
    await fire(hook, "approval.settled", { type: "approval.settled", data: { requestId: "req_unknown", outcome: "cancelled", responderPrincipalId: "operator", sequence: 1, stepIndex: 1, turnId: "t1" } }, ctx);
    expect(h.denials).toHaveLength(1);
    const unbound = harness({ binding: null });
    const other = memoryCaptureHook("job", unbound.io);
    await fire(other, "input.requested", { type: "input.requested", data: { requests, sequence: 1, stepIndex: 1, turnId: "t1" } }, ctxFor("j4"));
    await fire(other, "approval.settled", { type: "approval.settled", data: { requestId: "req_send", outcome: "cancelled", responderPrincipalId: "operator", sequence: 1, stepIndex: 1, turnId: "t1" } }, ctxFor("j4"));
    expect(unbound.denials).toEqual([]);
  });

  it("a conversation hook ignores approvals and tool results altogether", async () => {
    const h = harness();
    const hook = memoryCaptureHook("conversation", h.io);
    const ctx = ctxFor("c1");
    await fire(hook, "input.requested", { type: "input.requested", data: { requests: [{ requestId: "r", kind: "tool-approval", prompt: "?", action: { toolName: "x" } }], sequence: 1, stepIndex: 1, turnId: "t1" } }, ctx);
    await fire(hook, "approval.settled", { type: "approval.settled", data: { requestId: "r", outcome: "cancelled", responderPrincipalId: "operator", sequence: 1, stepIndex: 1, turnId: "t1" } }, ctx);
    expect(h.denials).toEqual([]);
  });
});

describe("learning from outcomes, end to end against the store", () => {
  beforeEach(async () => {
    vi.stubEnv("BOT_STORE", "memory");
    await writeDoc("jobs/wso/job_9.json", {
      id: "job_9",
      workspaceId: "wso",
      botId: "bot_z",
      title: "Weekly report",
      brief: "Write the weekly sales report for the board.",
      successCriteria: [],
      status: "queued",
      priority: "normal",
      runAt: "",
      everyMinutes: null,
      requiresSignoff: true,
      room: "desk",
      requestedBy: "Shaishav",
      createdAt: "",
      updatedAt: "",
      attempts: 1,
      lease: null,
      sessionId: null,
      agentId: null,
      result: null,
      feedback: null,
      artifacts: [],
    });
    await writeDoc("bots/wso/bot_z.json", { id: "bot_z", workspaceId: "wso", name: "Zed", role: "", emoji: "🧭", persona: "", playbook: [], status: "active", createdAt: "" });
  });

  it("keeps what a send-back note says about future work, without a Gateway", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    vi.stubEnv("BOT_JEV", "off");
    // No Gateway: the extractor is the quick model on a custom endpoint, which this test does not have. Stand one in.
    const capture = await import("../agent/lib/memory/capture");
    const spy = vi.spyOn(capture, "defaultDeps").mockImplementation((workspaceId) => ({
      judge: null,
      extract: async () => [
        { op: "set", slot: "profile", field: "length", value: "under 200 words" },
        { op: "add", slot: "profile", text: "Wants reports to open with the number that changed.", kind: "preference" },
      ],
      floor: 0.7,
      existing: (slot) => readEntries(workspaceId, slot),
      fields: (slot) => readFields(workspaceId, slot),
    }));
    try {
      const outcome = await learnFromFeedback("wso", "job_9", "Too long. Open with the number that changed.", { summary: "A 900-word report.", deliverable: "...", openQuestions: [], completion: "verified" } as never);
      expect(outcome?.gate).toBe("cues");
      expect(outcome?.fields.map((change) => [change.field, change.value])).toEqual([["length", "under 200 words"]]);
      expect(outcome?.saved.map((entry) => entry.text)).toEqual(["Wants reports to open with the number that changed."]);
      expect(outcome?.saved[0]?.source).toEqual({ who: "auto", name: "Zed", room: "desk", jobId: "job_9" });
      // The same note twice writes once.
      const again = await learnFromFeedback("wso", "job_9", "Too long. Open with the number that changed.", null);
      expect(again?.saved).toEqual([]);
      expect(await learnFromFeedback("wso", "job_missing", "Anything.", null)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("turns a decline into a craft rule only when the extractor finds one", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    vi.stubEnv("BOT_JEV", "off");
    const capture = await import("../agent/lib/memory/capture");
    const spy = vi.spyOn(capture, "defaultDeps").mockImplementation((workspaceId) => ({
      judge: null,
      extract: async () => [{ op: "add", slot: "craft", text: "Never send mail to the board without a person reading it first.", kind: "rule" }],
      floor: 0.7,
      existing: (slot) => readEntries(workspaceId, slot),
    }));
    try {
      const outcome = await learnFromDenial("wso", { jobId: "job_9", botId: "bot_z", requestId: "req_1", toolName: "send_email", prompt: "Send to the board now?", input: { to: "board@acme.example" } });
      expect(outcome?.saved.map((entry) => [entry.slot, entry.text])).toEqual([["craft", "Never send mail to the board without a person reading it first."]]);
      expect((await readEntries("wso", "craft"))[0]?.source.jobId).toBe("job_9");
    } finally {
      spy.mockRestore();
    }
  });
});
