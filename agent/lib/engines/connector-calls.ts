/**
 * The team's connectors, for a Claude Code or Codex Bot (plan section 4.3,
 * H2). eve's MCP connections do not reach such a Bot, so its connector tools
 * (`./host-tools`) call the servers from here, under the same rules an eve
 * Bot's calls go through (`../connector-gate`), read from the live record on
 * every call: a connector switched off, a tool switched off or re-marked as a
 * change, bites on the next call.
 *
 * - A read the gate lets through runs at once. It is safe to repeat, so a
 *   crash that interrupts one may run it again.
 * - Anything the gate would ask a person about (a change under the "writes"
 *   gate, any call under "all") is proposed in the action ledger and asked in
 *   the Bot's thread, like an email (`./proposals`). eve-bot makes the call
 *   once the person approves, exactly as proposed; the model never makes it.
 * - A change under the "none" gate runs at once, once: its tool never re-runs.
 *
 * Every call goes out with the credentials of the live record, never anything
 * the model gave, and its arguments are the model's only part.
 */
import { randomUUID } from "node:crypto";

import { type Action, type ActionError, applyAction } from "../actions";
import { record } from "../activity";
import { decideCall } from "../connector-gate";
import { allowedTools, type Connector, ConnectorRequestError, connectorRequest, listConnectors } from "../connectors";
import { toolEffect } from "../catalog";

/** What a person approves, and eve-bot then calls exactly. */
export interface ConnectorPayload {
  readonly connectorId: string;
  /** The connector's name and label when it was proposed, for the card. */
  readonly connector: string;
  readonly label: string;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly jobId: string;
}

/** How much of a tool's answer the model, or the person's card, is given. */
export const RESULT_LIMIT = 20_000;

export type CallDecision =
  | { readonly kind: "refuse"; readonly reason: string }
  | { readonly kind: "ask" }
  | { readonly kind: "go"; readonly effect: "read" | "write" };

/**
 * What the gate says about one call from a Claude Code or Codex Bot. The
 * "all" gate asks before every call: such a Bot has no eve session for a
 * first-use approval to be kept against.
 */
export function decide(live: Connector | null, tool: string): CallDecision {
  const decision = decideCall({ audience: "bot", live, toolName: tool, approvedAt: null });
  if (typeof decision === "object" && decision !== null && decision.type === "denied") return { kind: "refuse", reason: decision.reason ?? "This tool can no longer be used." };
  if (decision === "user-approval") return { kind: "ask" };
  return { kind: "go", effect: live === null ? "write" : toolEffect(live, tool).effect };
}

/** The connector a model named, by name or label, among the workspace's. */
export async function findConnector(workspaceId: string, name: string): Promise<Connector | null> {
  const wanted = name.trim().toLowerCase();
  const all = await listConnectors(workspaceId);
  return all.find((connector) => connector.name === wanted) ?? all.find((connector) => connector.label.toLowerCase() === wanted) ?? null;
}

/** The connectors a Bot may use, and what each tool does, as the model is shown them. */
export async function connectorsFor(workspaceId: string) {
  return (await listConnectors(workspaceId))
    .filter((connector) => connector.enabled)
    .map((connector) => ({
      connector: connector.name,
      label: connector.label,
      description: connector.description,
      asks: connector.gate === "all" ? "before every call" : connector.gate === "writes" ? "before every change" : "never",
      tools: allowedTools(connector).map((tool) => ({ name: tool, effect: toolEffect(connector, tool).effect })),
    }))
    .filter((connector) => connector.tools.length > 0);
}

