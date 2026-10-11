import { createHash } from "node:crypto";

import { isConflict, listDocs, readDoc, updateDoc, writeDoc } from "./store";

/**
 * The action ledger: one durable record per irreversible thing a Bot does
 * outside the job record (an email today; a form submit or a payment later).
 *
 * The record exists so a retry can answer "did this already happen?" without
 * asking the world. Durable steps replay, the store can report a write that
 * landed as a conflict, and a relay can accept a send and then lose its reply;
 * in each case the next attempt reads the record instead of acting again.
 *
 * Shape (docs/decisions/0001-state-store.md, decision 2): one document per
 * `actionId`, created create-if-absent, and every state change a single
 * compare-and-set that checks the state it moves from. The provider's receipt
 * lives on the same document, so "sent" and "here is the proof" are one write.
 *
 * Transitions (anything else is refused):
 *
 * - `proposed → approved` (approve; also re-approves a stale `approved`)
 * - `approved → executing` (begin, unless the approval expired)
 * - `failed → executing` (begin, only when the failure was retryable)
 * - `executing → succeeded | failed | delivery_unknown` (the attempt's outcome)
 * - `delivery_unknown → succeeded | failed` (the same attempt learning its
 *   outcome late, or a reconciliation)
 *
 * `delivery_unknown` is the honest state for "the request may have reached the
 * provider": a timeout, a dropped connection, a 5xx, or an attempt that died
 * mid-send. Nothing ever re-sends from it on its own; only a reconciliation
 * (a person, or a provider lookup) settles it.
 */

export type ActionKind = "email.send";

export type ActionState = "proposed" | "approved" | "executing" | "succeeded" | "failed" | "delivery_unknown";

/** What the provider said when it accepted the action. */
export interface ActionReceipt {
  /** The provider's own id for the accepted request, when it returned one. */
  readonly providerId: string | null;
  /** The provider's status word ("queued", "sent"), or "accepted" when it gave none. */
  readonly status: string;
  readonly httpStatus: number | null;
  readonly at: string;
}

export interface ActionError {
  readonly message: string;
  readonly httpStatus: number | null;
  /**
   * The provider definitely did not act and asking again may work (a 429).
   * Only a retryable failure may begin a new attempt; any other failure is final
   * for this payload, and a different payload is a different action.
   */
  readonly retryable: boolean;
  readonly at: string;
}

export interface Action {
  readonly actionId: string;
  readonly workspaceId: string;
  readonly jobId: string;
  /** The run that asked for it: its lease token and teammate session. Part of the action's identity. */
  readonly run: { readonly token: string; readonly session: string };
  readonly kind: ActionKind;
  /** Who or what it acts on, for people reading the ledger: an email's recipients. */
  readonly target: readonly string[];
  /** sha256 of the canonical JSON of the exact payload sent. See `hashArgs`. */
  readonly argsHash: string;
  /** The permission/policy revision the action was approved under, when the caller tracks one. */
  readonly permissionVersion?: string;
  /** Who asked for the work: the job's requester. */
  readonly requester: string;
  /** Who approved it, when the approval named a person. */
  approver: string | null;
  /** The tool call that proposed it (replay-stable), for tracing back to the transcript. */
  readonly callId?: string;
  readonly createdAt: string;
  updatedAt: string;
  /** An approval not acted on by then is stale: `begin` refuses it until approved again. */
  expiresAt: string;
  state: ActionState;
  approvedAt: string | null;
  /** How many times an attempt began. More than one means a retryable failure was retried. */
  attempts: number;
  /**
   * The attempt that holds (or last held) `executing`. Every later transition of
   * that attempt names it, which is what makes them self-recognising: an attempt
   * that sees its own id already on a settled record knows its write landed.
   */
  attemptId: string | null;
  startedAt: string | null;
  receipt: ActionReceipt | null;
  error: ActionError | null;
  /** Who settled a `delivery_unknown` action, when one was reconciled. */
  reconciledBy?: string;
}

