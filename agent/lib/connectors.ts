import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { catalogEntry, effectOf, mergePolicy, type CatalogEntry, type ConnectorGate, type ConnectorKeyKind, type ToolEffect, type ToolPolicy } from "./catalog";
import { authorizeUrl, beginPkce, discover, exchangeCode, needsRefresh, type OAuthClient, type OAuthMetadata, refreshTokens, registerClient, type TokenSet } from "./connector-oauth";
import { computerKey } from "./computer/keys";
import { newId } from "./ids";
import { watchToolPolicy } from "./jev-watch";
import { deleteDoc, listDocs, readDoc, updateDoc, writeDoc } from "./store";

/**
 * Connectors: the services the team connected, for every Bot.
 *
 * They are account-wide: every Bot in the workspace can use every enabled
 * connector, and a Bot prefers a connector over clicking through a website
 * that offers one. A connector is an MCP server that speaks Streamable HTTP,
 * either a built-in one from the catalog (`catalog.ts`), added by name, or a
 * custom address the team pastes, with no key, a bearer key, or a key in a
 * custom header. Keys are stored encrypted and decrypted only inside a Bot's
 * connection; the model never sees them.
 */
export type { ConnectorGate, ConnectorKeyKind };

type SealedAuth =
  | { readonly kind: "none" }
  | { readonly kind: "bearer"; readonly sealed: string }
  | { readonly kind: "header"; readonly header: string; readonly sealed: string }
  | {
      readonly kind: "oauth";
      readonly metadata: OAuthMetadata;
      /** This app, registered with the server for one redirect URI; null until the first connect. */
      readonly client: OAuthClient | null;
      /** The token set, sealed; null until the person has signed in, or after they disconnect. */
      readonly sealed: string | null;
      readonly connectedAt: string | null;
    };

export interface ConnectorCheck {
  readonly ok: boolean;
  readonly at: string;
  readonly tools: readonly string[];
  readonly error: string | null;
}

export interface Connector {
  readonly id: string;
  readonly workspaceId: string;
  /** The connection name a Bot calls tools under: `<name>__<tool>`. */
  readonly name: string;
  readonly label: string;
  /** The catalog entry this came from, or null for a custom server. */
  readonly catalog: string | null;
  readonly url: string;
  readonly description: string;
  readonly auth: SealedAuth;
  readonly enabled: boolean;
  /** When a person is asked before a Bot uses it: never, before changes, or before every first use. */
  readonly gate: ConnectorGate;
  /**
   * What each of the server's tools does, read or write, as this workspace has
   * it recorded. Set from the tool names when the connector is added, and the
   * operator's to correct. A tool missing from it counts as a write.
   */
  readonly policy?: ToolPolicy;
  /** Tools the operator switched off; Bots and HQ never see them. Absent means all on. */
  readonly disabledTools?: readonly string[];
  readonly check: ConnectorCheck;
  readonly createdAt: string;
  readonly createdBy: string;
}

/** What the console sees: which kind of key, never the key; for OAuth, whether someone has signed in. */
export type PublicConnector = Omit<Connector, "auth"> & {
  readonly auth: { readonly kind: ConnectorKeyKind; readonly header?: string; readonly connected?: boolean; readonly connectedAt?: string | null; readonly issuer?: string };
};

export interface ConnectorInput {
  /** A catalog id fills in the address, key kind, and description; the rest is custom. */
  readonly catalog?: string;
  readonly label?: string;
  readonly url?: string;
  readonly description?: string;
  readonly key?: { readonly kind?: ConnectorKeyKind; readonly header?: string; readonly secret?: string };
  readonly gate?: ConnectorGate;
}

const LABEL_MAX = 60;
const DESCRIPTION_MAX = 400;
const SECRET_MAX = 4_000;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const PROBE_TIMEOUT_MS = 15_000;

const key = (workspaceId: string, id: string) => `connectors/${workspaceId}/${id}.json`;

