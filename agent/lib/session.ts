import type { SessionAuthContext, SessionContext } from "eve/context";

/** The slice of context both ordinary tools and workflow tools share. */
export type AuthedContext = Pick<SessionContext, "session">;

export interface Operator {
  /** Stable id of whoever this turn is acting for. Never taken from model input. */
  readonly id: string;
  readonly label: string;
  /** Isolation boundary for every stored record. */
  readonly workspaceId: string;
  /** True when the turn was started by a schedule or the runtime itself. */
  readonly automated: boolean;
}

function attribute(auth: SessionAuthContext | null, key: string): string | undefined {
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

  return {
    id: auth?.principalId ?? "local",
    label: attribute(auth, "name") ?? auth?.subject ?? auth?.principalId ?? "local operator",
    workspaceId,
    automated: auth?.principalType === "runtime",
  };
}
