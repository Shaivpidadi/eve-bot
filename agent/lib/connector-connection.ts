import { ConnectionAuthorizationFailedError, ConnectionAuthorizationRequiredError, defineMcpClientConnection, type McpClientConnectionDefinition } from "eve/connections";
import type { ApprovalContext, ApprovalStatus } from "eve/tools/approval";

import { toolEffect } from "./catalog";
import { allowedTools, type Connector, connectorHeaders, connectorToken, getConnector, permissionVersion } from "./connectors";

/**
 * One connector as an eve MCP connection, for HQ or for a Bot at work.
 *
 * What a session is set up with is only a starting point. Settings change
 * while sessions run (a connector switched off, a tool switched off, a tool
 * re-marked as a change, a key rotated, a connector removed), and each of
 * those has to bite on the next call, not the next session. So every hook
 * eve offers re-reads the stored connector and fails closed:
 *
 * - `approval` runs before every tool call with the tool's name. It decides
 *   from the live record: gone, off, tool not allowed (for HQ: not a reviewed
 *   read) is a denial with a reason the model sees; otherwise the live gate
 *   and live policy decide whether a person is asked.
 * - `headers` and `getToken` run when eve opens the connection to the server.
 *   They read the key from the live record, so a rotated key is the one sent,
 *   and a removed or switched-off connector gets no credentials at all.
 * - `tools.allow` is always the checked list, so a tool the server grew since
 *   the last check is never offered, even when nothing was switched off.
 *
 * eve caches an open connection (and the headers it was opened with) until
 * the connection set is replaced; the resolvers in `connections/` re-resolve
 * on every turn, so a new key is in use from the next turn. Within a turn the
 * approval check is what stops a call.
 */
export type Audience = "hq" | "bot";

/** A denial the model sees as the tool's result. */
const deny = (reason: string): ApprovalStatus => ({ type: "denied", reason });

/**
 * The per-call decision, given the live record. Pure, so the rules can be
 * tested without eve.
 *
 * `version` is the permission version the session was set up with. When the
 * live record is newer, an approval given in this session ("once" per tool)
 * was given under old settings and is not reused: the person is asked again,
 * once, and `reapproved` remembers that they were.
 */
export function decideCall(input: {
  readonly audience: Audience;
  readonly live: Connector | null;
  readonly version: number;
  readonly toolName: string;
  readonly approvedTools: ReadonlySet<string>;
  readonly reapproved: Set<string>;
}): ApprovalStatus {
  const { audience, live, toolName } = input;
  if (live === null) return deny("This connector was removed; its tools can no longer be used.");
  if (!live.enabled) return deny(`${live.label} is switched off on the Connectors page.`);
  const bare = toolName.startsWith(`${live.name}__`) ? toolName.slice(live.name.length + 2) : (toolName.split("__").pop() ?? toolName);
  if (!allowedTools(live, { readsOnly: audience === "hq" }).includes(bare)) {
    return audience === "hq"
      ? deny(`HQ only uses ${live.label} tools a person confirmed only read; hand this to a Bot as a job.`)
      : deny(`${bare} is not one of the ${live.label} tools a Bot may use.`);
  }
  if (audience === "hq") return "not-applicable";
  if (live.gate === "writes") return toolEffect(live, bare).effect === "write" ? "user-approval" : "not-applicable";
  if (live.gate === "all") {
    const stale = permissionVersion(live) !== input.version;
    if (input.approvedTools.has(toolName) && (!stale || input.reapproved.has(toolName))) return "not-applicable";
    if (stale) input.reapproved.add(toolName);
    return "user-approval";
  }
  return "not-applicable";
}

/** The live record, or null when it is gone or cannot be read: either way, nothing is allowed. */
async function liveConnector(connector: Connector): Promise<Connector | null> {
  try {
    return await getConnector(connector.workspaceId, connector.id);
  } catch {
    return null;
  }
}

/** The connection eve gets for one stored connector, or null when it offers nothing to this audience. */
export function connectorConnection(connector: Connector, audience: Audience): McpClientConnectionDefinition | null {
  if (!connector.enabled) return null;
  const allow = allowedTools(connector, { readsOnly: audience === "hq" });
  if (allow.length === 0) return null;
  const version = permissionVersion(connector);
  const reapproved = new Set<string>();

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
    approval: async ({ toolName, approvedTools }: ApprovalContext) =>
      decideCall({ audience, live: await liveConnector(connector), version, toolName, approvedTools, reapproved }),
  });
}