export async function listConnectors(workspaceId: string): Promise<Connector[]> {
  const connectors = await listDocs<Connector>(`connectors/${workspaceId}/`);
  return connectors.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function getConnector(workspaceId: string, id: string): Promise<Connector | null> {
  return (await readDoc<Connector>(key(workspaceId, id)))?.value ?? null;
}

export function publicConnector(connector: Connector): PublicConnector {
  const auth =
    connector.auth.kind === "header"
      ? { kind: "header" as const, header: connector.auth.header }
      : connector.auth.kind === "oauth"
        ? { kind: "oauth" as const, connected: connector.auth.sealed !== null, connectedAt: connector.auth.connectedAt, issuer: connector.auth.metadata.issuer }
        : { kind: connector.auth.kind };
  return { ...connector, auth };
}

/** A connector that signs in through the server's own OAuth and has not yet. */
export const needsConnect = (connector: Connector): boolean => connector.auth.kind === "oauth" && connector.auth.sealed === null;

const GATES: readonly ConnectorGate[] = ["none", "writes", "all"];

/**
 * Checks the input, reaches the server with it, and stores the connector only
 * if that worked. A catalog id supplies the address, key kind, description,
 * and default gate; a custom server supplies them itself.
 */
export async function addConnector(
  workspaceId: string,
  createdBy: string,
  input: ConnectorInput,
): Promise<{ ok: true; connector: Connector } | { ok: false; error: string }> {
  const entry: CatalogEntry | undefined = input.catalog === undefined ? undefined : catalogEntry(input.catalog);
  if (input.catalog !== undefined && entry === undefined) return { ok: false, error: "That is not a connector Bot knows." };

  const label = (input.label ?? entry?.label ?? "").trim().slice(0, LABEL_MAX);
  if (label === "") return { ok: false, error: "Give the connector a name." };
  const url = checkUrl(entry?.url ?? input.url ?? "");
  if (typeof url !== "string") return { ok: false, error: url.error };
  let kind: ConnectorKeyKind = entry?.key.kind ?? input.key?.kind ?? "none";
  const header = entry?.key.header ?? input.key?.header ?? "";
  const secret = input.key?.secret?.trim() ?? "";
  if (kind !== "none" && kind !== "oauth" && (secret === "" || secret.length > SECRET_MAX)) {
    return { ok: false, error: entry === undefined ? "Paste the key the server expects." : `Paste a ${entry.label} key.` };
  }
  if (kind === "header" && !HEADER_NAME.test(header)) {
    return { ok: false, error: "Header names use letters, digits, and dashes, such as X-Api-Key." };
  }
  const gate: ConnectorGate = input.gate !== undefined && GATES.includes(input.gate) ? input.gate : (entry?.gate ?? "none");

  // A server that runs its own OAuth is connected in two steps: saved now, signed in from the page.
  // A custom server added with no key is asked what it wants, so one that needs OAuth gets it without anyone knowing the word.
  let oauth: OAuthMetadata | null = null;
  if (kind === "oauth" || (kind === "none" && entry === undefined)) {
    const found = await discover(url);
    if (found.kind === "oauth") {
      oauth = found.metadata;
      kind = "oauth";
    } else if (kind === "oauth") {
      return { ok: false, error: found.kind === "unreachable" ? found.error : "This server does not sign people in on its own; it needs a key." };
    }
  }

  const probe: ConnectorCheck = oauth !== null ? { ok: false, at: new Date().toISOString(), tools: [], error: "Connect to finish setting it up." } : await probeMcp(url, headersFor(kind, header, secret));
  if (oauth === null && !probe.ok) return { ok: false, error: probe.error ?? "The server did not answer like an MCP server." };

  const existing = await listConnectors(workspaceId);
  if (entry !== undefined && existing.some((current) => current.catalog === entry.id)) {
    return { ok: false, error: `${entry.label} is already connected.` };
  }
  const now = new Date().toISOString();
  const connector: Connector = {
    id: newId("conn"),
    workspaceId,
    name: uniqueName(entry?.id ?? label, existing.map((current) => current.name)),
    label,
    catalog: entry?.id ?? null,
    url,
    description:
      input.description?.trim().slice(0, DESCRIPTION_MAX) ||
      entry?.description ||
      `${label}: tools from ${new URL(url).host}. ${probe.tools.slice(0, 8).join(", ")}`.slice(0, DESCRIPTION_MAX),
    auth: oauth !== null ? { kind: "oauth", metadata: oauth, client: null, sealed: null, connectedAt: null } : await seal(kind, header, secret),
    enabled: true,
    gate,
    policy: mergePolicy(undefined, probe.tools),
    check: probe,
    createdAt: now,
    createdBy,
  };
  await writeDoc(key(workspaceId, connector.id), connector);
  // A second opinion on the classification, recorded only; nothing here defers to it.
  await watchToolPolicy(workspaceId, connector.id, probe.tools, connector.policy ?? {});
  return { ok: true, connector };
}

export async function updateConnector(
  workspaceId: string,
  id: string,
  patch: {
    enabled?: boolean;
    gate?: ConnectorGate;
    description?: string;
    check?: ConnectorCheck;
    /** Corrections to what a tool does, merged over what is recorded. */
    policy?: Readonly<Record<string, ToolEffect>>;
    /** Tools switched on (true) or off (false), merged over what is recorded. */
    tools?: Readonly<Record<string, boolean>>;
  },
): Promise<Connector | null> {
  return updateDoc<Connector>(key(workspaceId, id), (current) => {
    if (current === null) return null;
    const disabled = new Set(current.disabledTools ?? []);
    for (const [tool, on] of Object.entries(patch.tools ?? {})) if (on) disabled.delete(tool); else disabled.add(tool);
    return {
      ...current,
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...(patch.gate === undefined || !GATES.includes(patch.gate) ? {} : { gate: patch.gate }),
      ...(patch.description === undefined ? {} : { description: patch.description.trim().slice(0, DESCRIPTION_MAX) }),
      ...(patch.check === undefined ? {} : { check: patch.check }),
      ...(patch.policy === undefined ? {} : { policy: { ...current.policy, ...patch.policy } }),
      ...(patch.tools === undefined ? {} : { disabledTools: [...disabled].sort() }),
    };
  });
}

/**
 * The tools a connector offers right now: what the server listed at the last
 * check, less what the operator switched off, and for HQ only those that read.
 */
export function allowedTools(connector: Pick<Connector, "check" | "disabledTools" | "policy">, options: { readonly readsOnly?: boolean } = {}): string[] {
  const off = new Set(connector.disabledTools ?? []);
  return connector.check.tools.filter((tool) => !off.has(tool) && (!options.readsOnly || effectOf(connector.policy, tool) === "read"));
}

/**
 * Swaps the key a connector uses, after proving the server accepts the new one.
 * The old key stays until then, so a typo never breaks a working connector.
 */
export async function replaceKey(
  workspaceId: string,
  id: string,
  input: { readonly kind?: ConnectorKeyKind; readonly header?: string; readonly secret: string },
): Promise<{ ok: true; connector: Connector } | { ok: false; error: string }> {
  const current = await getConnector(workspaceId, id);
  if (current === null) return { ok: false, error: "no such connector" };
  if (current.auth.kind === "oauth") return { ok: false, error: "This connector signs in through the server; reconnect it instead of pasting a key." };
  const kind: ConnectorKeyKind = input.kind ?? current.auth.kind;
  const header = input.header ?? (current.auth.kind === "header" ? current.auth.header : "");
  const secret = input.secret.trim();
  if (kind !== "none" && (secret === "" || secret.length > SECRET_MAX)) return { ok: false, error: "Paste the new key." };
  if (kind === "header" && !HEADER_NAME.test(header)) return { ok: false, error: "Header names use letters, digits, and dashes, such as X-Api-Key." };
  const probe = await probeMcp(current.url, headersFor(kind, header, secret));
  if (!probe.ok) return { ok: false, error: probe.error ?? "The server did not accept that key." };
  const auth = await seal(kind, header, secret);
  const updated = await updateDoc<Connector>(key(workspaceId, id), (record) =>
    record === null ? null : { ...record, auth, check: probe, policy: mergePolicy(record.policy, probe.tools) },
  );
  return updated === null ? { ok: false, error: "no such connector" } : { ok: true, connector: updated };
}

export async function removeConnector(workspaceId: string, id: string): Promise<boolean> {
  if ((await getConnector(workspaceId, id)) === null) return false;
  await deleteDoc(key(workspaceId, id));
  return true;
}

/** Reaches the server again with its stored key and records what it offers now. */
export async function recheckConnector(connector: Connector): Promise<Connector | null> {
  const check = await probeMcp(connector.url, await connectorHeaders(connector));
  return updateConnector(connector.workspaceId, connector.id, {
    check,
    ...(check.ok ? { policy: mergePolicy(connector.policy, check.tools) } : {}),
  });
}

/** The connector's request headers with its key unsealed. Only for server-side calls. */
export async function connectorHeaders(connector: Connector): Promise<Record<string, string>> {
  if (connector.auth.kind === "none") return {};
  if (connector.auth.kind === "oauth") {
    const token = await connectorToken(connector);
    return token === null ? {} : { authorization: `Bearer ${token.token}` };
  }
  const secret = await unseal(connector.auth.sealed);
  return headersFor(connector.auth.kind, connector.auth.kind === "header" ? connector.auth.header : "", secret);
}

function headersFor(kind: ConnectorKeyKind, header: string, secret: string): Record<string, string> {
  if (kind === "bearer") return { authorization: `Bearer ${secret}` };
  if (kind === "header") return { [header]: secret };
  return {};
}

// ─── OAuth the server runs itself ────────────────────────────────────────────

const pendingKey = (state: string) => `oauth-pending/${state}.json`;
const PENDING_MAX_AGE_MS = 15 * 60 * 1000;

interface Pending {
  readonly workspaceId: string;
  readonly connectorId: string;
  readonly verifier: string;
  readonly at: string;
}

/** Where a signing-in browser is sent back to. The same path everywhere, so the registered client stays valid. */
export const OAUTH_CALLBACK_PATH = "/bot/v1/oauth/callback";

/**
 * Starts signing in: registers this app with the server when it has not
 * been, or when the app's address changed, remembers the PKCE verifier under
 * a random state, and returns the consent URL to send the person to.
 */
export async function startOAuth(workspaceId: string, id: string, origin: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const connector = await getConnector(workspaceId, id);
  if (connector === null) return { ok: false, error: "no such connector" };
  if (connector.auth.kind !== "oauth") return { ok: false, error: "This connector uses a key, not a sign-in." };
  const redirectUri = `${origin.replace(/\/$/, "")}${OAUTH_CALLBACK_PATH}`;
  let client = connector.auth.client;
  if (client === null || client.redirectUri !== redirectUri) {
    try {
      client = await registerClient(connector.auth.metadata, redirectUri);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const registered = client;
    await updateDoc<Connector>(key(workspaceId, id), (current) => (current === null || current.auth.kind !== "oauth" ? null : { ...current, auth: { ...current.auth, client: registered } }));
  }
  const pkce = beginPkce(connector.auth.metadata.pkce);
  await writeDoc<Pending>(pendingKey(pkce.state), { workspaceId, connectorId: id, verifier: pkce.verifier, at: new Date().toISOString() });
  return { ok: true, url: authorizeUrl(connector.auth.metadata, client, pkce) };
}

/**
 * Finishes signing in when the server sends the browser back: exchanges the
 * code, seals the tokens on the connector, and reaches the server for its
 * tools. Returns where to send the browser next.
 */
export async function completeOAuth(state: string, code: string | null, failure: string | null): Promise<{ workspaceId: string; connectorId: string; error: string | null } | null> {
  const pending = (await readDoc<Pending>(pendingKey(state)))?.value;
  if (pending === undefined) return null;
  await deleteDoc(pendingKey(state)).catch(() => undefined);
  const { workspaceId, connectorId } = pending;
  const fail = async (error: string) => {
    await updateConnector(workspaceId, connectorId, { check: { ok: false, at: new Date().toISOString(), tools: [], error } });
    return { workspaceId, connectorId, error };
  };
  if (Date.now() - Date.parse(pending.at) > PENDING_MAX_AGE_MS) return fail("The sign-in took too long; try again.");
  if (failure !== null) return fail(`The server said no: ${failure}.`);
  if (code === null) return fail("The server sent no code back.");
  const connector = await getConnector(workspaceId, connectorId);
  if (connector === null || connector.auth.kind !== "oauth" || connector.auth.client === null) return fail("The connector changed while you were signing in.");
  let tokens: TokenSet;
  try {
    tokens = await exchangeCode(connector.auth.metadata, connector.auth.client, code, pending.verifier);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const auth = { ...connector.auth, sealed: await sealText(JSON.stringify(tokens)), connectedAt: new Date().toISOString() };
  const connected = await updateDoc<Connector>(key(workspaceId, connectorId), (current) => (current === null ? null : { ...current, auth }));
  if (connected !== null) await recheckConnector(connected);
  return { workspaceId, connectorId, error: null };
}

/** Forgets the sign-in but keeps the connector, so it can be connected again. */
export async function disconnectOAuth(workspaceId: string, id: string): Promise<boolean> {
  const updated = await updateDoc<Connector>(key(workspaceId, id), (current) =>
    current === null || current.auth.kind !== "oauth"
      ? null
      : { ...current, auth: { ...current.auth, sealed: null, connectedAt: null }, check: { ok: false, at: new Date().toISOString(), tools: current.check.tools, error: "Connect to finish setting it up." } },
  );
  return updated !== null;
}

/**
 * A live access token for an OAuth connector, refreshed when within five
 * minutes of expiry and the refresh saved. Null when nobody has signed in or
 * the refresh failed, which is when a Bot should ask the person to connect.
 */
export async function connectorToken(connector: Connector): Promise<{ readonly token: string; readonly expiresAt?: number } | null> {
  if (connector.auth.kind !== "oauth" || connector.auth.sealed === null || connector.auth.client === null) return null;
  let tokens: TokenSet;
  try {
    tokens = JSON.parse(await unseal(connector.auth.sealed)) as TokenSet;
  } catch {
    return null;
  }
  if (needsRefresh(tokens)) {
    try {
      tokens = await refreshTokens(connector.auth.metadata, connector.auth.client, tokens);
      const sealed = await sealText(JSON.stringify(tokens));
      await updateDoc<Connector>(key(connector.workspaceId, connector.id), (current) => (current === null || current.auth.kind !== "oauth" ? null : { ...current, auth: { ...current.auth, sealed } }));
    } catch {
      // The old token may still work for a few minutes; the next call finds out.
      if (tokens.expiresAt !== null && tokens.expiresAt <= Date.now()) return null;
    }
  }
  return { token: tokens.accessToken, ...(tokens.expiresAt === null ? {} : { expiresAt: tokens.expiresAt }) };
}

function checkUrl(raw: string): string | { error: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { error: "That is not a web address." };
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local && process.env.VERCEL !== "1")) {
    return { error: "Connectors connect over https." };
  }
  url.hash = "";
  return url.toString();
}

/** Lowercase letters, digits, and dashes, starting with a letter: what eve accepts as a connection name. */
function uniqueName(label: string, taken: readonly string[]): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^[^a-z]+/, "")
      .replace(/-+$/, "")
      .slice(0, 40) || "connector";
  let name = base;
  for (let n = 2; taken.includes(name); n += 1) name = `${base}-${n}`;
  return name;
}

