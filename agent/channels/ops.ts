import { DELETE, GET, PATCH, POST, defineChannel } from "eve/channels";
import { parseInputResponses } from "eve/client";
import type { SessionAuthContext } from "eve/context";

import { authenticate, sessionCookie, setStoredName, tokensConfigured, type Access, type Gate, workspaceForToken } from "../lib/access";
import { record } from "../lib/activity";
import { readArtifact } from "../lib/artifacts";
import { buildBoard } from "../lib/board";
import { findBot, getBot, hireBot, listBots, patchBot, retireBot } from "../lib/bots";
import { computerMode, vercelCredentialsError } from "../lib/computer-config";
import * as computer from "../lib/computer/http";
import { clearHandovers, finishHandover, forgetBot, handoverBelongsTo, teamScreen } from "../lib/computer/screens";
import { cancelJob, isRoutine, listOpenJobs, rescheduleJob } from "../lib/jobs";
import { listRecipes, removeRecipe } from "../lib/recipes";
import { type Day, DAYS, defaultTimezone, isSchedule, type Schedule } from "../lib/schedule";
import { forget as forgetMemory, isMemoryKind, isMemorySlot, MEMORY_SLOTS, pin as pinMemory, readEntries, remember, rewrite as rewriteMemory, SLOTS as MEMORY_SLOT_COPY } from "../lib/memory";
import { CATALOG } from "../lib/catalog";
import { addConnector, getConnector, listConnectors, publicConnector, recheckConnector, removeConnector, replaceKey, updateConnector } from "../lib/connectors";
import { hostIsProtected, PROBE_MARKER, PROBE_PATH, requestHost } from "../lib/protection";
import { botIdForRoom, isRoomName, roomAddress, roomAttributes, roomForBot } from "../lib/rooms";
import { getRoomState, isWedged, noteAnswered, noteSent, resetRoom, restartRoom, roomGeneration } from "../lib/roomstate";
import { store } from "../lib/store";
import { usageReport } from "../lib/usage-report";

/**
 * The ops channel: how people and machines reach the team.
 *
 * A "room" is a conversation address — HQ's desk, or one bot's own thread.
 * Sending to a room resumes that room's durable session, so a bot's work, its
 * approvals, and the operator's replies all stay in one thread no matter which
 * side started it. Rooms are addressed per workspace, and the workspace comes
 * from the caller's token, never from the request.
 *
 * `receive` is what makes this channel a valid target for schedules: it is how
 * the dispatcher wakes a room every minute without a human in the loop.
 */

const MAX_MESSAGE_CHARS = 20_000;
/** How often an idle thread stream sends a blank line so nothing in between drops it. */
const STREAM_HEARTBEAT_MS = 15_000;
const SECURITY_HEADERS = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...SECURITY_HEADERS,
    },
  });

const denied = (gate: Extract<Gate, { ok: false }>) => json({ error: gate.error }, gate.status);

const POLICY_TOOLS = 200;

/**
 * Corrections to what a connector's tools do, from the console.
 *
 * Only "read" and "write" are accepted, and only for plausible tool names, so
 * a typo cannot quietly become a third kind of permission nothing checks.
 */
/** `{ toolName: true | false }`, or null when the body carries nothing usable. */
function toolsPatch(value: unknown): Record<string, boolean> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: Record<string, boolean> = {};
  for (const [tool, on] of Object.entries(value as Record<string, unknown>)) if (typeof on === "boolean" && tool.trim() !== "") out[tool] = on;
  return Object.keys(out).length === 0 ? null : out;
}

function policyPatch(value: unknown): Record<string, "read" | "write"> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const patch: Record<string, "read" | "write"> = {};
  for (const [tool, effect] of Object.entries(value as Record<string, unknown>).slice(0, POLICY_TOOLS)) {
    if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(tool)) continue;
    if (effect === "read" || effect === "write") patch[tool] = effect;
  }
  return Object.keys(patch).length === 0 ? null : patch;
}

/** The console is the Next.js app; sign-in outcomes send the browser back to its pages. */
const seeOther = (location: string, headers: Record<string, string> = {}) =>
  new Response(null, { status: 303, headers: { location, ...headers } });

/**
 * Moves a wedged room to a fresh session and lets go of the old one, bounded,
 * because on eve 0.58 the old session may not answer a cancel either. The
 * thread is kept; only the address changes. Records what happened in the feed.
 */
async function restartWedgedRoom(
  workspaceId: string,
  room: string,
  attachSession: (sessionId: string) => { cancel(options: { tasks: boolean }): Promise<unknown> },
): Promise<number> {
  const old = (await getRoomState(workspaceId, room))?.sessionId ?? null;
  const generation = await restartRoom(workspaceId, room);
  if (old !== null) {
    await Promise.race([attachSession(old).cancel({ tasks: false }), new Promise((resolve) => setTimeout(resolve, 5_000))]).catch(() => undefined);
  }
  const botId = botIdForRoom(room);
  const bot = botId === null ? null : await getBot(workspaceId, botId);
  await record({
    workspaceId,
    kind: "bot.updated",
    botId: bot?.id ?? null,
    text: `${bot === null ? "HQ's desk" : `${bot.name}'s thread`} stopped answering and was restarted; the last message was sent again.`,
    data: { room, generation, restarted: true },
  }).catch(() => undefined);
  return generation;
}

