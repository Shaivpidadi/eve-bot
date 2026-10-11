import { ConnectionAuthorizationFailedError, ConnectionAuthorizationRequiredError, defineMcpClientConnection, type McpClientConnectionDefinition } from "eve/connections";
import type { ApprovalContext, ApprovalResponseContext, ApprovalStatus } from "eve/tools/approval";

import { toolEffect } from "./catalog";
import { allowedTools, type Connector, connectorHeaders, connectorToken, getConnector, permissionVersion } from "./connectors";
import { readDoc, updateDoc } from "./store";

/**
 * One connector as an eve MCP connection, for HQ or for a Bot at work.
 *
 * What a session is set up with is only a starting point. Settings change
 * while sessions run (a connector switched off, a tool switched off, a tool
 * re-marked as a change, a key rotated, a connector removed), and each of
 * those has to bite on the next call, not the next session. So every hook
 * eve offers re-reads the stored connector and fails closed:
 *
 * - `approval.request` runs before every tool call with the tool's name. It
 *   decides from the live record: gone, off, tool not allowed (for HQ: not a
 *   reviewed read) is a denial with a reason the model sees; otherwise the
 *   live gate and live policy decide whether a person is asked.
 * - `approval.response` runs when a person approves (never on a denial). It
 *   records, per session, the permission version the tool was approved under,
 *   which is what the "all" gate's "first use in a job" is measured against
 *   (see `decideCall`). It only records: it always allows.
 * - `headers` and `getToken` run when eve opens the connection to the server.
 *   They read the key from the live record, so a rotated key is the one sent,
 *   and a removed or switched-off connector gets no credentials at all.
 * - `tools.allow` is always the checked list, so a tool the server grew since
 *   the last check is never offered, even when nothing was switched off.
 *
 * eve caches an open connection (and the headers it was opened with) until
 * the connection set is replaced; the resolvers in `connections/` re-resolve
 * on every turn, so a new key is in use from the next turn. Within a turn the
 * approval check is what stops a call. Nothing about approvals lives in the
 * connection itself, so rebuilding it each turn neither loses nor revives one.
 */
export type Audience = "hq" | "bot";

/** A denial the model sees as the tool's result. */
const deny = (reason: string): ApprovalStatus => ({ type: "denied", reason });

/** The tool's own name, without the `<connector>__` prefix eve gives connection tools. */
export function bareTool(connectorName: string, toolName: string): string {
  return toolName.startsWith(`${connectorName}__`) ? toolName.slice(connectorName.length + 2) : (toolName.split("__").pop() ?? toolName);
}

/**
 * The per-call decision, given the live record. Pure, so the rules can be
 * tested without eve.
 *
 * `approvedAt` is the permission version this session last had the tool
 * approved under by a person (`approvedVersion`), or null. Under the "all"
 * gate a call goes ahead unasked only when that is the live version: an
 * approval given under older settings, or never given (a denial records
 * nothing), means the person is asked. eve's own `approvedTools` is not used:
 * it lasts the whole session whatever the settings did since.
 */
export function decideCall(input: {
  readonly audience: Audience;
  readonly live: Connector | null;
  readonly toolName: string;
  readonly approvedAt: number | null;
}): ApprovalStatus {
  const { audience, live, toolName } = input;
  if (live === null) return deny("This connector was removed; its tools can no longer be used.");
  if (!live.enabled) return deny(`${live.label} is switched off on the Connectors page.`);
  const bare = bareTool(live.name, toolName);
  if (!allowedTools(live, { readsOnly: audience === "hq" }).includes(bare)) {
    return audience === "hq"
      ? deny(`HQ only uses ${live.label} tools a person confirmed only read; hand this to a Bot as a job.`)
      : deny(`${bare} is not one of the ${live.label} tools a Bot may use.`);
  }
  if (audience === "hq") return "not-applicable";
  if (live.gate === "writes") return toolEffect(live, bare).effect === "write" ? "user-approval" : "not-applicable";
  if (live.gate === "all") return input.approvedAt !== null && input.approvedAt === permissionVersion(live) ? "not-applicable" : "user-approval";
  return "not-applicable";
}

/**
 * Which tools of one connector a person approved in one session, and under
 * which permission version: `{ [tool]: version }`. One doc per session and
 * connector, written only by the approval response policy, so only an actual
 * approval lands here. Durable rather than held by the connection, which eve
 * rebuilds every turn and which may live in another instance.
 */
const approvalsKey = (sessionId: string, connectorId: string) => `approvals/connectors/${sessionId}/${connectorId}.json`;

type ConnectorApprovals = Readonly<Record<string, number>>;

/** The version `tool` was last approved under in this session, or null (never, or unreadable: either way, ask). */
export async function approvedVersion(sessionId: string, connectorId: string, tool: string): Promise<number | null> {
  try {
    const approvals = (await readDoc<ConnectorApprovals>(approvalsKey(sessionId, connectorId)))?.value;
    const version = approvals !== undefined && Object.hasOwn(approvals, tool) ? approvals[tool] : undefined;
    return typeof version === "number" ? version : null;
  } catch {
    return null;
  }
}

