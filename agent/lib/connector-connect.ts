import { getTokenResponse, revokeToken, startAuthorization, type ConnectTokenSubject } from "@vercel/connect";

/**
 * Connectors signed in through Vercel Connect (`auth.kind: "connect"`).
 *
 * Vercel Connect holds the provider's OAuth for this project: a connector made
 * with `vercel connect create` and attached to the project hands out tokens on
 * request, so none is ever kept in this app's store, exported or backed up.
 *
 * The grant belongs to the workspace, as an OAuth connector's sign-in does: one
 * person signs in from the Connectors page and every Bot in the workspace uses
 * it, scheduled work and teammates' notes included, which run with no person
 * there to ask (Connect's per-person grants could not serve them). Vercel only,
 * or wherever a Vercel OIDC token is present (`vercel env pull`); locally the
 * app's own OAuth stays.
 */

/** The namespace the workspace's grant lives under at Vercel Connect. Never change it: grants are keyed by it. */
const ISSUER = "urn:eve-bot";

export function workspaceSubject(workspaceId: string): ConnectTokenSubject {
  return { type: "user", id: `workspace:${workspaceId}`, issuer: ISSUER };
}

/** Connect's UID for a connector (`linear/acme-linear`) or its key (`scl_…`). */
export const CONNECT_ID = /^(?:[a-z0-9-]+\/[A-Za-z0-9._-]{1,100}|scl_[A-Za-z0-9]{8,64})$/;

/** Whether Connect asked for a sign-in rather than failing outright. */
function needsSignIn(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "user_authorization_required" || code === "unresolved_token" || code === "consent_required";
}

/** The workspace's live token, or null when nobody has signed in yet (or the grant was revoked). */
export async function connectToken(connector: string, workspaceId: string): Promise<{ readonly token: string; readonly expiresAt?: number } | null> {
  try {
    const response = await getTokenResponse(connector, { subject: workspaceSubject(workspaceId) });
    return { token: response.token, ...(typeof response.expiresAt === "number" ? { expiresAt: response.expiresAt } : {}) };
  } catch (error) {
    if (needsSignIn(error)) return null;
    throw error;
  }
}

/** Where to send the person to sign in, coming back to `callbackUrl` when done. */
export async function connectSignIn(connector: string, workspaceId: string, callbackUrl: string): Promise<string> {
  const started = await startAuthorization(connector, { subject: workspaceSubject(workspaceId) }, { callbackUrl });
  return started.url;
}

/** Ends the workspace's grant at Connect. */
export async function connectSignOut(connector: string, workspaceId: string): Promise<void> {
  await revokeToken(connector, { subject: workspaceSubject(workspaceId) });
}