export type ActionEvent =
  | { readonly type: "approve"; readonly approver: string | null; readonly at: string; readonly expiresAt?: string }
  | { readonly type: "begin"; readonly attemptId: string; readonly at: string }
  | { readonly type: "succeed"; readonly attemptId: string; readonly receipt: ActionReceipt; readonly at: string }
  | { readonly type: "fail"; readonly attemptId: string; readonly error: ActionError; readonly at: string }
  | { readonly type: "lose"; readonly attemptId: string; readonly error: ActionError; readonly at: string }
  | {
      readonly type: "reconcile";
      readonly outcome: "succeeded" | "failed";
      readonly by: string;
      readonly receipt?: ActionReceipt;
      readonly error?: ActionError;
      readonly at: string;
    };

/**
 * The outcome of applying an event. `changed: false` means the event was
 * already reflected in the record (a replay, or a retried write that landed):
 * success, with nothing to write.
 */
export type Transition =
  | { readonly ok: true; readonly action: Action; readonly changed: boolean }
  | { readonly ok: false; readonly action: Action; readonly reason: ActionRefusal };

export type ActionRefusal = "illegal" | "expired" | "busy" | "settled";

/** How long an approval stays good for before an attempt must begin. */
export const APPROVAL_TTL_MS = 24 * 60 * 60_000;

export const SETTLED: readonly ActionState[] = ["succeeded", "failed", "delivery_unknown"];

export const actionKey = (workspaceId: string, actionId: string) => `actions/${workspaceId}/${actionId}.json`;

/**
 * Deterministic JSON: object keys sorted at every depth, `undefined` members
 * dropped (as `JSON.stringify` drops them), arrays in order. Two payloads that
 * mean the same thing hash the same whatever order their keys were built in.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const text = JSON.stringify(value);
    if (text === undefined) throw new TypeError(`Cannot canonicalize ${typeof value}.`);
    return text;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => (entry === undefined ? "null" : canonicalJson(entry))).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([name, entry]) => `${JSON.stringify(name)}:${canonicalJson(entry)}`).join(",")}}`;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** sha256 (hex) of the canonical JSON of the exact payload that will be sent. */
export function hashArgs(payload: unknown): string {
  return sha256(canonicalJson(payload));
}

/**
 * The action's id, from what makes it the same action: the run, the kind and
 * the exact payload.
 *
 * A durable-step replay of a call, or the model repeating an identical send in
 * the same run, maps to the same id and so finds the record of the first one.
 * A changed payload is a different action that needs its own approval, and the
 * next cycle of a routine is a different run with a different token, so its
 * send is new too. The workspace is in the hash as well as the key, so an id
 * never names an action in another workspace.
 */
export function deriveActionId(input: {
  readonly workspaceId: string;
  readonly jobId: string;
  readonly runToken: string;
  readonly kind: ActionKind;
  readonly argsHash: string;
}): string {
  const digest = sha256([input.workspaceId, input.jobId, input.runToken, input.kind, input.argsHash].join("\u0000"));
  return `action_${digest.slice(0, 32)}`;
}

export const isExpired = (action: Pick<Action, "expiresAt">, now: string): boolean =>
  Date.parse(action.expiresAt) <= Date.parse(now);

const refuse = (action: Action, reason: ActionRefusal): Transition => ({ ok: false, action, reason });
const same = (action: Action): Transition => ({ ok: true, action, changed: false });
const next = (action: Action, patch: Partial<Action>, at: string): Transition => ({
  ok: true,
  action: { ...action, ...patch, updatedAt: at },
  changed: true,
});

/**
 * The state machine, pure: what `event` does to `action`. Store wrappers run
 * it inside a compare-and-set, so it must recognise its own change already
 * applied and answer `changed: false` rather than refuse (decision 6).
 */
