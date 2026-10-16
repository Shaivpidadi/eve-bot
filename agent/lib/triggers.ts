import { createHash } from "node:crypto";

import { createConnectWebhookVerifier, type ConnectWebhookVerifier } from "@vercel/connect/chat";

import { listDocs, readDoc, writeDoc } from "./store";

/**
 * Events from connected apps, forwarded by Vercel Connect (connector triggers).
 *
 * A provider's webhook (Linear's Issue and Comment events, for example) goes to
 * Vercel Connect, which checks the provider's signature and forwards the event
 * here with a Vercel OIDC token for this project and environment. Connect keeps
 * no copy and does not replay, so a delivery is stored in a durable inbox, once
 * per delivery id, before this server answers; acting on it happens after.
 *
 * Production (or a Custom Environment) only: Connect forwards to a deployment's
 * domain. Turned on per connector with `vercel connect attach … --triggers
 * --trigger-path /bot/v1/hooks/connect`.
 */
export const TRIGGER_PATH = "/bot/v1/hooks/connect";

/** One forwarded event, as received. */
export interface TriggerReceipt {
  readonly id: string;
  readonly at: string;
  /** Who sent it, from the payload (Connect's token names the project, not the connector). */
  readonly provider: string;
  /** Provider headers worth keeping (delivery id, event type); never the authorization. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

const KEPT_HEADERS = /^(linear-|x-github-|x-slack-|x-vercel-connect|user-agent$|content-type$)/i;
const inboxKey = (id: string) => `triggers/inbox/${id}.json`;

let verifier: ConnectWebhookVerifier | null = null;

/** Whether the request is a delivery Vercel Connect forwarded to this project and environment. */
export async function verifiedTrigger(request: Request, body: string, verify: ConnectWebhookVerifier = (verifier ??= createConnectWebhookVerifier())): Promise<boolean> {
  try {
    return Boolean(await verify(request, body));
  } catch {
    return false;
  }
}

/** The provider an event came from, by its tell-tale headers or shape. */
export function providerOf(headers: Headers, body: unknown): string {
  if (headers.has("linear-delivery") || headers.has("linear-event")) return "linear";
  if (headers.has("x-github-event")) return "github";
  if (headers.has("x-slack-signature") || (typeof body === "object" && body !== null && "team_id" in body)) return "slack";
  return "unknown";
}

/** A stable id for the delivery: the provider's own, else the body's hash, so a repeat lands on the same record. */
export function deliveryId(headers: Headers, body: string): string {
  const own = headers.get("linear-delivery") ?? headers.get("x-github-delivery") ?? headers.get("x-vercel-connect-delivery-id");
  const raw = own?.trim() || createHash("sha256").update(body).digest("hex").slice(0, 32);
  return raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "unnamed";
}

/**
 * Stores a verified delivery once. True when it is new, false for a repeat,
 * which is acknowledged without being stored or acted on again.
 */
export async function acceptTrigger(headers: Headers, body: string): Promise<{ readonly fresh: boolean; readonly receipt: TriggerReceipt }> {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = body.slice(0, 20_000);
  }
  const id = deliveryId(headers, body);
  const existing = await readDoc<TriggerReceipt>(inboxKey(id));
  if (existing !== null) return { fresh: false, receipt: existing.value };
  const kept: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (KEPT_HEADERS.test(name)) kept[name.toLowerCase()] = value.slice(0, 200);
  });
  const receipt: TriggerReceipt = { id, at: new Date().toISOString(), provider: providerOf(headers, parsed), headers: kept, body: parsed };
  try {
    await writeDoc(inboxKey(id), receipt, null);
  } catch {
    // Written by a concurrent repeat of the same delivery.
    return { fresh: false, receipt };
  }
  return { fresh: true, receipt };
}

/** The latest receipts, newest first. */
export async function recentTriggers(limit = 20): Promise<TriggerReceipt[]> {
  const all = await listDocs<TriggerReceipt>("triggers/inbox/");
  return all.sort((left, right) => right.at.localeCompare(left.at)).slice(0, limit);
}
