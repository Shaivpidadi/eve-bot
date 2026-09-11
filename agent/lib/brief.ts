import { DEFAULT_EFFORT } from "./models";
import type { Bot, Job } from "./types";

/**
 * Everything a teammate needs, in one message.
 *
 * A subagent never sees the parent's conversation, so the brief is the whole
 * contract: who the bot is, what it learned last time, what was asked for, and
 * what counts as done.
 */
export function renderBrief(bot: Bot, job: Job): string {
  const sections = [
    `You are ${bot.name} ${bot.emoji}, ${bot.role}.`,
    bot.persona.trim(),
    bot.playbook.length > 0
      ? ["## How this team likes things done", ...bot.playbook.map((note) => `- ${note}`)].join("\n")
      : null,
    [
      "## Job",
      `id: ${job.id}`,
      `title: ${job.title}`,
      `requested by: ${job.requestedBy}`,
      job.everyMinutes === null ? "cadence: one-off" : `cadence: every ${job.everyMinutes} minutes`,
      // Read back by the teammate's model choice (see models.ts); keep the format.
      `effort: ${job.effort ?? DEFAULT_EFFORT}`,
      job.requiresSignoff ? "sign-off: a human must approve the deliverable" : "sign-off: not required",
      "",
      job.brief.trim(),
    ].join("\n"),
    job.feedback
      ? [
          "## Sent back for changes",
          job.feedback.trim(),
          "",
          "A person reviewed your last result and wants the changes above. Revise that work rather than starting over:",
          job.result === null
            ? "(no previous result was recorded)"
            : `${job.result.summary}\n\n${job.result.deliverable.slice(0, 2_000)}`,
        ].join("\n")
      : null,
    job.successCriteria.length > 0
      ? ["## Done means", ...job.successCriteria.map((item) => `- ${item}`)].join("\n")
      : null,
    [
      "## Working agreement",
      `Call job_brief("${job.id}") first — it is the authoritative copy of this job.`,
      "Log each meaningful step with log_progress so the operator can follow along.",
      "Save anything worth keeping with save_artifact before you finish.",
      "If you are blocked on a decision only a human can make, ask_question instead of guessing.",
      "Close the job with finish_job. Do not report success you have not verified.",
    ].join("\n"),
  ];

  return sections.filter((section): section is string => section !== null).join("\n\n");
}

/** The result contract a teammate returns to the dispatcher. */
export const JOB_RESULT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "One or two sentences an operator can read." },
    deliverable: { type: "string", description: "The actual output, or where it now lives." },
    openQuestions: { type: "array", items: { type: "string" } },
    needsHuman: {
      type: "boolean",
      description:
        "True only when the job cannot count as done until a person acts. Open questions alone are not a reason; list them in openQuestions.",
    },
  },
  required: ["summary", "deliverable", "openQuestions", "needsHuman"],
  additionalProperties: false,
} as const;
