import type { ApprovalStatus } from "eve/tools/approval";

import { toolEffect } from "./catalog";
import { allowedTools, type Connector, permissionVersion } from "./connectors";

/**
 * Whether one connector call may go ahead, needs a person, or is refused,
 * from the live connector record. Pure, and free of eve's connection code, so
 * the eve Bots' connections (`connector-connection.ts`) and the Claude Code
 * and Codex Bots' connector tools (`engines/connector-calls.ts`) decide alike.
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