/**
 * Records that a person approved `tool` under `version`. One CAS on one doc;
 * setting a key to a value is idempotent, so a retried or replayed approval
 * (or a Blob write whose reply was lost) changes nothing the second time.
 */
export async function recordApproval(sessionId: string, connectorId: string, tool: string, version: number): Promise<void> {
  await updateDoc<ConnectorApprovals>(approvalsKey(sessionId, connectorId), (current) =>
    current !== null && Object.hasOwn(current, tool) && current[tool] === version ? null : { ...current, [tool]: version },
  );
}

/**
 * How long an approval waits for its record. eve gives a response policy 10s
 * before it fails the approval, and a failed approval leaves the person
 * stuck; a record that is late (or lost) only means the next call asks again.
 */
const RECORD_WAIT_MS = 5_000;

/** Best effort and bounded: an approval never fails, or waits long, because its record could not be written. */
async function noteApproved(connector: Connector, sessionId: string, toolName: string): Promise<void> {
  const work = (async () => {
    const live = await liveConnector(connector);
    if (live === null || !live.enabled) return;
    await recordApproval(sessionId, live.id, bareTool(live.name, toolName), permissionVersion(live));
  })().catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work, new Promise<void>((resolve) => (timer = setTimeout(resolve, RECORD_WAIT_MS)))]);
  clearTimeout(timer);
}

/** The live record, or null when it is gone or cannot be read: either way, nothing is allowed. */
async function liveConnector(connector: Connector): Promise<Connector | null> {
  try {
    return await getConnector(connector.workspaceId, connector.id);
  } catch {
    return null;
  }
}

/**
 * A check on the calling session itself, made before the connector's own
 * rules: for a Bot at work, whether it is still its job's current run (see
 * `guardSideEffect`). A denial carries the reason the model sees.
 */
export type CallerCheck = (ctx: ApprovalContext) => Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;

/**
 * The connection eve gets for one stored connector, or null when it offers
 * nothing to this audience. `checkCaller`, when given, runs before every call:
 * a Bot whose job was cancelled or taken over by a newer run gets no further
 * connector calls, reads included, the same as its other tools.
 */
export function connectorConnection(
  connector: Connector,
  audience: Audience,
  options: { readonly checkCaller?: CallerCheck } = {},
): McpClientConnectionDefinition | null {
  if (!connector.enabled) return null;
  const allow = allowedTools(connector, { readsOnly: audience === "hq" });
  if (allow.length === 0) return null;

  /** The record a request may go out under, or a thrown error when there is none; never a credential from the snapshot. */
  const usable = async (): Promise<Connector> => {
    const live = await liveConnector(connector);
    if (live === null) throw new ConnectionAuthorizationFailedError(connector.name, { reason: "connector_removed", retryable: false });
    if (!live.enabled) throw new ConnectionAuthorizationFailedError(connector.name, { reason: "connector_disabled", retryable: false });
    return live;
  };

  return defineMcpClientConnection({
    url: connector.url,
    description: audience === "hq" ? `${connector.description} (read-only for HQ)` : connector.description,
    instanceKey: connector.id,
    // An OAuth connector's token is read and refreshed per connection; without a sign-in, eve is told to ask for one.
    ...(connector.auth.kind === "oauth"
      ? {
          auth: {
            displayName: connector.label,
            getToken: async () => {
              const live = await usable();
              const token = await connectorToken(live);
              if (token === null) throw new ConnectionAuthorizationRequiredError(connector.name);
              return token;
            },
          },
        }
      : {}),
    // Read from the live record each time eve connects: a rotated key is the one sent; a removed connector sends nothing.
    headers: async () => {
      const live = await usable();
      return live.auth.kind === "oauth" ? {} : connectorHeaders(live);
    },
    tools: { allow },
    approval: {
      request: async (ctx: ApprovalContext) => {
        if (options.checkCaller !== undefined) {
          const caller = await options.checkCaller(ctx);
          if (!caller.ok) return deny(caller.message);
        }
        const live = await liveConnector(connector);
        // Only the "all" gate depends on a past approval; the read is skipped otherwise.
        const approvedAt =
          audience === "bot" && live?.enabled === true && live.gate === "all" ? await approvedVersion(ctx.session.id, live.id, bareTool(live.name, ctx.toolName)) : null;
        return decideCall({ audience, live, toolName: ctx.toolName, approvedAt });
      },
      // Runs only on an approval. It records and always allows: rejecting here would leave the request pending.
      response: async ({ request, session }: ApprovalResponseContext) => {
        await noteApproved(connector, session.id, request.toolName);
        return { status: "allowed" };
      },
    },
  });
}
