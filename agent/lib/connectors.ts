import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import {
  type CatalogEntry,
  catalogEntry,
  type ConnectorGate,
  type ConnectorKeyKind,
  mergePolicy,
  type ToolEffect,
  type ToolPolicy,
} from "./catalog";
import { computerKey } from "./computer/keys";
import { newId } from "./ids";
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
  | { readonly kind: "header"; readonly header: string; readonly sealed: string };

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
  readonly check: ConnectorCheck;
  readonly createdAt: string;
  readonly createdBy: string;
}

/** What the console sees: which kind of key, never the key. */
export type PublicConnector = Omit<Connector, "auth"> & {
  readonly auth: { readonly kind: ConnectorKeyKind; readonly header?: string };
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
    connector.auth.kind === "header" ? { kind: "header" as const, header: connector.auth.header } : { kind: connector.auth.kind };
  return { ...connector, auth };
}

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
  const kind: ConnectorKeyKind = entry?.key.kind ?? input.key?.kind ?? "none";
  const header = entry?.key.header ?? input.key?.header ?? "";
  const secret = input.key?.secret?.trim() ?? "";
  if (kind !== "none" && (secret === "" || secret.length > SECRET_MAX)) {
    return { ok: false, error: entry === undefined ? "Paste the key the server expects." : `Paste a ${entry.label} key.` };
  }
  if (kind === "header" && !HEADER_NAME.test(header)) {
    return { ok: false, error: "Header names use letters, digits, and dashes, such as X-Api-Key." };
  }
  const gate: ConnectorGate = input.gate !== undefined && GATES.includes(input.gate) ? input.gate : (entry?.gate ?? "none");

  const headers = headersFor(kind, header, secret);
  const probe = await probeMcp(url, headers);
  if (!probe.ok) return { ok: false, error: probe.error ?? "The server did not answer like an MCP server." };

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
    auth: await seal(kind, header, secret),
    enabled: true,
    gate,
    policy: mergePolicy(undefined, probe.tools),
    check: probe,
    createdAt: now,
    createdBy,
  };
  await writeDoc(key(workspaceId, connector.id), connector);
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
  },
): Promise<Connector | null> {
  return updateDoc<Connector>(key(workspaceId, id), (current) =>
    current === null
      ? null
      : {
          ...current,
          ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
          ...(patch.gate === undefined || !GATES.includes(patch.gate) ? {} : { gate: patch.gate }),
          ...(patch.description === undefined ? {} : { description: patch.description.trim().slice(0, DESCRIPTION_MAX) }),
          ...(patch.check === undefined ? {} : { check: patch.check }),
          ...(patch.policy === undefined ? {} : { policy: { ...current.policy, ...patch.policy } }),
        },
  );
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
  const secret = await unseal(connector.auth.sealed);
  return headersFor(connector.auth.kind, connector.auth.kind === "header" ? connector.auth.header : "", secret);
}

function headersFor(kind: ConnectorKeyKind, header: string, secret: string): Record<string, string> {
  if (kind === "bearer") return { authorization: `Bearer ${secret}` };
  if (kind === "header") return { [header]: secret };
  return {};
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

async function seal(kind: ConnectorKeyKind, header: string, secret: string): Promise<SealedAuth> {
  if (kind === "none") return { kind };
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
