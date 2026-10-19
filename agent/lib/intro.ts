import { generateText, Output } from "ai";
import { z } from "zod";

import { patchBot } from "./bots";
import { spent } from "./jev";
import { helperModel } from "./memory/capture";
import { chargeUsage, reportedCost } from "./spend";
import type { Bot } from "./types";
import { withGatewayOptions } from "./models";

const INTRO = z.object({
  hello: z.string().min(1).max(240).describe("One or two sentences, first person, in the voice the persona describes: who it is and what to hand it."),
  starters: z
    .array(z.string().min(1).max(90))
    .length(3)
    .describe("Three first jobs a person could send it as written, in the person's words (imperative), specific to its role."),
});

/**
 * Writes a hand-made Bot's introduction for its empty thread, with the quick
 * model, after it is hired. A Bot hired from a template already has one. Best
 * effort: without it the thread shows the usual suggestions, and the cost goes
 * on the Bot's own bill.
 */
export async function writeIntro(bot: Bot): Promise<Bot["intro"]> {
  const { model, id: modelId } = await helperModel(bot.workspaceId);
  const result = await generateText({
    model,
    output: Output.object({ schema: INTRO }),
    providerOptions: withGatewayOptions(),
    system:
      "You write the first thing a new AI teammate says in its empty chat thread, and three jobs to try. Plain words, no emoji, no exclamation marks, nothing it cannot do. It works in a browser and a shell on a shared computer, and asks before anything is sent or changed.",
    prompt: [`Name: ${bot.name}`, `Job: ${bot.role}`, "How it works:", bot.persona.slice(0, 2_000)].join("\n"),
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(30_000),
  });
  void chargeUsage(bot.workspaceId, { botId: bot.id }, spent(result.usage, result.providerMetadata, modelId), {
    costReported: reportedCost(result.providerMetadata) !== null,
  }).catch(() => undefined);
  const intro = { hello: result.output.hello.trim(), starters: result.output.starters.map((starter) => starter.trim()) };
  await patchBot(bot.workspaceId, bot.id, (current) => (current.intro ? current : { ...current, intro }));
  return intro;
}