/** One connector's tools as its server describes them now, limited to those a Bot may use. */
export async function toolsOf(connector: Connector) {
  const allowed = new Set(allowedTools(connector));
  const listed = (await connectorRequest(connector, "tools/list", {})) as { tools?: readonly { name?: unknown; description?: unknown; inputSchema?: unknown }[] } | null;
  return (listed?.tools ?? [])
    .filter((tool): tool is { name: string; description?: unknown; inputSchema?: unknown } => typeof tool.name === "string" && allowed.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      effect: toolEffect(connector, tool.name).effect,
      description: typeof tool.description === "string" ? tool.description.slice(0, 1_000) : "",
      inputSchema: tool.inputSchema ?? { type: "object" },
    }));
}

/** A tool's answer as text: its text parts, else the whole result as JSON, cut to `limit`. */
export function resultText(result: unknown, limit = RESULT_LIMIT): { readonly text: string; readonly isError: boolean } {
  const value = (result ?? {}) as { content?: readonly { type?: unknown; text?: unknown }[]; isError?: unknown; structuredContent?: unknown };
  const parts = (value.content ?? []).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text as string);
  const text = parts.length > 0 ? parts.join("\n") : JSON.stringify(value.structuredContent ?? value);
  return { text: text.length > limit ? `${text.slice(0, limit - 1)}…` : text, isError: value.isError === true };
}

/** Calls the tool, as the live record allows it, and says what came back. */
export async function callTool(live: Connector, tool: string, args: Readonly<Record<string, unknown>>) {
  return resultText(await connectorRequest(live, "tools/call", { name: tool, arguments: args }));
}

/**
 * Makes an approved connector call, once, through the action ledger: the
 * proposal is approved by `approver`, one attempt begins, the server is asked
 * once, and what it said is written. A call whose outcome is unknown (no
 * answer) is never made again on its own.
 */
export async function executeConnectorCall(input: {
  readonly workspaceId: string;
  readonly action: Action;
  readonly approver: string;
  readonly live: Connector;
  readonly payload: ConnectorPayload;
  readonly botId: string;
}): Promise<{ readonly status: "done" | "failed" | "unknown" | "not_started"; readonly text: string }> {
  const { action } = input;
  const at = () => new Date().toISOString();
  const apply = (event: Parameters<typeof applyAction>[2]) => applyAction(input.workspaceId, action.actionId, event);
  if (action.state === "proposed" || action.state === "approved") await apply({ type: "approve", approver: input.approver, at: at() });
  const attemptId = randomUUID();
  const begun = await apply({ type: "begin", attemptId, at: at() }).catch(() => null);
  if (begun === null || !begun.ok || begun.action.attemptId !== attemptId) {
    return { status: "not_started", text: "The call could not be recorded before it was made, so it was not made." };
  }
  const where = `${input.payload.label} ${input.payload.tool}`;
  const error = (message: string): ActionError => ({ message, httpStatus: null, retryable: false, at: at() });
  try {
    const answer = await callTool(input.live, input.payload.tool, input.payload.arguments);
    if (answer.isError) {
      await apply({ type: "fail", attemptId, error: error(answer.text.slice(0, 300)), at: at() }).catch(() => undefined);
      return { status: "failed", text: answer.text };
    }
    await apply({ type: "succeed", attemptId, receipt: { providerId: null, status: "done", httpStatus: 200, at: at() }, at: at() }).catch(() => undefined);
    await record({ workspaceId: input.workspaceId, kind: "job.progress", botId: input.botId, jobId: action.jobId, text: `Ran ${where}, approved by ${input.approver}.` }).catch(() => undefined);
    return { status: "done", text: answer.text };
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    const unknown = !(caught instanceof ConnectorRequestError) || caught.outcome === "unknown";
    await apply(unknown ? { type: "lose", attemptId, error: error(message), at: at() } : { type: "fail", attemptId, error: error(message), at: at() }).catch(() => undefined);
    if (unknown) {
      await record({ workspaceId: input.workspaceId, kind: "job.progress", botId: input.botId, jobId: action.jobId, text: `${where} may or may not have run: ${message} (action ${action.actionId}).` }).catch(() => undefined);
    }
    return { status: unknown ? "unknown" : "failed", text: message };
  }
}
