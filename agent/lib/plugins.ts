import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { computerKey } from "./computer/keys";
import { newId } from "./ids";
import { deleteDoc, listDocs, readDoc, updateDoc, writeDoc } from "./store";

/**
 * Plugins: MCP servers the team connected, the way Grok Bot has them.
 *
 * They are account-wide: every Bot in the workspace can use every enabled
 * plugin, and a Bot prefers a plugin over clicking through a website that
 * offers one. v1 connects any MCP server that speaks Streamable HTTP, with no
 * key, a bearer key, or a key in a custom header. Keys are stored encrypted and
 * decrypted only inside a Bot's connection; the model never sees them.
 */
export type PluginKeyKind = "none" | "bearer" | "header";

type SealedAuth =
  | { readonly kind: "none" }
  | { readonly kind: "bearer"; readonly sealed: string }
  | { readonly kind: "header"; readonly header: string; readonly sealed: string };

export interface PluginCheck {
  readonly ok: boolean;
  readonly at: string;
  readonly tools: readonly string[];
  readonly error: string | null;
}

export interface Plugin {
  readonly id: string;
  readonly workspaceId: string;
  /** The connection name a Bot calls tools under: `<name>__<tool>`. */
  readonly name: string;
  readonly label: string;
  readonly url: string;
  readonly description: string;
  readonly auth: SealedAuth;
  readonly enabled: boolean;
  /** Ask a person before a Bot first uses this plugin in a job. */
  readonly askFirst: boolean;
  readonly check: PluginCheck;
  readonly createdAt: string;
  readonly createdBy: string;
}

/** What the console sees: which kind of key, never the key. */
export type PublicPlugin = Omit<Plugin, "auth"> & {
  readonly auth: { readonly kind: PluginKeyKind; readonly header?: string };
};

export interface PluginInput {
  readonly label: string;
  readonly url: string;
  readonly description?: string;
  readonly key: { readonly kind: PluginKeyKind; readonly header?: string; readonly secret?: string };
  readonly askFirst?: boolean;
}

const LABEL_MAX = 60;
const DESCRIPTION_MAX = 400;
const SECRET_MAX = 4_000;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const PROBE_TIMEOUT_MS = 15_000;

const key = (workspaceId: string, id: string) => `plugins/${workspaceId}/${id}.json`;

