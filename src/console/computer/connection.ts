import { api, isRecord } from "../api";

/** What the computer routes answer when asked for a live connection. */
export type Connection =
  | {
      readonly mode: "vnc";
      readonly screen: number;
      readonly viewOnly: boolean;
      readonly url: string;
      readonly control: { readonly by: string; readonly until: string } | null;
    }
  | {
      readonly mode: "relay";
      readonly screen: number;
      readonly viewOnly: boolean;
      readonly frameUrl: string;
      readonly inputUrl: string;
      readonly control: { readonly by: string; readonly until: string } | null;
    }
  | { readonly mode: "starting"; readonly retryAfterMs: number; readonly detail: string }
  /** A watch-only request found the browser not running, and did not start it. */
  | { readonly mode: "asleep" }
  | { readonly mode: "unavailable"; readonly error: string };

export type RelayConnection = Extract<Connection, { mode: "relay" }>;

/** Asks for a connection. Anything that is not one comes back as `unavailable`, with the reason. */
export async function requestConnection(path: string, body: Record<string, unknown>): Promise<Connection> {
  const response = await api(path, { method: "POST", body: JSON.stringify(body) });
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Not JSON: described below.
  }
  if (isRecord(payload) && typeof payload.mode === "string") return payload as Connection;
  const error =
    isRecord(payload) && typeof payload.error === "string"
      ? payload.error
      : `The computer did not answer (${response.status}).`;
  return { mode: "unavailable", error };
}

/** 1s, 2s, 4s, 8s, then every 15s. */
export const backoff = (failures: number) => Math.min(15_000, 1_000 * 2 ** Math.min(Math.max(failures - 1, 0), 4));

export const botPath = (botId: string, rest: string) => `/bot/v1/bots/${encodeURIComponent(botId)}/${rest}`;
