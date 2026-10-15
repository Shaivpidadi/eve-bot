import { defineTool } from "eve/tools";
import { z } from "zod";

import { record } from "../lib/activity";
import { HQ_BOT_ID } from "../lib/bots";
import { operator } from "../lib/session";
import { MAX_NOTE_CHARS, postNote, speakerFor, teammateRoom } from "../lib/teammail";

export default defineTool({
  description:
    "Send a message to a teammate (HQ or a Bot, by name) in their own thread: a question, an answer, a heads-up, or a request. They read it and reply with this tool, and their reply arrives in this thread as a new message. Use it when the operator tags a teammate to ask or tell them something, or when you need something only that teammate knows. It is not a job: to hand work over, use assign_job with their name, which only works when the operator named them.",
  inputSchema: z.object({
    to: z.string().min(1).max(60).describe('The teammate\'s name, such as "Ava" or "HQ".'),
    message: z
      .string()
      .min(1)
      .max(MAX_NOTE_CHARS)
      .describe("What to say, complete enough to act on without this conversation: they cannot see it."),
  }),
  label: { start: ({ to }) => `Message ${to}` },
  async execute(input, ctx) {
    const who = operator(ctx);
    const target = await teammateRoom(who.workspaceId, input.to);
    if (target === null) return { sent: false as const, reason: `No teammate called ${input.to}.` };
    if (target.room === who.room) return { sent: false as const, reason: "That is you." };
    if (target.paused) return { sent: false as const, reason: `${target.name} is paused and will not read it. Tell the operator instead.` };
    const fromName = await speakerFor(who.workspaceId, who.botId);
    const posted = await postNote({
      workspaceId: who.workspaceId,
      from: { name: fromName, room: who.room },
      to: { name: target.name, room: target.room },
      text: input.message,
    });
    if (!posted.ok) return { sent: false as const, reason: posted.reason };
    await record({
      workspaceId: who.workspaceId,
      kind: "team.message",
      botId: who.botId ?? HQ_BOT_ID,
      text: `${fromName} messaged ${target.name}: ${input.message.slice(0, 140)}`,
      data: { to: target.name, noteId: posted.note.id },
    }).catch(() => undefined);
    return {
      sent: true as const,
      to: target.name,
      note: `Delivered to ${target.name}'s thread shortly. Their reply comes back here as a new message; tell the operator you asked, and do not wait for it.`,
    };
  },
});