export async function listPlugins(workspaceId: string): Promise<Plugin[]> {
  const plugins = await listDocs<Plugin>(`plugins/${workspaceId}/`);
  return plugins.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function getPlugin(workspaceId: string, id: string): Promise<Plugin | null> {
  return (await readDoc<Plugin>(key(workspaceId, id)))?.value ?? null;
}

export function publicPlugin(plugin: Plugin): PublicPlugin {
  const auth = plugin.auth.kind === "header" ? { kind: "header" as const, header: plugin.auth.header } : { kind: plugin.auth.kind };
  return { ...plugin, auth };
}

/** Checks the input, reaches the server with it, and stores the plugin only if that worked. */
export async function addPlugin(
  workspaceId: string,
  createdBy: string,
  input: PluginInput,
): Promise<{ ok: true; plugin: Plugin } | { ok: false; error: string }> {
  const label = input.label.trim().slice(0, LABEL_MAX);
  if (label === "") return { ok: false, error: "Give the plugin a name." };
  const url = checkUrl(input.url);
  if (typeof url !== "string") return { ok: false, error: url.error };
  const secret = input.key.secret?.trim() ?? "";
  if (input.key.kind !== "none" && (secret === "" || secret.length > SECRET_MAX)) {
    return { ok: false, error: "Paste the key the server expects." };
  }
  if (input.key.kind === "header" && !HEADER_NAME.test(input.key.header ?? "")) {
    return { ok: false, error: "Header names use letters, digits, and dashes, such as X-Api-Key." };
  }

  const headers = headersFor(input.key.kind, input.key.header ?? "", secret);
  const probe = await probeMcp(url, headers);
  if (!probe.ok) return { ok: false, error: probe.error ?? "The server did not answer like an MCP server." };

  const existing = await listPlugins(workspaceId);
  const now = new Date().toISOString();
  const plugin: Plugin = {
    id: newId("plugin"),
    workspaceId,
    name: uniqueName(label, existing.map((entry) => entry.name)),
    label,
    url,
    description:
      input.description?.trim().slice(0, DESCRIPTION_MAX) ||
      `${label}: tools from ${new URL(url).host}. ${probe.tools.slice(0, 8).join(", ")}`.slice(0, DESCRIPTION_MAX),
    auth: await seal(input.key.kind, input.key.header ?? "", secret),
    enabled: true,
    askFirst: input.askFirst === true,
    check: probe,
    createdAt: now,
    createdBy,
  };
  await writeDoc(key(workspaceId, plugin.id), plugin);
  return { ok: true, plugin };
}

export async function updatePlugin(
  workspaceId: string,
  id: string,
  patch: { enabled?: boolean; askFirst?: boolean; description?: string; check?: PluginCheck },
): Promise<Plugin | null> {
  return updateDoc<Plugin>(key(workspaceId, id), (current) =>
    current === null
      ? null
      : {
          ...current,
          ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
          ...(patch.askFirst === undefined ? {} : { askFirst: patch.askFirst }),
          ...(patch.description === undefined ? {} : { description: patch.description.trim().slice(0, DESCRIPTION_MAX) }),
          ...(patch.check === undefined ? {} : { check: patch.check }),
        },
  );
}

export async function removePlugin(workspaceId: string, id: string): Promise<boolean> {
  if ((await getPlugin(workspaceId, id)) === null) return false;
  await deleteDoc(key(workspaceId, id));
  return true;
}

/** Reaches the server again with its stored key and records what it offers now. */
export async function recheckPlugin(plugin: Plugin): Promise<Plugin | null> {
  const check = await probeMcp(plugin.url, await pluginHeaders(plugin));
  return updatePlugin(plugin.workspaceId, plugin.id, { check });
}

/** The plugin's request headers with its key unsealed. Only for server-side calls. */
export async function pluginHeaders(plugin: Plugin): Promise<Record<string, string>> {
  if (plugin.auth.kind === "none") return {};
  const secret = await unseal(plugin.auth.sealed);
  return headersFor(plugin.auth.kind, plugin.auth.kind === "header" ? plugin.auth.header : "", secret);
}

function headersFor(kind: PluginKeyKind, header: string, secret: string): Record<string, string> {
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
    return { error: "Plugins connect over https." };
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
      .slice(0, 40) || "plugin";
  let name = base;
  for (let n = 2; taken.includes(name); n += 1) name = `${base}-${n}`;
  return name;
}

// ─── Keys at rest ────────────────────────────────────────────────────────────

async function sealingKey(): Promise<Buffer> {
  return createHash("sha256").update(`bot-plugins:${await computerKey()}`).digest();
}

async function seal(kind: PluginKeyKind, header: string, secret: string): Promise<SealedAuth> {
  if (kind === "none") return { kind };
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await sealingKey(), iv);
  const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const sealed = [iv, cipher.getAuthTag(), body].map((part) => part.toString("base64url")).join(".");
  return kind === "header" ? { kind, header, sealed } : { kind, sealed };
}

async function unseal(sealed: string): Promise<string> {
  const [iv, tag, body] = sealed.split(".").map((part) => Buffer.from(part, "base64url"));
  if (iv === undefined || tag === undefined || body === undefined) throw new Error("A plugin key is damaged; add the plugin again.");
  const decipher = createDecipheriv("aes-256-gcm", await sealingKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

// ─── Reaching an MCP server ──────────────────────────────────────────────────

/**
 * Connects the way a Bot will (Streamable HTTP), asks for the tool list, and
 * hangs up. Enough to prove the address and key work before a Bot relies on them.
 */
export async function probeMcp(url: string, headers: Record<string, string>): Promise<PluginCheck> {
  const at = new Date().toISOString();
  try {
    const init = await rpc(url, headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "bot-plugins", version: "1" } },
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
