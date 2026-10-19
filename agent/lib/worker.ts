import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTVerifyGetKey } from "jose";

import { repairAllReservations } from "./budget";
import { reapIdleScreens } from "./computer/reaper";
import { chargeComputerRuntime } from "./computer-spend";
import { dispatchDue, type DispatchOutcome } from "./dispatch";
import { readDoc, writeDoc } from "./store";
import { deliverNotes } from "./teammail";

/**
 * The background worker: a Vercel Daemon (`daemon/`, production only) that asks
 * this server to do the watchdog's work every 30 seconds, so nothing waits for
 * a console to be open or for the daily cron.
 *
 * A daemon takes no inbound traffic, so it calls in: `POST /bot/v1/internal/tick`
 * with the OIDC token Vercel gives every instance. Only a token Vercel issued
 * for this same project's production environment is accepted. The cron tick and
 * the console's sweep keep running either way; with no worker nothing changes.
 */

const HEARTBEAT_KEY = "runtime/worker.json";
/** The tick's slower work (a Vercel API call, a pass over every budget) runs at most this often. */
const SLOW_EVERY_MS = 5 * 60_000;
/**
 * The heartbeat is written at most this often, or when the pass moved work: each
 * write is a billed store operation, and "last seen" needs no finer grain.
 */
const HEARTBEAT_EVERY_MS = 60_000;

export interface WorkerHeartbeat {
  /** The last tick the worker asked for. */
  readonly at: string;
  /** The last time the slower work ran. */
  readonly slowAt: string | null;
  readonly due: number;
  readonly dispatched: number;
  readonly notes: number;
}

export async function readHeartbeat(): Promise<WorkerHeartbeat | null> {
  return (await readDoc<WorkerHeartbeat>(HEARTBEAT_KEY).catch(() => null))?.value ?? null;
}

const ISSUER = /^https:\/\/oidc\.vercel\.com(?:\/[\w-]+)?$/;
const keySets = new Map<string, JWTVerifyGetKey>();

/** Vercel's signing keys for an issuer, fetched once per process. */
function vercelKeys(issuer: string): JWTVerifyGetKey {
  let keys = keySets.get(issuer);
  if (keys === undefined) keySets.set(issuer, (keys = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks`))));
  return keys;
}

/**
 * Whether the request carries an OIDC token Vercel issued to this project's
 * production environment, as every daemon instance has. Never true off Vercel.
 */
export async function isProjectWorker(
  request: Request,
  env: Readonly<Record<string, string | undefined>> = process.env,
  keysFor: (issuer: string) => JWTVerifyGetKey = vercelKeys,
): Promise<boolean> {
  const project = env.VERCEL_PROJECT_ID?.trim();
  const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!project || token === undefined) return false;
  try {
    const issuer = decodeJwt(token).iss;
    if (typeof issuer !== "string" || !ISSUER.test(issuer)) return false;
    const { payload } = await jwtVerify(token, keysFor(issuer), { issuer });
    return payload.project_id === project && payload.environment === "production";
  } catch {
    return false;
  }
}

type Send = (workspaceId: string, room: string, message: string) => Promise<void>;

/** How often the daemon calls in, from Settings over `BOT_WORKER_EVERY_SECONDS`: 10 s to an hour, 30 s otherwise. */
export function workerEverySeconds(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const seconds = Number(env.BOT_WORKER_EVERY_SECONDS?.trim() || 30);
  return Number.isFinite(seconds) ? Math.min(3600, Math.max(10, Math.round(seconds))) : 30;
}

/** One pass of the watchdog's work (see `schedules/tick.ts`), noted in a heartbeat. */
export async function workerTick(send: Send): Promise<{ readonly dispatch: DispatchOutcome; readonly notes: number; readonly slow: boolean }> {
  const previous = await readHeartbeat();
  const dispatch = await dispatchDue((job, message) => send(job.workspaceId, job.room, message));
  const notes = await deliverNotes(send).catch(() => 0);
  await reapIdleScreens().catch(() => 0);
  const slow = previous?.slowAt == null || Date.now() - Date.parse(previous.slowAt) >= SLOW_EVERY_MS;
  if (slow) {
    await repairAllReservations().catch(() => 0);
    await chargeComputerRuntime().catch(() => 0);
  }
  const now = new Date().toISOString();
  const moved = dispatch.due > 0 || notes > 0;
  if (!slow && !moved && previous !== null && Date.now() - Date.parse(previous.at) < HEARTBEAT_EVERY_MS) return { dispatch, notes, slow };
  await writeDoc(HEARTBEAT_KEY, {
    at: now,
    slowAt: slow ? now : (previous?.slowAt ?? null),
    due: dispatch.due,
    dispatched: dispatch.dispatched,
    notes,
  } satisfies WorkerHeartbeat).catch(() => undefined);
  return { dispatch, notes, slow };
}
