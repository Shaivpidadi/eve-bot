import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  canonicalJson,
  deriveActionId,
  hashArgs,
  transition,
  type Action,
  type ActionError,
  type ActionReceipt,
} from "../agent/lib/actions";

/**
 * The action ledger (lib/actions.ts) and the email tool built on it. The tool
 * runs against the in-memory store with `fetch` standing in for the relay, so
 * each test can count exactly how many times an email would have gone out.
 */

vi.mock("../agent/lib/computer-backup", () => ({
  ensureComputerRestored: vi.fn(async () => undefined),
  checkpointComputer: vi.fn(async () => undefined),
}));
vi.mock("../agent/subagents/teammate/lib/browser", () => ({
  bindScreen: async (ctx: { session: { id: string; auth: never } }, botId: string, jobId: string) => {
    const { bindSession } = await import("../agent/lib/computer/screens");
    const { operator } = await import("../agent/lib/session");
    return bindSession({ sessionId: ctx.session.id, workspaceId: operator(ctx).workspaceId, botId, jobId, n: 1 });
  },
}));

const WORKSPACE = "wsa";
const AT = "2026-10-01T12:00:00.000Z";
const later = (ms: number) => new Date(Date.parse(AT) + ms).toISOString();

const fresh = (patch: Partial<Action> = {}): Action => ({
  actionId: "action_x",
  workspaceId: WORKSPACE,
  jobId: "job_1",
  run: { token: "lease_A", session: "sess_A" },
  kind: "email.send",
  target: ["a@example.com"],
  argsHash: "h",
  requester: "operator",
  approver: null,
  createdAt: AT,
  updatedAt: AT,
  expiresAt: later(60_000),
  state: "proposed",
  approvedAt: null,
  attempts: 0,
  attemptId: null,
  startedAt: null,
  receipt: null,
  error: null,
  ...patch,
});
const receipt: ActionReceipt = { providerId: "msg_1", status: "queued", httpStatus: 202, at: AT };
const failure = (retryable = false): ActionError => ({ message: "no", httpStatus: 400, retryable, at: AT });

/** Applies events in order, failing the test on the first refusal. */
function run(action: Action, ...events: Parameters<typeof transition>[1][]): Action {
  return events.reduce((current, event) => {
    const result = transition(current, event);
    if (!result.ok) throw new Error(`${event.type} refused: ${result.reason}`);
    return result.action;
  }, action);
}

describe("action state machine", () => {
  it("walks proposed → approved → executing → succeeded and keeps the receipt", () => {
    const done = run(
      fresh(),
      { type: "approve", approver: "op_1", at: AT },
      { type: "begin", attemptId: "try_1", at: AT },
      { type: "succeed", attemptId: "try_1", receipt, at: AT },
    );
    expect(done).toMatchObject({ state: "succeeded", approver: "op_1", attempts: 1, attemptId: "try_1", receipt });
  });

  it("refuses transitions the machine does not have", () => {
    expect(transition(fresh(), { type: "begin", attemptId: "t", at: AT })).toMatchObject({ ok: false, reason: "illegal" });
    expect(transition(fresh(), { type: "succeed", attemptId: "t", receipt, at: AT })).toMatchObject({ ok: false });
    const sent = fresh({ state: "succeeded", attemptId: "t", receipt });
    expect(transition(sent, { type: "begin", attemptId: "t2", at: AT })).toMatchObject({ ok: false, reason: "settled" });
    expect(transition(sent, { type: "approve", approver: null, at: AT })).toMatchObject({ ok: false, reason: "illegal" });
    expect(transition(sent, { type: "lose", attemptId: "t", error: failure(), at: AT })).toMatchObject({
      ok: false,
      reason: "settled",
    });
    expect(transition(sent, { type: "fail", attemptId: "t", error: failure(), at: AT })).toMatchObject({ ok: false });
    // Only the attempt that holds `executing` may settle it.
    const executing = fresh({ state: "executing", attemptId: "t", attempts: 1 });
    expect(transition(executing, { type: "succeed", attemptId: "other", receipt, at: AT })).toMatchObject({
      ok: false,
      reason: "illegal",
    });
    expect(transition(executing, { type: "begin", attemptId: "other", at: AT })).toMatchObject({ ok: false, reason: "busy" });
    // A definite failure is final; only a retryable one may begin again.
    expect(transition(fresh({ state: "failed", attemptId: "t", error: failure() }), { type: "begin", attemptId: "t2", at: AT })).toMatchObject({
      ok: false,
      reason: "settled",
    });
    expect(
      transition(fresh({ state: "failed", attemptId: "t", attempts: 1, error: failure(true) }), {
        type: "begin",
        attemptId: "t2",
        at: AT,
      }),
    ).toMatchObject({ ok: true, action: { state: "executing", attempts: 2, attemptId: "t2", error: null } });
  });

  it("refuses to begin on an expired approval until approved again", () => {
    const approved = run(fresh(), { type: "approve", approver: "op_1", at: AT, expiresAt: later(1_000) });
    expect(transition(approved, { type: "begin", attemptId: "t", at: later(2_000) })).toMatchObject({
      ok: false,
      reason: "expired",
    });
    const renewed = run(approved, { type: "approve", approver: "op_1", at: later(2_000) });
    expect(transition(renewed, { type: "begin", attemptId: "t", at: later(3_000) }).ok).toBe(true);
  });

  it("recognises its own transition already applied as success with nothing to write", () => {
    const approved = run(fresh(), { type: "approve", approver: "op_1", at: AT });
    expect(transition(approved, { type: "approve", approver: "op_1", at: AT })).toMatchObject({ ok: true, changed: false });
    const executing = run(approved, { type: "begin", attemptId: "t", at: AT });
    expect(transition(executing, { type: "begin", attemptId: "t", at: AT })).toMatchObject({ ok: true, changed: false });
    const sent = run(executing, { type: "succeed", attemptId: "t", receipt, at: AT });
    expect(transition(sent, { type: "succeed", attemptId: "t", receipt, at: AT })).toMatchObject({ ok: true, changed: false });
    const lost = run(executing, { type: "lose", attemptId: "t", error: failure(), at: AT });
    expect(transition(lost, { type: "lose", attemptId: "t", error: failure(), at: AT })).toMatchObject({ ok: true, changed: false });
  });

  it("lets the sending attempt settle an unknown outcome, and a person reconcile it", () => {
    const executing = run(fresh(), { type: "approve", approver: null, at: AT }, { type: "begin", attemptId: "t", at: AT });
    const lost = run(executing, { type: "lose", attemptId: "t", error: failure(), at: AT });
    expect(run(lost, { type: "succeed", attemptId: "t", receipt, at: AT })).toMatchObject({ state: "succeeded", receipt });
    expect(run(lost, { type: "reconcile", outcome: "failed", by: "op_1", at: AT })).toMatchObject({
      state: "failed",
      reconciledBy: "op_1",
    });
    expect(transition(executing, { type: "reconcile", outcome: "succeeded", by: "op_1", at: AT })).toMatchObject({ ok: false });
  });
});

