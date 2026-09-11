import type { SessionAuthContext, SessionContext } from "eve/context";

import { HQ_ROOM, botIdForRoom } from "./rooms";

/**
 * The slice of context `operator` needs: the session's auth. Ordinary tools,
 * workflow tools, and dynamic resolvers (which see no turn) all have it.
 */
export type AuthedContext = { readonly session: Pick<SessionContext["session"], "auth"> };

export interface Operator {
  /** Stable id of whoever this turn is acting for. Never taken from model input. */
  readonly id: string;
  readonly label: string;
  /** Isolation boundary for every stored record. */
  readonly workspaceId: string;
  /** The conversation this turn belongs to: HQ's desk or a bot's own thread. */
  readonly room: string;
  /** Set when the operator is talking to one bot directly, in its own thread. */
  readonly botId: string | null;
  /** True when the turn was started by a schedule or the runtime itself. */
  readonly automated: boolean;
}

export function attribute(auth: SessionAuthContext | null | undefined, key: string): string | undefined {
  const value = auth?.attributes[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

/**
 * Resolves who the agent is working for from trusted channel auth.
 *
 * The workspace is what scopes the roster, the job queue, and the feed, so it
 * comes from the authenticated principal's attributes — never from a tool
 * argument the model could invent.
 */
export function operator(ctx: AuthedContext): Operator {
  const auth = ctx.session.auth.current ?? ctx.session.auth.initiator;
  const initiator = ctx.session.auth.initiator;
  const workspaceId =
    attribute(auth, "workspaceId") ??
    attribute(auth, "tenantId") ??
    attribute(initiator, "workspaceId") ??
    process.env.BOT_DEFAULT_WORKSPACE ??
    "default";
  const room = attribute(auth, "room") ?? attribute(initiator, "room") ?? HQ_ROOM;

  return {
    id: auth?.principalId ?? "local",
    label: attribute(auth, "name") ?? auth?.subject ?? auth?.principalId ?? "local operator",
    workspaceId,
    room,
    botId: botIdForRoom(room),
    automated: auth?.principalType === "runtime",
  };
}
