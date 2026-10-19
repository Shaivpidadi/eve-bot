import { generateText, Output } from "ai";
import { z } from "zod";

import { spent } from "./jev";
import { helperModel } from "./memory/capture";
import { chargeUsage, reportedCost } from "./spend";
import { TEMPLATES } from "./templates";
import { withGatewayOptions } from "./models";

/** The most Bots one description proposes; a team grows from there. */
export const MAX_PROPOSED = 5;

const TEMPLATE_IDS = TEMPLATES.map((template) => template.id) as [string, ...string[]];

const PROPOSAL = z.object({
  bots: z
    .array(
      z.object({
        name: z.string().min(1).max(40).describe("A short human first name such as Vera or Theo: never a word for its work (not Market, Inbox or Poster), and not used by anyone on the team."),
        role: z.string().min(1).max(120).describe("Its job in one line, as a roster would show it."),
        persona: z.string().min(20).max(800).describe("How it works: tone, what it checks, what it never does without asking. Two to four sentences."),
        skills: z.array(z.string().min(1).max(20)).min(1).max(6).describe("Lower-case capability words, e.g. research, browser, email, writing, analysis, shell."),
        template: z.enum([...TEMPLATE_IDS, "none"]).describe("The starting point it is closest to, or none."),
        why: z.string().min(1).max(140).describe("Why the person needs it, in their terms, one line."),
      }),
    )
    .min(1)
    .max(MAX_PROPOSED),
});

export type ProposedBot = z.infer<typeof PROPOSAL>["bots"][number];

/**
 * A roster for what a person says they need, from the quick model: one Bot per
 * distinct kind of work, none that duplicates someone already on the team.
 * Nothing is created here; the person picks which to hire.
 */
export async function proposeRoster(workspaceId: string, need: string, team: readonly { name: string; role: string }[]): Promise<ProposedBot[]> {
  const { model, id: modelId } = await helperModel(workspaceId);
  const result = await generateText({
    model,
    output: Output.object({ schema: PROPOSAL }),
    providerOptions: withGatewayOptions(),
    system: [
      "You plan a small team of AI teammates for a person. Each teammate works in a browser and a shell on a shared computer, can be scheduled, and asks before anything is sent, paid, deleted or published.",
      `Propose one teammate per distinct kind of recurring work in what they describe, at most ${MAX_PROPOSED}, fewer when fewer fit. Do not propose work someone on the team already covers. A teammate called HQ already runs the team, so never propose a manager or coordinator.`,
      `Starting points you can match: ${TEMPLATES.map((template) => `${template.id} (${template.title}: ${template.blurb})`).join("; ")}.`,
    ].join("\n"),
    prompt: [
      "# On the team already",
      team.length === 0 ? "(nobody yet)" : team.map((member) => `- ${member.name}: ${member.role}`).join("\n"),
      "",
      "# What the person needs",
      need.slice(0, 2_000),
    ].join("\n"),
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(45_000),
  });
  void chargeUsage(workspaceId, "hq", spent(result.usage, result.providerMetadata, modelId), {
    costReported: reportedCost(result.providerMetadata) !== null,
  }).catch(() => undefined);
  const taken = new Set(team.map((member) => member.name.toLowerCase()));
  const seen = new Set<string>();
  return result.output.bots.filter((bot) => {
    const name = bot.name.trim().toLowerCase();
    if (taken.has(name) || seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}