describe("action identity", () => {
  it("hashes payloads canonically, whatever order their keys were built in", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: undefined, e: "x" }] })).toBe('{"a":[{"d":2,"e":"x"}],"b":1}');
    expect(hashArgs({ to: ["a"], subject: "s" })).toBe(hashArgs({ subject: "s", to: ["a"] }));
    expect(hashArgs({ to: ["a", "b"] })).not.toBe(hashArgs({ to: ["b", "a"] }));
  });

  it("derives the same id for the same run and payload, and a new one for any change", () => {
    const base = { workspaceId: WORKSPACE, jobId: "job_1", runToken: "lease_A", kind: "email.send" as const, argsHash: hashArgs({ s: 1 }) };
    expect(deriveActionId(base)).toBe(deriveActionId({ ...base }));
    expect(deriveActionId(base)).toMatch(/^action_[0-9a-f]{32}$/);
    expect(deriveActionId({ ...base, argsHash: hashArgs({ s: 2 }) })).not.toBe(deriveActionId(base));
    expect(deriveActionId({ ...base, runToken: "lease_B" })).not.toBe(deriveActionId(base));
    expect(deriveActionId({ ...base, workspaceId: "other" })).not.toBe(deriveActionId(base));
  });
});

describe("action ledger store", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
  });

  const proposal = (payload: unknown = { subject: "hi" }) => ({
    workspaceId: `ws-${Math.random().toString(36).slice(2, 8)}`,
    jobId: "job_1",
    run: { token: "lease_A", session: "sess_A" },
    kind: "email.send" as const,
    target: ["a@example.com"],
    payload,
    requester: "operator",
  });

  it("creates an action exactly once under concurrent proposals", async () => {
    const { proposeAction, getAction } = await import("../agent/lib/actions");
    const input = proposal();
    const results = await Promise.all(Array.from({ length: 20 }, () => proposeAction(input)));
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.action.actionId)).size).toBe(1);
    expect(await getAction(input.workspaceId, results[0]!.action.actionId)).toMatchObject({ state: "proposed", attempts: 0 });
  });

  it("admits exactly one of many concurrent attempts, and replays the winner's as done", async () => {
    const { proposeAction, applyAction } = await import("../agent/lib/actions");
    const input = proposal();
    const { action } = await proposeAction(input);
    await applyAction(input.workspaceId, action.actionId, { type: "approve", approver: null, at: new Date().toISOString() });
    const at = new Date().toISOString();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => applyAction(input.workspaceId, action.actionId, { type: "begin", attemptId: `t${i}`, at })),
    );
    const winners = results.filter((result) => result.ok);
    expect(winners).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.reason === "busy")).toHaveLength(11);
    const winner = winners[0]!.action!.attemptId!;
    // The same attempt asking again (a write that landed, retried) is success with no second write.
    expect(await applyAction(input.workspaceId, action.actionId, { type: "begin", attemptId: winner, at })).toMatchObject({
      ok: true,
      changed: false,
      action: { attempts: 1 },
    });
    expect(await applyAction(input.workspaceId, "action_nope", { type: "begin", attemptId: "t", at })).toEqual({
      ok: false,
      reason: "missing",
      action: null,
    });
  });
});