export function transition(action: Action, event: ActionEvent): Transition {
  switch (event.type) {
    case "approve": {
      if (action.state !== "proposed" && action.state !== "approved") return refuse(action, "illegal");
      const expiresAt = event.expiresAt ?? new Date(Date.parse(event.at) + APPROVAL_TTL_MS).toISOString();
      const approver = event.approver ?? action.approver;
      // Re-approving a live approval by the same person changes nothing worth a write.
      if (action.state === "approved" && approver === action.approver && !isExpired(action, event.at)) {
        return same(action);
      }
      return next(action, { state: "approved", approver, approvedAt: event.at, expiresAt }, event.at);
    }
    case "begin": {
      if (action.state === "executing") {
        return action.attemptId === event.attemptId ? same(action) : refuse(action, "busy");
      }
      const retry = action.state === "failed" && action.error?.retryable === true;
      if (action.state !== "approved" && !retry) {
        return refuse(action, SETTLED.includes(action.state) ? "settled" : "illegal");
      }
      if (action.state === "approved" && isExpired(action, event.at)) return refuse(action, "expired");
      return next(
        action,
        { state: "executing", attempts: action.attempts + 1, attemptId: event.attemptId, startedAt: event.at, error: null },
        event.at,
      );
    }
    case "succeed":
    case "fail":
    case "lose": {
      const target: ActionState =
        event.type === "succeed" ? "succeeded" : event.type === "fail" ? "failed" : "delivery_unknown";
      if (action.attemptId !== event.attemptId) return refuse(action, "illegal");
      if (action.state === target) return same(action);
      // The attempt that sent may still learn the outcome after another caller
      // gave it up as unknown: a definite answer from it wins. Nothing turns a
      // definite outcome back into an unknown one.
      const from: readonly ActionState[] = event.type === "lose" ? ["executing"] : ["executing", "delivery_unknown"];
      if (!from.includes(action.state)) return refuse(action, SETTLED.includes(action.state) ? "settled" : "illegal");
      return event.type === "succeed"
        ? next(action, { state: target, receipt: event.receipt, error: null }, event.at)
        : next(action, { state: target, error: event.error }, event.at);
    }
    case "reconcile": {
      if (action.state === event.outcome && action.reconciledBy === event.by) return same(action);
      if (action.state !== "delivery_unknown") return refuse(action, SETTLED.includes(action.state) ? "settled" : "illegal");
      return next(
        action,
        event.outcome === "succeeded"
          ? { state: "succeeded", receipt: event.receipt ?? action.receipt, reconciledBy: event.by }
          : { state: "failed", error: event.error ?? action.error, reconciledBy: event.by },
        event.at,
      );
    }
  }
}

export interface ProposeInput {
  readonly workspaceId: string;
  readonly jobId: string;
  readonly run: { readonly token: string; readonly session: string };
  readonly kind: ActionKind;
  readonly target: readonly string[];
  /** The exact payload to be sent; hashed here, never stored. */
  readonly payload: unknown;
  readonly requester: string;
  readonly permissionVersion?: string;
  readonly callId?: string;
  readonly now?: string;
}

/**
 * Creates the action in `proposed`, or returns the one already recorded for
 * the same run, kind and payload.
 *
 * Create-if-absent, so of many concurrent proposals exactly one creates and the
 * rest load it. On Blob a create that landed can come back as "already
 * exists"; the record read back is then this call's own, which is the answer.
 */
