import { GET, POST, defineChannel } from "eve/channels";
import { parseInputResponses } from "eve/client";
import type { SessionAuthContext } from "eve/context";

import console_ from "./console.html?raw";

import { recentActivity } from "../lib/activity";
import { listBots } from "../lib/bots";
import { listJobs } from "../lib/jobs";

/**
 * The ops channel: how people and machines reach HQ.
 *
 * A "room" is a conversation address — one operator's desk, a shared control
 * room, the standup feed. Sending to a room resumes that room's durable session,
 * so a bot's work, its approvals, and the operator's replies all stay in one
 * thread no matter which side started it.
 *
 * `receive` is what makes this channel a valid target for schedules and other
 * channels: it is how the dispatcher wakes HQ every minute without a human in
 * the loop.
 */

const CONSOLE_TOKEN = process.env.BOT_CONSOLE_TOKEN;

function authorize(request: Request): boolean {
  if (CONSOLE_TOKEN === undefined) return true; // Local dev: the server is already local-only.
  return request.headers.get("authorization") === `Bearer ${CONSOLE_TOKEN}`;
}

function principal(request: Request, room: string): SessionAuthContext {
  const user = request.headers.get("x-bot-user") ?? "operator";
  const workspaceId =
    request.headers.get("x-bot-workspace") ?? process.env.BOT_DEFAULT_WORKSPACE ?? "default";
  return {
    attributes: { workspaceId, room },
    authenticator: "bot-console",
    principalId: user,
    principalType: "user",
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export default defineChannel<undefined, void, { room: string }>({
  // A bot is mid-job more often than not; queueing keeps a new instruction from
  // cancelling the turn that is reporting the last one.
  turnPolicy: "queue",

  routes: [
    /**
     * The console: roster, work, live activity, and the desk conversation.
     * Embedded at compile time, so there is no second server to run.
     */
    GET("/bot", async (request) => {
      if (!authorize(request)) return json({ error: "unauthorized" }, 401);
      return new Response(console_, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }),

    POST("/bot/v1/rooms/:room/messages", async (request, { from, params }) => {
      if (!authorize(request)) return json({ error: "unauthorized" }, 401);
      const room = params.room;
      if (room === undefined) return json({ error: "missing room" }, 400);

      const body = (await request.json()) as { message?: string };
      if (typeof body.message !== "string" || body.message.trim() === "") {
        return json({ error: "message is required" }, 400);
      }

      const session = await from(room).send(body.message, { auth: principal(request, room) });
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
      if (!authorize(request)) return json({ error: "unauthorized" }, 401);
      const room = params.room;
      if (room === undefined) return json({ error: "missing room" }, 400);

      const body = (await request.json()) as { responses?: unknown };
      let responses;
      try {
        responses = parseInputResponses(body.responses);
      } catch (error) {
        return json(
          {
            error: "responses must be [{ requestId, optionId? , text? }]",
            detail: error instanceof Error ? error.message : String(error),
          },
          400,
        );
      }
      if (responses.length === 0) return json({ error: "no responses" }, 400);

      const session = await from(room).respond(responses, { auth: principal(request, room) });
      return json({ room, sessionId: session.id, answered: responses.length });
    }),

    POST("/bot/v1/rooms/:room/cancel", async (request, { from, params }) => {
      if (!authorize(request)) return json({ error: "unauthorized" }, 401);
      const room = params.room;
      if (room === undefined) return json({ error: "missing room" }, 400);
      return json(await from(room).cancel());
    }),

    GET("/bot/v1/sessions/:sessionId/stream", async (request, { attachSession, params }) => {
      if (!authorize(request)) return json({ error: "unauthorized" }, 401);
      const sessionId = params.sessionId;
      if (sessionId === undefined) return json({ error: "missing session" }, 400);

      // The handle streams event objects; the wire wants NDJSON bytes.
      const events = await attachSession(sessionId).getEventStream();
      const encoder = new TextEncoder();
      const ndjson = events.pipeThrough(
        new TransformStream<unknown, Uint8Array>({
          transform(event, controller) {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          },
        }),
      );

      return new Response(ndjson, {
        headers: { "content-type": "application/x-ndjson; charset=utf-8" },
      });
    }),

    // Everything a dashboard needs in one call: who is on the team, what is in
    // flight, and what just happened.
    GET("/bot/v1/state", async (request) => {
      if (!authorize(request)) return json({ error: "unauthorized" }, 401);
      const workspaceId =
        new URL(request.url).searchParams.get("workspace") ??
        process.env.BOT_DEFAULT_WORKSPACE ??
        "default";

      const [bots, jobs, activity] = await Promise.all([
        listBots(workspaceId),
        listJobs(workspaceId, { limit: 50 }),
        recentActivity(workspaceId, { limit: 50 }),
      ]);

      return json({
        workspaceId,
        bots: bots.map((bot) => ({
          id: bot.id,
          name: bot.name,
          emoji: bot.emoji,
          role: bot.role,
          status: bot.status,
          stats: bot.stats,
        })),
        jobs: jobs.map((job) => ({
          id: job.id,
          botId: job.botId,
          title: job.title,
          status: job.status,
          runAt: job.runAt,
          everyMinutes: job.everyMinutes,
          summary: job.result?.summary ?? job.error ?? null,
        })),
        activity,
      });
    }),
  ],

  /** Cross-channel and schedule hand-offs land here. The room is the address. */
  async receive(input, { from }) {
    return from(input.target.room).send(input.message, { auth: input.auth });
  },
});
