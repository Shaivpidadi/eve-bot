import { emptySessionView, foldEvents } from "eve/events";
import { describe, expect, it } from "vitest";

import { textOfParts } from "../agent/lib/events";
import { ownSpend } from "../agent/lib/usage";
import { askOf, resolutionOf } from "../src/console/asks";

/** Reading eve 0.84's session facts (stream version 27): the pieces eve-bot built on them. */

describe("a person's step, as the thread's card draws it", () => {
  const calls = new Map([["c1", { name: "teammate__send_email", input: { to: "ana@example.com" } }]]);

  it("names the tool an approval is about, from the call the thread saw", () => {
    const ask = askOf({ interactionId: "int_1", subject: { callId: "c1" }, request: { kind: "approval", prompt: "Send it?" } }, calls);
    expect(ask).toEqual({ requestId: "int_1", kind: "tool-approval", prompt: "Send it?", action: { toolName: "teammate__send_email", input: { to: "ana@example.com" } } });
  });

  it("takes a relayed approval's tool from where it was asked, and keeps that id for the takeover banner", () => {
    const ask = askOf(
      { interactionId: "int_2", subject: { callId: "c_run" }, request: { kind: "approval", prompt: "Take over?" }, origin: { interactionId: "child_9", call: { name: "request_takeover", input: { reason: "Sign in" } } } },
      calls,
    );
    expect(ask).toMatchObject({ requestId: "int_2", originId: "child_9", action: { toolName: "request_takeover", input: { reason: "Sign in" } } });
  });

  it("reads a budget prompt and a question as before", () => {
    expect(askOf({ interactionId: "b", subject: {}, request: { kind: "budget", prompt: "Limit reached" } }, calls).kind).toBe("session-limit");
    expect(askOf({ interactionId: "q", subject: {}, request: { kind: "question", prompt: "Which?", options: [{ id: "a", label: "A" }], allowFreeform: true } }, calls)).toMatchObject({ kind: "question", allowFreeform: true });
  });

  it("settles as approved, denied, answered, or no longer needed", () => {
    const approval = { kind: "tool-approval" };
    expect(resolutionOf(approval, { interactionId: "i", outcome: "accepted", response: { optionId: "approve" } }).outcome).toBe("approved");
    expect(resolutionOf(approval, { interactionId: "i", outcome: "declined", response: { optionId: "deny" } }).outcome).toBe("denied");
    expect(resolutionOf({ kind: "question" }, { interactionId: "i", outcome: "accepted", response: { text: "Q3" } })).toEqual({ requestId: "i", kind: "question", outcome: "answered", response: { text: "Q3" } });
    for (const outcome of ["withdrawn", "interrupted", "expired"]) expect(resolutionOf(approval, { interactionId: "i", outcome }).outcome).toBe("ignored");
  });
});

describe("what a person sent", () => {
  it("is the text of a delivery's parts, files left out", () => {
    expect(textOfParts([{ kind: "text", text: "Hi" }, { kind: "file", mediaType: "image/png" }, { kind: "text", text: "there" }])).toBe("Hi\nthere");
    expect(textOfParts(undefined)).toBe("");
  });
});

describe("the ledger", () => {
  const at = (line: number) => ({ meta: { position: { line, index: 0 }, at: "2026-10-28T10:00:00.000Z" } });
  const view = foldEvents(emptySessionView(), [
    { type: "session.started", data: { runtime: {} }, ...at(0) },
    { type: "turn.started", data: { turnId: "t1", cause: {}, follows: null }, scope: { turnId: "t1" }, ...at(1) },
    { type: "model.requested", data: { runId: "r1", owner: { turnId: "t1" } }, scope: { turnId: "t1", runId: "r1" }, ...at(2) },
    { type: "model.started", data: { runId: "r1", modelId: "gateway/anthropic/claude-sonnet-5", attempt: 1 }, scope: { turnId: "t1", runId: "r1" }, ...at(3) },
  ] as never);

  it("counts a model run's spend on the model the run named, and a compaction's", () => {
    expect(ownSpend({ kind: "model", owner: { runId: "r1" } }, view)).toEqual({ modelId: "gateway/anthropic/claude-sonnet-5" });
    expect(ownSpend({ kind: "model", owner: { changeId: "ctx_1" } }, view)).toEqual({ modelId: null });
  });

  it("leaves what a delegated call reports for its agent to that agent's own books", () => {
    expect(ownSpend({ kind: "model", owner: { callId: "c1" } }, view)).toBeNull();
    expect(ownSpend({ kind: "delegated-late" }, view)).toBeNull();
  });
});