export async function proposeAction(input: ProposeInput): Promise<{ created: boolean; action: Action }> {
  const now = input.now ?? new Date().toISOString();
  const argsHash = hashArgs(input.payload);
  const actionId = deriveActionId({
    workspaceId: input.workspaceId,
    jobId: input.jobId,
    runToken: input.run.token,
    kind: input.kind,
    argsHash,
  });
  const key = actionKey(input.workspaceId, actionId);
  const existing = await readDoc<Action>(key);
  if (existing !== null) return { created: false, action: existing.value };

  const action: Action = {
    actionId,
    workspaceId: input.workspaceId,
    jobId: input.jobId,
    run: { token: input.run.token, session: input.run.session },
    kind: input.kind,
    target: [...input.target],
    argsHash,
    ...(input.permissionVersion === undefined ? {} : { permissionVersion: input.permissionVersion }),
    requester: input.requester,
    approver: null,
    ...(input.callId === undefined ? {} : { callId: input.callId }),
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.parse(now) + APPROVAL_TTL_MS).toISOString(),
    state: "proposed",
    approvedAt: null,
    attempts: 0,
    attemptId: null,
    startedAt: null,
    receipt: null,
    error: null,
  };
  try {
    await writeDoc(key, action, null);
    return { created: true, action };
  } catch (error) {
    if (!isConflict(error)) throw error;
    const raced = await readDoc<Action>(key);
    if (raced === null) throw error;
    // The id is derived from the hash, so a record under it with another hash is corruption, not a race.
    if (raced.value.argsHash !== argsHash) throw new Error(`Action ${actionId} is recorded with a different payload.`);
    return { created: false, action: raced.value };
  }
}

export async function getAction(workspaceId: string, actionId: string): Promise<Action | null> {
  return (await readDoc<Action>(actionKey(workspaceId, actionId)))?.value ?? null;
}

/**
 * Every action recorded for a workspace, newest first. For people reading the
 * ledger only: a listing is not a snapshot, so never decide an invariant on it.
 */
export async function listActions(workspaceId: string): Promise<Action[]> {
  const actions = await listDocs<Action>(`actions/${workspaceId}/`);
  return actions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export type ActionUpdate =
  | { readonly ok: true; readonly action: Action; readonly changed: boolean }
  | { readonly ok: false; readonly reason: ActionRefusal | "missing"; readonly action: Action | null };

/**
 * Applies one event to a stored action in one compare-and-set.
 *
 * A refused event writes nothing and says why, with the record as it stands.
 * When the store's retries run out this throws: the caller must read that as
 * "the transition did not happen" (for `begin`, not admitted: do not act),
 * never as success.
 */
export async function applyAction(workspaceId: string, actionId: string, event: ActionEvent): Promise<ActionUpdate> {
  const outcome: { result: ActionUpdate } = { result: { ok: false, reason: "missing", action: null } };
  const written = await updateDoc<Action>(actionKey(workspaceId, actionId), (current) => {
    if (current === null) {
      outcome.result = { ok: false, reason: "missing", action: null };
      return null;
    }
    const result = transition(current, event);
    outcome.result = result.ok
      ? { ok: true, action: result.action, changed: false }
      : { ok: false, reason: result.reason, action: result.action };
    return result.ok && result.changed ? result.action : null;
  });
  return written === null ? outcome.result : { ok: true, action: written, changed: true };
}

/**
 * Who approved a tool call, captured by the tool's approval response policy and
 * read back when the call executes. Keyed by session and call, the two ids both
 * sides see; the response side has no reliable workspace to key by.
 */
const approvalKey = (sessionId: string, callId: string) => `approvals/${sessionId}/${callId}.json`;

export interface ApprovalNote {
  readonly approver: string;
  readonly at: string;
}

/** Best effort: an approval must never fail because this note could not be written. */
export async function noteApproval(sessionId: string, callId: string, approver: string): Promise<void> {
  try {
    await writeDoc<ApprovalNote>(approvalKey(sessionId, callId), { approver, at: new Date().toISOString() });
  } catch {
    // The ledger then records the approval without a name.
  }
}

export async function approvalOf(sessionId: string, callId: string): Promise<ApprovalNote | null> {
  try {
    return (await readDoc<ApprovalNote>(approvalKey(sessionId, callId)))?.value ?? null;
  } catch {
    return null;
  }
}
