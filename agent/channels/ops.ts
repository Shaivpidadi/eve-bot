import { DELETE, GET, PATCH, POST, defineChannel } from "eve/channels";
import { parseInputResponses } from "eve/client";
import type { SessionAuthContext } from "eve/context";

import {
  authenticate,
  sessionCookie,
  tokensConfigured,
  workspaceForToken,
  type Access,
  type Gate,
} from "../lib/access";
import { record } from "../lib/activity";
import { readArtifact } from "../lib/artifacts";
import { buildBoard } from "../lib/board";
import { findBot, getBot, hireBot, patchBot } from "../lib/bots";
import { computerMode, vercelCredentialsError } from "../lib/computer-config";
import * as computer from "../lib/computer/http";
import { clearHandovers, finishHandover, handoverBelongsTo, teamScreen } from "../lib/computer/screens";
import { cancelJob, listOpenJobs } from "../lib/jobs";
import { addMemory, forgetMemory, isMemorySlot, readMemory } from "../lib/memory";
import {
  addPlugin,
  getPlugin,
  listPlugins,
  publicPlugin,
  recheckPlugin,
  removePlugin,
  updatePlugin,
} from "../lib/plugins";
import { hostIsProtected, PROBE_MARKER, PROBE_PATH, requestHost } from "../lib/protection";
import { botIdForRoom, isRoomName, roomAddress, roomAttributes, roomForBot } from "../lib/rooms";
import { getRoomState, noteAnswered, resetRoom } from "../lib/roomstate";
import { store } from "../lib/store";

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

/** The console is the Next.js app; sign-in outcomes send the browser back to its pages. */
const seeOther = (location: string, headers: Record<string, string> = {}) =>
  new Response(null, { status: 303, headers: { location, ...headers } });