// ─── Keys at rest ────────────────────────────────────────────────────────────

async function sealingKey(): Promise<Buffer> {
  return createHash("sha256").update(`bot-connectors:${await computerKey()}`).digest();
}

/** Seals any text with the workspace's key; the OAuth token set goes through here. */
async function sealText(text: string): Promise<string> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await sealingKey(), iv);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((part) => part.toString("base64url")).join(".");
}

async function seal(kind: ConnectorKeyKind, header: string, secret: string): Promise<SealedAuth> {
  if (kind === "none") return { kind };
  if (kind === "oauth") throw new Error("OAuth connectors are sealed from their token set, not a pasted key.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await sealingKey(), iv);
  const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const sealed = [iv, cipher.getAuthTag(), body].map((part) => part.toString("base64url")).join(".");
  return kind === "header" ? { kind, header, sealed } : { kind, sealed };
}

async function unseal(sealed: string): Promise<string> {
  const [iv, tag, body] = sealed.split(".").map((part) => Buffer.from(part, "base64url"));
  if (iv === undefined || tag === undefined || body === undefined) throw new Error("A connector key is damaged; add the connector again.");
  const decipher = createDecipheriv("aes-256-gcm", await sealingKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

// ─── Reaching an MCP server ──────────────────────────────────────────────────

/**
 * Connects the way a Bot will (Streamable HTTP), asks for the tool list, and
 * hangs up. Enough to prove the address and key work before a Bot relies on them.
 */
export async function probeMcp(url: string, headers: Record<string, string>): Promise<ConnectorCheck> {
  const at = new Date().toISOString();
  try {
    const init = await rpc(url, headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "bot-connectors", version: "1" } },
    });
    await rpc(url, headers, { jsonrpc: "2.0", method: "notifications/initialized" }, init.session).catch(() => undefined);
    const listed = await rpc(url, headers, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, init.session);
    const tools = Array.isArray((listed.result as { tools?: unknown })?.tools)
      ? ((listed.result as { tools: { name?: unknown }[] }).tools
          .map((tool) => tool.name)
          .filter((name): name is string => typeof name === "string"))
      : [];
    return { ok: true, at, tools, error: null };
  } catch (error) {
    return { ok: false, at, tools: [], error: error instanceof Error ? error.message : String(error) };
  }
}