function principal(access: Access, room: string): SessionAuthContext {
  return {
    attributes: { ...roomAttributes(access.workspaceId, room), ...(access.profile.source === "none" ? {} : { name: access.profile.name }) },
    authenticator: "bot-console",
    principalId: access.user,
    principalType: "user",
  };
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function text(value: unknown, min: number, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= min && trimmed.length <= max ? trimmed : null;
}

/** A valid room name, and for a bot's thread, a bot on this workspace's roster. */
async function resolveRoom(access: Access, raw: string | undefined): Promise<string | Response> {
  if (raw === undefined || !isRoomName(raw)) return json({ error: "invalid room" }, 400);
  const botId = botIdForRoom(raw);
  if (botId !== null && (await getBot(access.workspaceId, botId)) === null) {
    return json({ error: "no such bot" }, 404);
  }
  return raw;
}

/** The room's current session address: its generation changes each time it is started over. */
const addressOf = async (workspaceId: string, room: string): Promise<string> =>
  roomAddress(workspaceId, room, await roomGeneration(workspaceId, room));

export default defineChannel<undefined, void, { workspaceId: string; room: string }>({
  // A bot is mid-job more often than not; queueing keeps a new instruction from
  // cancelling the turn that is reporting the last one.
  turnPolicy: "queue",

  routes: [
    /** Signs the browser console in. The token goes into an HttpOnly cookie. */
    POST("/bot/v1/session", async (request) => {
      if (!tokensConfigured()) return seeOther("/bot");
      let token = "";
      try {
        const value = (await request.formData()).get("token");
        token = typeof value === "string" ? value.trim() : "";
      } catch {
        token = "";
      }
      if (token === "" || workspaceForToken(token) === null) return seeOther("/bot/login?error=invalid");
      return seeOther("/bot", { "set-cookie": sessionCookie(token, request) });
    }),

    POST("/bot/v1/session/end", async (request) =>
      seeOther("/bot/login", { "set-cookie": sessionCookie(null, request) }),
    ),

    /** Reaches the app only when nothing stands in front of it; see `lib/protection.ts`. */
    GET(PROBE_PATH, async () =>
      new Response(PROBE_MARKER, {
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS },
      }),
    ),

    /** What a new deployment still needs, for the setup page. Yes-or-no answers only. */
    GET("/bot/v1/setup", async (request) => {
      const onVercel = process.env.VERCEL === "1";
      const host = requestHost(request);
      const backend = computerMode();
      const driver = store().name;
      return json({
        platform: onVercel ? "vercel" : "local",
        protected: onVercel && host !== null ? await hostIsProtected(host) : null,
        tokens: tokensConfigured(),
        storage: {
          driver,
          ready: driver !== "vercel-blob" || Boolean(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN),
        },
        computer: { backend, ready: backend !== "vercel" || vercelCredentialsError() === null },
      });
    }),

    /** Everything the console needs: the roster with presence, and the feed. */
    GET("/bot/v1/state", async (request) => {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      const after = new URL(request.url).searchParams.get("after");
      const board = await buildBoard(gate.access.workspaceId, {
        ...(after !== null && !Number.isNaN(Date.parse(after)) ? { after } : {}),
      });
      return json({ ...board, user: gate.access.user, profile: gate.access.profile });
    }),

    POST("/bot/v1/rooms/:room/messages", async (request, { attachSession, from, params }) => {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      const room = await resolveRoom(gate.access, params.room);
      if (room instanceof Response) return room;

      const body = await readJson(request);
      const message = body?.message;
      if (typeof message !== "string" || message.trim() === "") {
        return json({ error: "message is required" }, 400);
      }
      if (message.length > MAX_MESSAGE_CHARS) return json({ error: "message is too long" }, 413);

      // The watchdog, for whoever sends next: a thread whose last message never
      // started a turn is restarted before this one goes in, so an API caller
      // who never sees the console is not stuck behind a dead session.
      const { workspaceId } = gate.access;
      const recovered = isWedged(await getRoomState(workspaceId, room)) ? await restartWedgedRoom(workspaceId, room, attachSession) : false;

      const session = await from(await addressOf(workspaceId, room)).send(message, {
        auth: principal(gate.access, room),
      });
      await noteSent(workspaceId, room).catch(() => undefined);
      return json({ room, sessionId: session.id, ...(recovered ? { recovered: true } : {}) });
    }),

    /**
     * The watchdog, pulled by the console: the thread accepted a message and
     * never started a turn. Moves the room to a fresh session, keeps what the
     * person saw, and sends the message again. Refused while the thread is
     * answering, so a slow reply is never cut off.
     */
    POST("/bot/v1/rooms/:room/recover", async (request, { attachSession, from, params }) => {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      const room = await resolveRoom(gate.access, params.room);
      if (room instanceof Response) return room;
      const { workspaceId } = gate.access;
      const body = await readJson(request);
      const message = typeof body?.message === "string" && body.message.trim() !== "" && body.message.length <= MAX_MESSAGE_CHARS ? body.message : null;

      const state = await getRoomState(workspaceId, room);
      if (!isWedged(state)) return json({ error: "The thread is answering; nothing to recover." }, 409);
      const generation = await restartWedgedRoom(workspaceId, room, attachSession);
      let sessionId: string | null = null;
      if (message !== null) {
        const session = await from(await addressOf(workspaceId, room)).send(message, { auth: principal(gate.access, room) });
        await noteSent(workspaceId, room).catch(() => undefined);
        sessionId = session.id;
      }
      return json({ room, recovered: true, generation, sessionId, redelivered: message !== null });
    }),

    /**
     * Answers a pending approval or question.
     *
     * A plain message does not resolve one: it starts a new turn while the
     * request stays pending. Structured responses are keyed by the `requestId`
     * carried on the `input.requested` stream event, which is what lets a bot
     * that asked hours ago pick up exactly where it parked.
     */
    POST("/bot/v1/rooms/:room/respond", async (request, { from, params }) => {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      const room = await resolveRoom(gate.access, params.room);
      if (room instanceof Response) return room;

      const body = await readJson(request);
      let responses;
      try {
        responses = parseInputResponses(body?.responses);
      } catch (error) {
        return json(
          {
            error: "responses must be [{ requestId, optionId?, text? }]",
            detail: error instanceof Error ? error.message : String(error),
          },
          400,
        );
      }
      if (responses.length === 0) return json({ error: "no responses" }, 400);

      const session = await from(await addressOf(gate.access.workspaceId, room)).respond(responses, {
        auth: principal(gate.access, room),
      });
      await noteAnswered(gate.access.workspaceId, room, responses);
      await clearHandovers(gate.access.workspaceId, responses.map((response) => response.requestId));
      return json({ room, sessionId: session.id, answered: responses.length });
    }),

    POST("/bot/v1/rooms/:room/cancel", async (request, { from, params }) => {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      const room = await resolveRoom(gate.access, params.room);
      if (room instanceof Response) return room;
      return json(await from(await addressOf(gate.access.workspaceId, room)).cancel());
    }),

    /**
     * Starts a room over. Stops its turn and the background work it started,
     * cancels the one-off jobs asked for in it, and retires its session, so the
     * next message opens a fresh one with no history. The bot, its routines,
     * playbook and files, and the team's sign-ins are left as they are.
     */
    POST("/bot/v1/rooms/:room/reset", async (request, { attachSession, from, params, resolveSession }) => {
      try {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      const room = await resolveRoom(gate.access, params.room);
      if (room instanceof Response) return room;
      const { workspaceId, user } = gate.access;
      // Starting over is a change of address, not a negotiation with the old
      // session: the room's generation is bumped first, so the next message opens a
      // fresh session and the console's stream finds nothing to replay. Whatever
      // eve can do to the old session and the jobs' sessions happens after, bounded,
      // because on eve 0.58 a session reset can hang and the person is waiting.
      const address = await addressOf(workspaceId, room);
      const live = await resolveSession(address).catch(() => undefined);
      const recorded = (await getRoomState(workspaceId, room))?.sessionId ?? null;
      const generation = await resetRoom(workspaceId, room);

      const within = <T>(work: Promise<T>, ms = 8_000): Promise<T> =>
        Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), ms))]);
      const quietly = (work: Promise<unknown>) => work.catch(() => undefined);

      const cancelledJobs: string[] = [];
      for (const job of await listOpenJobs(workspaceId)) {
        if (job.room !== room || isRoutine(job)) continue;
        const cancelled = await cancelJob(workspaceId, job.id);
        if (!cancelled.ok) continue;
        cancelledJobs.push(job.id);
        // The teammate's own session holds its open requests, such as a cost-limit card.
        if (job.sessionId) {
          const child = attachSession(job.sessionId);
          await quietly(within(child.cancel({ tasks: true })));
          await quietly(within(child.reset({ reason: "Room reset" })));
        }
      }
      const old = [...new Set([live?.id ?? null, recorded].filter((id): id is string => id !== null))];
      // The session alone, not its tasks: the one-off jobs' sessions were cancelled
      // above, routines started here must keep running, and asking eve to cancel
      // finished children only makes it log that they cannot be cancelled.
      for (const id of old) await quietly(within(attachSession(id).cancel({ tasks: false })));
      // eve's own reset of the old address is left to finish, or not, on its own.
      void quietly(from(address).reset({ reason: `Started over from the console by ${user}` }));
      const reset = { status: `generation ${generation}` };

      const botId = botIdForRoom(room);
      const bot = botId === null ? null : await getBot(workspaceId, botId);
      if (bot !== null) {
        const screen = await teamScreen(workspaceId);
        if (screen !== null && handoverBelongsTo(screen.handover ?? null, bot.id, cancelledJobs)) {
          await finishHandover(screen.n);
        }
      }
      await record({
        workspaceId,
        kind: "bot.updated",
        botId: bot?.id ?? null,
        text: `${user} started ${bot === null ? "HQ's desk" : `${bot.name}'s thread`} over.`,
      });
      return json({ room, reset: reset.status, sessions: old, cancelledJobs });
      } catch (error) {
        // A failed reset must say why; the console shows this in the thread.
        const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
        console.error(`[bot] reset failed: ${message}`);
        return json({ error: `Could not start over: ${message.split("\n")[0]}`, detail: message.slice(0, 2_000) }, 500);
      }
    }),

    /**
     * Follows a room's conversation as NDJSON, from `startIndex`. Addressed by
     * room rather than session id, so a caller can only read threads in its
     * own workspace. `x-bot-session` tells the reader when the room moved to a
     * new session and its cursor no longer applies.
     */
    GET("/bot/v1/rooms/:room/stream", async (request, { attachSession, params, resolveSession }) => {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      const room = await resolveRoom(gate.access, params.room);
      if (room instanceof Response) return room;
      const none = () => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });

      // The room's live session, or the last one it had once that session
      // ended, so the thread still reads back. The fallback id comes from this
      // workspace's own room record, never from the request.
      const live = await resolveSession(await addressOf(gate.access.workspaceId, room));
      const sessionId =
        live?.id ?? (await getRoomState(gate.access.workspaceId, room))?.sessionId ?? null;
      if (sessionId === null) return none();
      const session = live ?? attachSession(sessionId);

      const requested = Number(new URL(request.url).searchParams.get("startIndex") ?? 0);
      const startIndex = Number.isInteger(requested) && requested >= 0 ? requested : 0;

      // A reader at the tail of a quiet thread waits for the next event, which can
      // be minutes away. The headers go out at once, so the reader learns which
      // session it is following, and a blank line every so often keeps the dev
      // proxy and any load balancer from dropping the idle connection; the console
      // skips blank lines. eve hands the event stream over only once it has
      // something to say, so it is opened inside the response, not before it.
      const encoder = new TextEncoder();
      let reader: ReadableStreamDefaultReader<unknown> | null = null;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let open = true;
      const ndjson = new ReadableStream<Uint8Array>({
        start(controller) {
          const stop = () => {
            open = false;
            clearInterval(heartbeat);
            void reader?.cancel().catch(() => undefined);
          };
          heartbeat = setInterval(() => {
            if (!open) return;
            try {
              controller.enqueue(encoder.encode("\n"));
            } catch {
              stop();
            }
          }, STREAM_HEARTBEAT_MS);
          request.signal.addEventListener("abort", stop, { once: true });
          // Headers leave with the first byte, so the reader sees `x-bot-session` straight away.
          controller.enqueue(encoder.encode("\n"));

          void (async () => {
            try {
              const events = await session.getEventStream({ startIndex });
              if (!open) return void events.cancel().catch(() => undefined);
              reader = events.getReader();
              for (;;) {
                const { value, done } = await reader.read();
                if (done || !open) break;
                controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
              }
            } catch {
              // The session is gone or the reader left; either way the stream ends.
            } finally {
              clearInterval(heartbeat);
              if (open) {
                open = false;
                try {
                  controller.close();
                } catch {
                  // Already closed by the reader going away.
                }
              }
            }
          })();
        },
        cancel() {
          open = false;
          clearInterval(heartbeat);
          void reader?.cancel().catch(() => undefined);
        },
      });

      return new Response(ndjson, {
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
          "x-bot-session": sessionId,
          ...SECURITY_HEADERS,
        },
      });
    }),

    /** Hire from the console: a name, a job, and how it should work. */
    POST("/bot/v1/bots", async (request) => {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      const body = await readJson(request);
      const name = text(body?.name, 1, 40);
      const role = text(body?.role, 1, 120);
      const persona = text(body?.persona, 20, 4_000);
      if (name === null || role === null || persona === null) {
        return json(
          { error: "A name (1–40), a job (1–120), and how it should work (20–4000 characters) are required." },
          400,
        );
      }
      const clash = await findBot(gate.access.workspaceId, name);
      if (clash !== null) return json({ error: `${clash.name} is already on the team.` }, 409);

      const bot = await hireBot({
        workspaceId: gate.access.workspaceId,
        hiredBy: gate.access.user,
        name,
        role,
        persona,
      });
      return json({ bot: { id: bot.id, name: bot.name, room: roomForBot(bot.id) } }, 201);
    }),

    /**
     * Pause or resume a Bot, or edit its profile: name, job, and how it should
     * work. Retiring stays a conversation, because it needs approval.
     */
    PATCH("/bot/v1/bots/:botId", async (request, { params }) => {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      const workspaceId = gate.access.workspaceId;
      const botId = params.botId;
      const body = await readJson(request);
      const status = body?.status;
      if (status !== undefined && status !== "active" && status !== "paused") {
        return json({ error: 'status must be "active" or "paused"' }, 400);
      }
      const name = body?.name === undefined ? undefined : text(body.name, 1, 40);
      const role = body?.role === undefined ? undefined : text(body.role, 1, 120);
      const persona = body?.persona === undefined ? undefined : text(body.persona, 20, 4_000);
      if (name === null || role === null || persona === null) {
        return json(
          { error: "A name (1–40), a job (1–120), and how it should work (20–4000 characters) are required." },
          400,
        );
      }
      // Roster placement from the row menu: pin, section, hide. Preferences, so no activity is recorded.
      const pinned = body?.pinned === undefined ? undefined : body.pinned === true;
      const hidden = body?.hidden === undefined ? undefined : body.hidden === true;
      const section =
        body?.section === undefined ? undefined : body.section === null || body.section === "" ? null : text(body.section, 1, 40);
      if (section === null && body?.section !== null && body?.section !== "") {
        return json({ error: "A section name is 1–40 characters." }, 400);
      }
      const placement = pinned !== undefined || hidden !== undefined || section !== undefined;
      if (status === undefined && name === undefined && role === undefined && persona === undefined && !placement) {
        return json({ error: "nothing to change" }, 400);
      }
      const before = botId === undefined ? null : await getBot(workspaceId, botId);
      if (before === null) return json({ error: "no such bot" }, 404);
      if (name !== undefined) {
        // Bots are addressed by name, so two with the same name would be ambiguous.
        const clash = await findBot(workspaceId, name);
        if (clash !== null && clash.id !== before.id) return json({ error: `${clash.name} is already on the team.` }, 409);
      }

      const bot = await patchBot(workspaceId, before.id, (current) => ({
        ...current,
        status: status ?? current.status,
        name: name ?? current.name,
        role: role ?? current.role,
        persona: persona ?? current.persona,
        ...(pinned === undefined ? {} : { pinned }),
        ...(hidden === undefined ? {} : { hidden }),
        ...(section === undefined ? {} : { section }),
      }));
      if (bot === null) return json({ error: "no such bot" }, 404);
      const changes = [
        before.name === bot.name ? null : `${before.name} is now called ${bot.name}.`,
        before.role === bot.role && before.persona === bot.persona ? null : `${bot.name}'s profile was updated.`,
        before.status === bot.status ? null : `${bot.name} was ${bot.status === "paused" ? "paused" : "resumed"}.`,
      ].filter((line) => line !== null);
      if (changes.length > 0) {
        await record({ workspaceId, kind: "bot.updated", botId: bot.id, text: changes.join(" ") });
      }
      return json({ bot: { id: bot.id, name: bot.name, role: bot.role, status: bot.status } });
    }),

    /**
     * A copy of a Bot: same job, instructions, skills, and playbook, its own
     * name and a fresh thread. For a second specialist, or a variant to try.
     */
    POST("/bot/v1/bots/:botId/duplicate", async (request, { params }) => {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      const workspaceId = gate.access.workspaceId;
      const source = params.botId === undefined ? null : await getBot(workspaceId, params.botId);
      if (source === null) return json({ error: "no such bot" }, 404);
      const taken = new Set((await listBots(workspaceId)).map((bot) => bot.name.toLowerCase()));
      let name = `${source.name} copy`.slice(0, 40);
      for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${source.name} copy ${n}`.slice(0, 40);
      const hired = await hireBot({ workspaceId, hiredBy: gate.access.user, name, role: source.role, persona: source.persona });
      const bot =
        (await patchBot(workspaceId, hired.id, (current) => ({
          ...current,
          emoji: source.emoji,
          skills: [...source.skills],
          playbook: [...source.playbook],
          ...(source.section === undefined || source.section === null ? {} : { section: source.section }),
        }))) ?? hired;
      await record({ workspaceId, kind: "bot.updated", botId: bot.id, text: `${bot.name} was created as a copy of ${source.name}.` });
      return json({ bot: { id: bot.id, name: bot.name, room: roomForBot(bot.id) } }, 201);
    }),

    /**
     * Remove a Bot from the console, the way `retire_bot` does from a thread: its
     * open one-off jobs are cancelled, its playbook goes with it, and a handover it
     * was waiting on is over. The console confirms with the person first.
     */
    DELETE("/bot/v1/bots/:botId", async (request, { params }) => {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      const workspaceId = gate.access.workspaceId;
      const bot = params.botId === undefined ? null : await getBot(workspaceId, params.botId);
      if (bot === null) return json({ error: "no such bot" }, 404);
      const open = (await listOpenJobs(workspaceId)).filter((job) => job.botId === bot.id);
      const cancelled: string[] = [];
      for (const job of open) {
        const outcome = await cancelJob(workspaceId, job.id);
        if (outcome.ok) cancelled.push(job.id);
      }
      await retireBot(workspaceId, bot.id);
      await forgetBot(workspaceId, bot.id);
      await record({
        workspaceId,
        kind: "bot.retired",
        botId: bot.id,
        text: `${bot.name} was removed by ${gate.access.user}. ${cancelled.length} open job(s) cancelled.`,
      });
      return json({ removed: true, bot: { id: bot.id, name: bot.name }, cancelledJobs: cancelled });
    }),

    // The team's computer (see lib/computer/http.ts). Each Bot has a screen with a
    // desktop people can watch and take over; Files move things on and off the computer.

    /** The still frame of a Bot's screen. Never wakes the computer. */
    /** What the console calls the person in this workspace, when nothing signs them in by name. */
    PATCH("/bot/v1/profile", async (request) => {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      if (gate.access.profile.source === "vercel" || gate.access.profile.source === "header") {
        return json({ error: "Your name comes from your sign-in here." }, 409);
      }
      const body = await readJson(request);
      const name = await setStoredName(gate.access.workspaceId, typeof body?.name === "string" ? body.name : "");
      return json({ profile: name === null ? { name: "operator", avatarUrl: null, source: "none" } : { name, avatarUrl: null, source: "workspace" } });
    }),

    /**
     * Everything the team remembers: the workspace's three slots, with where
     * each memory came from, and each Bot's playbook. Whose memory it is comes
     * from the session, never the path.
     */
    GET("/bot/v1/memory", async (request) => {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      const [slots, bots] = await Promise.all([
        Promise.all(
          MEMORY_SLOTS.map(async (slot) => ({
            slot,
            label: MEMORY_SLOT_COPY[slot].label,
            detail: MEMORY_SLOT_COPY[slot].detail,
            maxEntries: MEMORY_SLOT_COPY[slot].maxEntries,
            entries: await readEntries(gate.access.workspaceId, slot),
          })),
        ),
        listBots(gate.access.workspaceId),
      ]);
      return json({
        slots,
        playbooks: bots.map((bot) => ({ botId: bot.id, name: bot.name, emoji: bot.emoji, playbook: bot.playbook })),
      });
    }),

    /** Remembers one thing by hand, as the person. */
    POST("/bot/v1/memory/:slot", async (request, { params }) => {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      const slot = params.slot ?? "";
      if (!isMemorySlot(slot)) return json({ error: "no such memory" }, 404);
      const body = await readJson(request);
      const kind = isMemoryKind(body?.kind) ? body.kind : slot === "craft" ? "lesson" : "fact";
      const outcome = await remember(
        gate.access.workspaceId,
        slot,
        [{ text: typeof body?.text === "string" ? body.text : "", kind }],
        { who: "you", name: gate.access.profile.name },
        { pinned: body?.pinned === true },
      );
      const entry = outcome.added[0];
      if (entry !== undefined) return json({ saved: true, entry }, 201);
      if (outcome.duplicates > 0) return json({ error: "Already remembered." }, 409);
      if (outcome.refused > 0) return json({ error: "This memory is full. Forget something first." }, 409);
      return json({ error: "That cannot be remembered: it is empty, too long, or looks like a secret." }, 400);
    }),

    /** Pins, unpins, or rewrites one memory. */
    PATCH("/bot/v1/memory/:slot/:id", async (request, { params }) => {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      const slot = params.slot ?? "";
      const id = params.id ?? "";
      if (!isMemorySlot(slot) || id === "") return json({ error: "no such memory" }, 404);
      const body = await readJson(request);
      if (typeof body?.text === "string") {
        const outcome = await rewriteMemory(gate.access.workspaceId, slot, id, body.text);
        if (!outcome.ok) return json({ error: outcome.error }, outcome.status);
      }
      if (typeof body?.pinned === "boolean") {
        const outcome = await pinMemory(gate.access.workspaceId, slot, id, body.pinned);
        if (!outcome.ok) return json({ error: outcome.error }, outcome.status);
      }
      return json({ changed: true });
    }),

    /** Forgets one memory. */
    DELETE("/bot/v1/memory/:slot/:id", async (request, { params }) => {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      const slot = params.slot ?? "";
      const id = params.id ?? "";
      if (!isMemorySlot(slot) || id === "") return json({ error: "no such memory" }, 404);
      const outcome = await forgetMemory(gate.access.workspaceId, slot, id);
      return outcome.ok ? json({ forgotten: true }) : json({ error: outcome.error }, outcome.status);
    }),

    /** The recipes this team saved: briefs that worked, for HQ to reuse. */
    /** What the workspace has spent on models: totals, by Bot, by model, by day, and by job. */
    GET("/bot/v1/usage", async (request) => {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      return json(await usageReport(gate.access.workspaceId));
    }),

    GET("/bot/v1/recipes", async (request) => {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      return json({ recipes: await listRecipes(gate.access.workspaceId) });
    }),

    DELETE("/bot/v1/recipes/:recipeId", async (request, { params }) => {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      const removed = await removeRecipe(gate.access.workspaceId, params.recipeId ?? "");
      return removed ? json({ removed: true }) : json({ error: "no such recipe" }, 404);
    }),

    /** A routine, changed from the console: a new interval or clock schedule, or a new title. */
    PATCH("/bot/v1/jobs/:jobId", async (request, { params }) => {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      const body = await readJson(request);
      let schedule: Schedule | null | undefined;
      if (typeof body?.dailyAt === "string") {
        const [hour = "0", minute = "0"] = body.dailyAt.split(":");
        const days = Array.isArray(body.onDays)
          ? body.onDays.filter((day): day is Day => typeof day === "string" && (DAYS as readonly string[]).includes(day))
          : [];
        const candidate: unknown = {
          hour: Number(hour),
          minute: Number(minute),
          ...(days.length === 0 ? {} : { days }),
          timezone: typeof body.timezone === "string" && body.timezone.trim() !== "" ? body.timezone.trim() : defaultTimezone(),
        };
        if (!isSchedule(candidate)) {
          return json({ error: "That is not a time and timezone I know. Use HH:MM and an IANA name such as America/New_York." }, 422);
        }
        schedule = candidate;
      } else if (body?.dailyAt === null) {
        schedule = null;
      }
      const every = body?.everyMinutes;
      const everyMinutes =
        every === null ? null : typeof every === "number" && Number.isInteger(every) && every >= 5 && every <= 525_600 ? every : undefined;
      if (every !== undefined && every !== null && everyMinutes === undefined) return json({ error: "The interval is minutes, from 5 up to a year." }, 422);
      const changed = await rescheduleJob(gate.access.workspaceId, params.jobId ?? "", {
        ...(schedule === undefined ? {} : { schedule }),
        ...(everyMinutes === undefined ? {} : { everyMinutes }),
        ...(typeof body?.title === "string" ? { title: body.title } : {}),
      });
      return changed.ok ? json({ job: changed.job }) : json({ error: changed.reason }, 422);
    }),

    /** Stops a job or routine from the console; what it already delivered stays. */
    DELETE("/bot/v1/jobs/:jobId", async (request, { params }) => {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      const cancelled = await cancelJob(gate.access.workspaceId, params.jobId ?? "");
      return cancelled.ok ? json({ cancelled: true, job: { id: cancelled.job.id, title: cancelled.job.title } }) : json({ error: cancelled.reason }, 422);
    }),

    /** The team's connectors: services every Bot can use. Keys never come back out. */
    GET("/bot/v1/connectors", async (request) => {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      return json({ connectors: (await listConnectors(gate.access.workspaceId)).map(publicConnector), catalog: CATALOG });
    }),

    /** Connects a connector, from the catalog by id or a custom MCP server: it must answer with its tools before it is saved. */
    POST("/bot/v1/connectors", async (request) => {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      const body = await readJson(request);
      const keyInput = typeof body?.key === "object" && body.key !== null ? (body.key as Record<string, unknown>) : {};
      const added = await addConnector(gate.access.workspaceId, gate.access.user, {
        ...(typeof body?.catalog === "string" ? { catalog: body.catalog } : {}),
        ...(typeof body?.label === "string" ? { label: body.label } : {}),
        ...(typeof body?.url === "string" ? { url: body.url } : {}),
        ...(typeof body?.description === "string" ? { description: body.description } : {}),
        key: {
          ...(keyInput.kind === "bearer" || keyInput.kind === "header" || keyInput.kind === "none" ? { kind: keyInput.kind } : {}),
          ...(typeof keyInput.header === "string" ? { header: keyInput.header } : {}),
          ...(typeof keyInput.secret === "string" ? { secret: keyInput.secret } : {}),
        },
        ...(body?.gate === "none" || body?.gate === "writes" || body?.gate === "all" ? { gate: body.gate } : {}),
      });
      if (!added.ok) return json({ error: added.error }, 422);
      return json({ connector: publicConnector(added.connector) }, 201);
    }),

    PATCH("/bot/v1/connectors/:connectorId", async (request, { params }) => {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      const body = await readJson(request);
      const updated = await updateConnector(gate.access.workspaceId, params.connectorId ?? "", {
        ...(typeof body?.enabled === "boolean" ? { enabled: body.enabled } : {}),
        ...(body?.gate === "none" || body?.gate === "writes" || body?.gate === "all" ? { gate: body.gate } : {}),
        ...(typeof body?.description === "string" ? { description: body.description } : {}),
        ...(policyPatch(body?.policy) === null ? {} : { policy: policyPatch(body?.policy) as Record<string, "read" | "write"> }),
        ...(toolsPatch(body?.tools) === null ? {} : { tools: toolsPatch(body?.tools) as Record<string, boolean> }),
      });
      return updated === null ? json({ error: "no such connector" }, 404) : json({ connector: publicConnector(updated) });
    }),

    /** Swaps the connector's key, once the server has accepted the new one. */
    POST("/bot/v1/connectors/:connectorId/key", async (request, { params }) => {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      const body = await readJson(request);
      const replaced = await replaceKey(gate.access.workspaceId, params.connectorId ?? "", {
        ...(body?.kind === "bearer" || body?.kind === "header" || body?.kind === "none" ? { kind: body.kind } : {}),
        ...(typeof body?.header === "string" ? { header: body.header } : {}),
        secret: typeof body?.secret === "string" ? body.secret : "",
      });
      return replaced.ok ? json({ connector: publicConnector(replaced.connector) }) : json({ error: replaced.error }, replaced.error === "no such connector" ? 404 : 422);
    }),

    DELETE("/bot/v1/connectors/:connectorId", async (request, { params }) => {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      const removed = await removeConnector(gate.access.workspaceId, params.connectorId ?? "");
      return removed ? json({ removed: true }) : json({ error: "no such connector" }, 404);
    }),

    /** Reaches the server again with its stored key, to show whether it still works. */
    POST("/bot/v1/connectors/:connectorId/check", async (request, { params }) => {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      const connector = await getConnector(gate.access.workspaceId, params.connectorId ?? "");
      if (connector === null) return json({ error: "no such connector" }, 404);
      const checked = await recheckConnector(connector);
      return checked === null ? json({ error: "no such connector" }, 404) : json({ connector: publicConnector(checked) });
    }),

    GET("/bot/v1/bots/:botId/screen", async (request, { params }) => {
      const gate = await authenticate(request);
      return gate.ok ? computer.poster(gate.access, params.botId) : denied(gate);
    }),

    /** Watch a Bot's browser live. */
    POST("/bot/v1/bots/:botId/computer/browser", async (request, { params }) => {
      const gate = await authenticate(request);
      return gate.ok ? computer.openBrowser(request, gate.access, params.botId) : denied(gate);
    }),

    /** Take control of a Bot's browser, for example to sign in. */
    POST("/bot/v1/bots/:botId/computer/control", async (request, { params }) => {
      const gate = await authenticate(request);
      return gate.ok ? computer.takeControl(request, gate.access, params.botId) : denied(gate);
    }),

    POST("/bot/v1/bots/:botId/computer/control/heartbeat", async (request, { params }) => {
      const gate = await authenticate(request);
      return gate.ok ? computer.renewControl(gate.access, params.botId) : denied(gate);
    }),
    POST("/bot/v1/bots/:botId/computer/viewing", async (request, { params }) => {
      const gate = await authenticate(request);
      return gate.ok ? computer.keepWatching(gate.access, params.botId) : denied(gate);
    }),

    POST("/bot/v1/bots/:botId/computer/release", async (request, { params }) => {
      const gate = await authenticate(request);
      return gate.ok ? computer.releaseControl(gate.access, params.botId, { handBack: false }) : denied(gate);
    }),

    /** Release control and share the sign-ins made meanwhile with the other browsers. */
    POST("/bot/v1/bots/:botId/computer/handback", async (request, { params }) => {
      const gate = await authenticate(request);
      return gate.ok ? computer.releaseControl(gate.access, params.botId, { handBack: true, request }) : denied(gate);
    }),

    GET("/bot/v1/bots/:botId/computer/frame", async (request, { params }) => {
      const gate = await authenticate(request);
      return gate.ok ? computer.frame(gate.access, params.botId) : denied(gate);
    }),

    POST("/bot/v1/bots/:botId/computer/input", async (request, { params }) => {
      const gate = await authenticate(request);
      return gate.ok ? computer.input(request, gate.access, params.botId) : denied(gate);
    }),

    GET("/bot/v1/computer/files", async (request) => {
      const gate = await authenticate(request);
      return gate.ok ? computer.listFiles(request) : denied(gate);
    }),

    GET("/bot/v1/computer/files/content", async (request) => {
      const gate = await authenticate(request);
      return gate.ok ? computer.fileContent(request) : denied(gate);
    }),

    POST("/bot/v1/computer/files", async (request) => {
      const gate = await authenticate(request);
      return gate.ok ? computer.uploadFile(request, gate.access) : denied(gate);
    }),

    DELETE("/bot/v1/computer/files", async (request) => {
      const gate = await authenticate(request);
      return gate.ok ? computer.deleteFile(request, gate.access) : denied(gate);
    }),

    /**
     * Downloads a saved artifact. Bots save things they found on the web, so
     * nothing but plain images renders inline, and even those are sandboxed.
     */
    GET("/bot/v1/artifacts/:artifactId", async (request, { params }) => {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      const artifactId = params.artifactId;
      if (artifactId === undefined || !/^art_[a-z0-9]+$/.test(artifactId)) {
        return json({ error: "invalid artifact" }, 400);
      }
      const [key] = await store().list(`artifacts/${gate.access.workspaceId}/${artifactId}-`);
      const stored = key === undefined ? null : await readArtifact(key);
      if (stored === null) return json({ error: "not found" }, 404);

      const { meta } = stored;
      const inline = /^image\/(png|jpeg|gif|webp)$/.test(meta.mediaType);
      return new Response(Buffer.from(stored.base64, "base64"), {
        headers: {
          "content-type": inline ? meta.mediaType : "application/octet-stream",
          "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
          "content-security-policy": "sandbox",
          "cache-control": "private, max-age=300",
          ...SECURITY_HEADERS,
        },
      });
    }),
  ],

  /** Schedule hand-offs land here. The workspace and room are the address. */
  async receive(input, { from }) {
    return from(await addressOf(input.target.workspaceId, input.target.room)).send(input.message, {
      auth: input.auth,
    });
  },
});