function principal(access: Access, room: string): SessionAuthContext {
  return {
    attributes: roomAttributes(access.workspaceId, room),
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
      return json({ ...board, user: gate.access.user });
    }),

    POST("/bot/v1/rooms/:room/messages", async (request, { from, params }) => {
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

      const session = await from(roomAddress(gate.access.workspaceId, room)).send(message, {
        auth: principal(gate.access, room),
      });
      return json({ room, sessionId: session.id });
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

      const session = await from(roomAddress(gate.access.workspaceId, room)).respond(responses, {
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
      return json(await from(roomAddress(gate.access.workspaceId, room)).cancel());
    }),

    /**
     * Starts a room over. Stops its turn and the background work it started,
     * cancels the one-off jobs asked for in it, and retires its session, so the
     * next message opens a fresh one with no history. The bot, its routines,
     * playbook and files, and the team's sign-ins are left as they are.
     */
    POST("/bot/v1/rooms/:room/reset", async (request, { attachSession, from, params, resolveSession }) => {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      const room = await resolveRoom(gate.access, params.room);
      if (room instanceof Response) return room;
      const { workspaceId, user } = gate.access;
      const address = roomAddress(workspaceId, room);
      const quietly = (work: Promise<unknown>) => work.catch(() => undefined);

      const cancelledJobs: string[] = [];
      for (const job of await listOpenJobs(workspaceId)) {
        if (job.room !== room || job.everyMinutes !== null) continue;
        const cancelled = await cancelJob(workspaceId, job.id);
        if (!cancelled.ok) continue;
        cancelledJobs.push(job.id);
        // The teammate's own session holds its open requests, such as a cost-limit card.
        if (job.sessionId) {
          const child = attachSession(job.sessionId);
          await quietly(child.cancel({ tasks: true }));
          await quietly(child.reset({ reason: "Room reset" }));
        }
      }

      const live = await resolveSession(address);
      const recorded = (await getRoomState(workspaceId, room))?.sessionId ?? null;
      for (const id of new Set([live?.id ?? null, recorded])) {
        if (id !== null) await quietly(attachSession(id).cancel({ tasks: true }));
      }
      const reset = await from(address).reset({ reason: `Started over from the console by ${user}` });
      if (recorded !== null && recorded !== live?.id) {
        await quietly(attachSession(recorded).reset({ reason: "Room reset" }));
      }
      await resetRoom(workspaceId, room);

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
      return json({
        room,
        reset: reset.status,
        sessions: [...new Set([live?.id, recorded].filter((id): id is string => typeof id === "string"))],
        cancelledJobs,
      });
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
      const live = await resolveSession(roomAddress(gate.access.workspaceId, room));
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
      if (status === undefined && name === undefined && role === undefined && persona === undefined) {
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

    // The team's computer (see lib/computer/http.ts). Each Bot has a screen with a
    // desktop people can watch and take over; Files move things on and off the computer.

    /** The still frame of a Bot's screen. Never wakes the computer. */
    /**
     * What HQ and the Bots remember for the caller: their own memories and the
     * workspace's. Whose memory it is comes from the session, never the path.
     */
    GET("/bot/v1/memory", async (request) => {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      return json({ slots: await readMemory(gate.access.workspaceId, gate.access.user) });
    }),

    /** Adds one memory by hand, as if HQ or a Bot had saved it. */
    POST("/bot/v1/memory/:slot", async (request, { params }) => {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      const slot = params.slot ?? "";
      if (!isMemorySlot(slot)) return json({ error: "no such memory" }, 404);
      const body = await readJson(request);
      const outcome = await addMemory(gate.access.workspaceId, gate.access.user, slot, typeof body?.text === "string" ? body.text : "");
      return outcome.ok ? json({ saved: true }, 201) : json({ error: outcome.error }, outcome.status);
    }),

    /** Forgets one memory by the index it was saved under. */
    DELETE("/bot/v1/memory/:slot/:index", async (request, { params }) => {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      const slot = params.slot ?? "";
      const index = Number(params.index);
      if (!isMemorySlot(slot) || !Number.isSafeInteger(index) || index < 0) return json({ error: "no such memory" }, 404);
      const outcome = await forgetMemory(gate.access.workspaceId, gate.access.user, slot, index);
      return outcome.ok ? json({ forgotten: true }) : json({ error: outcome.error }, outcome.status);
    }),

    /** The team's plugins: MCP servers every Bot can use. Keys never come back out. */
    GET("/bot/v1/plugins", async (request) => {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      return json({ plugins: (await listPlugins(gate.access.workspaceId)).map(publicPlugin) });
    }),

    /** Connects a plugin: the server must answer with its tools before it is saved. */
    POST("/bot/v1/plugins", async (request) => {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      const body = await readJson(request);
      const keyInput = typeof body?.key === "object" && body.key !== null ? (body.key as Record<string, unknown>) : {};
      const kind = keyInput.kind === "bearer" || keyInput.kind === "header" ? keyInput.kind : "none";
      const added = await addPlugin(gate.access.workspaceId, gate.access.user, {
        label: typeof body?.label === "string" ? body.label : "",
        url: typeof body?.url === "string" ? body.url : "",
        ...(typeof body?.description === "string" ? { description: body.description } : {}),
        key: {
          kind,
          ...(typeof keyInput.header === "string" ? { header: keyInput.header } : {}),
          ...(typeof keyInput.secret === "string" ? { secret: keyInput.secret } : {}),
        },
        askFirst: body?.askFirst === true,
      });
      if (!added.ok) return json({ error: added.error }, 422);
      return json({ plugin: publicPlugin(added.plugin) }, 201);
    }),

    PATCH("/bot/v1/plugins/:pluginId", async (request, { params }) => {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      const body = await readJson(request);
      const updated = await updatePlugin(gate.access.workspaceId, params.pluginId ?? "", {
        ...(typeof body?.enabled === "boolean" ? { enabled: body.enabled } : {}),
        ...(typeof body?.askFirst === "boolean" ? { askFirst: body.askFirst } : {}),
        ...(typeof body?.description === "string" ? { description: body.description } : {}),
      });
      return updated === null ? json({ error: "no such plugin" }, 404) : json({ plugin: publicPlugin(updated) });
    }),

    DELETE("/bot/v1/plugins/:pluginId", async (request, { params }) => {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      const removed = await removePlugin(gate.access.workspaceId, params.pluginId ?? "");
      return removed ? json({ removed: true }) : json({ error: "no such plugin" }, 404);
    }),

    /** Reaches the server again with its stored key, to show whether it still works. */
    POST("/bot/v1/plugins/:pluginId/check", async (request, { params }) => {
      const gate = await authenticate(request);
      if (!gate.ok) return denied(gate);
      const plugin = await getPlugin(gate.access.workspaceId, params.pluginId ?? "");
      if (plugin === null) return json({ error: "no such plugin" }, 404);
      const checked = await recheckPlugin(plugin);
      return checked === null ? json({ error: "no such plugin" }, 404) : json({ plugin: publicPlugin(checked) });
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
    return from(roomAddress(input.target.workspaceId, input.target.room)).send(input.message, {
      auth: input.auth,
    });
  },
});