async function rpc(
  url: string,
  headers: Record<string, string>,
  message: { jsonrpc: "2.0"; id?: number; method: string; params?: unknown },
  session?: string | null,
): Promise<{ result: unknown; session: string | null }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const nextSession = response.headers.get("mcp-session-id") ?? session ?? null;
  if (response.status === 401 || response.status === 403) throw new Error("The server turned the key down.");
  if (!response.ok && response.status !== 202) throw new Error(`The server answered ${response.status}.`);
  if (message.id === undefined || response.status === 202) {
    await response.body?.cancel();
    return { result: null, session: nextSession };
  }

  const type = response.headers.get("content-type") ?? "";
  const reply = type.includes("text/event-stream")
    ? await readEvent(response, message.id)
    : ((await response.json()) as { result?: unknown; error?: { message?: string } });
  if (reply?.error) throw new Error(reply.error.message ?? "The server reported an error.");
  if (reply === null || !("result" in reply)) throw new Error("The server did not answer like an MCP server.");
  return { result: reply.result, session: nextSession };
}

/** Reads a server-sent event stream until the reply to `id` arrives, then stops listening. */
async function readEvent(
  response: Response,
  id: number,
): Promise<{ result?: unknown; error?: { message?: string } } | null> {
  const reader = response.body?.getReader();
  if (reader === undefined) return null;
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        if (!line.startsWith("data:")) continue;
        try {
          const parsed = JSON.parse(line.slice(5).trim()) as { id?: unknown; result?: unknown; error?: { message?: string } };
          if (parsed.id === id) return parsed;
        } catch {
          // Not JSON: keep reading.
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