type Exec = {
  execute: (input: unknown, ctx: never) => Promise<Record<string, unknown>>;
  approval: { response: (ctx: unknown) => Promise<unknown> };
};

const ctxFor = (sessionId: string, callId = "call_1") =>
  ({
    session: {
      id: sessionId,
      auth: {
        current: {
          principalId: "runtime",
          principalType: "runtime",
          authenticator: "test",
          attributes: { workspaceId: WORKSPACE, room: "desk" },
        },
        initiator: null,
      },
      turn: { id: "t", sequence: 1 },
    },
    callId,
    toolName: "send_email",
    abortSignal: new AbortController().signal,
  }) as never;

const EMAIL = { to: ["board@acme.example"], subject: "Weekly report", body: "All green." };

describe("send_email through the ledger", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BOT_STORE", "memory");
    vi.stubEnv("BOT_EMAIL_WEBHOOK", "https://relay.example/send");
  });

  /** A job claimed by run `lease_A` and bound to `sess_A`, the email tool, and a relay that answers with `respond`. */
  async function setup(
    respond: (call: number) => Promise<Response> | Response = () => json(202, { id: "msg_1", status: "queued" }),
    lapsed = false,
  ) {
    const jobs = await import("../agent/lib/jobs");
    const actions = await import("../agent/lib/actions");
    const tool = async (name: string) => (await import(`../agent/subagents/teammate/tools/${name}.ts`)).default as Exec;
    const sendEmail = await tool("send_email");
    const jobBrief = await tool("job_brief");
    const job = await jobs.assignJob({
      workspaceId: WORKSPACE,
      botId: "bot_1",
      requestedBy: "operator",
      title: "Send the weekly report",
      brief: "Email the board.",
    });
    const claim = (token: string, forMs = 20 * 60_000) =>
      jobs.claimJob(WORKSPACE, job.id, { token, forMs, status: "running", kind: "run", countAttempt: true });
    expect((await claim("lease_A", lapsed ? 0 : undefined)).ok).toBe(true);
    expect((await jobBrief.execute({ jobId: job.id, runToken: "lease_A" }, ctxFor("sess_A"))).found).toBe(true);

    const calls: { headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push({ headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      return respond(calls.length);
    });
    vi.stubGlobal("fetch", fetchMock);
    const send = (patch: Partial<typeof EMAIL> = {}, session = "sess_A", callId = "call_1") =>
      sendEmail.execute({ jobId: job.id, ...EMAIL, ...patch }, ctxFor(session, callId));
    return { jobs, actions, sendEmail, jobBrief, job, claim, send, calls, fetchMock };
  }

  it("sends once with the action id as idempotency key, and a replay returns the stored receipt", async () => {
    const { actions, send, calls, sendEmail } = await setup();
    await sendEmail.approval.response({ responder: { principalId: "op_1" }, request: { callId: "call_1" }, session: { id: "sess_A" } });

    const first = await send();
    expect(first).toMatchObject({ sent: true, status: "sent", receipt: { providerId: "msg_1", status: "queued", httpStatus: 202 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers["idempotency-key"]).toBe(first.actionId);
    expect(calls[0]!.body).toMatchObject({ actionId: first.actionId, to: EMAIL.to, subject: EMAIL.subject, text: EMAIL.body });

    const again = await send();
    expect(again).toMatchObject({ sent: true, status: "sent", actionId: first.actionId, receipt: first.receipt });
    expect(again.note).toMatch(/already sent/);
    expect(calls).toHaveLength(1);

    expect(await actions.getAction(WORKSPACE, first.actionId as string)).toMatchObject({
      state: "succeeded",
      approver: "op_1",
      attempts: 1,
      callId: "call_1",
      target: EMAIL.to,
    });
  });

  it("treats a changed payload as a different action", async () => {
    const { send, calls } = await setup();
    const first = await send();
    const second = await send({ subject: "Weekly report (corrected)" });
    expect(second.actionId).not.toBe(first.actionId);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers["idempotency-key"]).toBe(second.actionId);
  });

  it("does not resend after a crash between the relay accepting and the receipt being stored", async () => {
    // The relay takes the email and the process dies before the reply is handled.
    let accepted = 0;
    const { actions, send, fetchMock } = await setup(() => {
      accepted += 1;
      return new Promise<Response>(() => undefined);
    });
    const crashed = send();
    await vi.waitFor(() => expect(accepted).toBe(1));
    void crashed;
    const [action] = await actions.listActions(WORKSPACE);
    expect(action).toMatchObject({ state: "executing", attempts: 1 });

    // A retry while the attempt could still be live leaves it alone.
    expect(await send()).toMatchObject({ sent: false, status: "in_progress", actionId: action!.actionId });

    // Once it is clearly dead, the retry records the outcome as unknown — and still does not send.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 10 * 60_000 });
    try {
      expect(await send()).toMatchObject({ sent: false, status: "delivery_unknown", actionId: action!.actionId });
      expect(await send()).toMatchObject({ status: "delivery_unknown" });
    } finally {
      vi.useRealTimers();
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await actions.getAction(WORKSPACE, action!.actionId)).toMatchObject({ state: "delivery_unknown", attempts: 1 });
  });

  it("records a 5xx as delivery unknown and never resends it", async () => {
    const { actions, send, calls } = await setup(() => json(502, { error: "bad gateway" }));
    const first = await send();
    expect(first).toMatchObject({ sent: false, status: "delivery_unknown" });
    expect(await send()).toMatchObject({ status: "delivery_unknown", actionId: first.actionId });
    expect(calls).toHaveLength(1);
    expect(await actions.getAction(WORKSPACE, first.actionId as string)).toMatchObject({
      state: "delivery_unknown",
      error: { httpStatus: 502 },
    });
  });

  it("records a timeout or dropped connection as delivery unknown", async () => {
    const { send, calls } = await setup(() => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    expect(await send()).toMatchObject({ sent: false, status: "delivery_unknown" });
    expect(await send()).toMatchObject({ status: "delivery_unknown" });
    expect(calls).toHaveLength(1);
  });

  it("records a definite 4xx as failed, and does not retry it", async () => {
    const { actions, send, calls } = await setup(() => json(422, { error: "bad address" }));
    const first = await send();
    expect(first).toMatchObject({ sent: false, status: "failed", retryable: false });
    expect(await send()).toMatchObject({ status: "failed" });
    expect(calls).toHaveLength(1);
    expect(await actions.getAction(WORKSPACE, first.actionId as string)).toMatchObject({ state: "failed", error: { httpStatus: 422 } });
  });

  it("retries a rate-limited send under the same idempotency key", async () => {
    const { send, calls } = await setup((call) => (call === 1 ? json(429, {}) : json(200, { messageId: "m_2" })));
    const first = await send();
    expect(first).toMatchObject({ status: "failed", retryable: true });
    const second = await send();
    expect(second).toMatchObject({ sent: true, actionId: first.actionId, receipt: { providerId: "m_2", status: "accepted" } });
    expect(calls.map((call) => call.headers["idempotency-key"])).toEqual([first.actionId, first.actionId]);
  });

  it("sends nothing for a cancelled or superseded run", async () => {
    const { jobs, actions, job, claim, send, fetchMock, jobBrief } = await setup(undefined, true);
    // A's lease lapsed and run B takes the job over; A's approved send must not go out.
    expect((await claim("lease_B")).ok).toBe(true);
    await jobBrief.execute({ jobId: job.id, runToken: "lease_B" }, ctxFor("sess_B"));
    expect(await send()).toMatchObject({ sent: false, status: "refused", reason: "superseded" });

    expect((await jobs.cancelJob(WORKSPACE, job.id)).ok).toBe(true);
    expect(await send({}, "sess_B")).toMatchObject({ sent: false, status: "refused", reason: "cancelled" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await actions.listActions(WORKSPACE)).toEqual([]);
  });

  it("sends nothing when the attempt cannot be recorded first", async () => {
    vi.doMock("../agent/lib/actions", async () => {
      const actual = await vi.importActual<typeof import("../agent/lib/actions")>("../agent/lib/actions");
      return {
        ...actual,
        applyAction: async (...args: Parameters<typeof actual.applyAction>) => {
          if (args[2].type === "begin") throw new Error("Concurrent write to actions/…");
          return actual.applyAction(...args);
        },
      };
    });
    try {
      const { send, fetchMock } = await setup();
      expect(await send()).toMatchObject({ sent: false, status: "not_admitted" });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("../agent/lib/actions");
    }
  });

  it("returns a draft and touches no ledger when no sender is configured", async () => {
    vi.stubEnv("BOT_EMAIL_WEBHOOK", undefined);
    const { actions, send, fetchMock } = await setup();
    expect(await send()).toMatchObject({ sent: false, status: "draft" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await actions.listActions(WORKSPACE)).toEqual([]);
  });
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
