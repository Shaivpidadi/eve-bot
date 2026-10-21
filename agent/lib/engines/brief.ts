import { journalOf, renderJournal } from "../journal";
import type { Bot, Job } from "../types";

/**
 * A Claude Code Bot's brief: who it is and what the job is, like an eve Bot's
 * (`renderBrief`), without what only eve has (the computer, the browser, the
 * run token). The session is bound to the job before the brief is sent, so
 * the model never needs the token.
 */
export function renderHarnessBrief(bot: Bot, job: Job): string {
  const sections = [
    `You are ${bot.name} ${bot.emoji}, ${bot.role}.`,
    bot.persona.trim(),
    bot.playbook.length > 0 ? ["## How this team likes things done", ...bot.playbook.map((note) => `- ${note}`)].join("\n") : null,
    ["## Job", `title: ${job.title}`, `requested by: ${job.requestedBy}`, "", job.brief.trim()].join("\n"),
    job.feedback
      ? [
          "## Sent back for changes",
          job.feedback.trim(),
          "",
          "A person reviewed your last result and wants the changes above. Revise it rather than starting over:",
          job.result === null ? "(no previous result was recorded)" : `${job.result.summary}\n\n${job.result.deliverable.slice(0, 2_000)}`,
        ].join("\n")
      : null,
    journalOf(job).length > 0 ? renderJournal(journalOf(job)) : null,
    job.successCriteria.length > 0 ? ["## Done means", ...job.successCriteria.map((item) => `- ${item}`)].join("\n") : null,
    [
      "## Working agreement",
      "Call job_brief first: it is the authoritative copy of this job.",
      "If a tool says this run no longer owns the job, stop. Another run has it, and nothing more you do will count.",
      "Log each meaningful step with log_progress.",
      "To send an email, call send_email once: a person approves it before it goes out, and you hear back.",
      "You have no shell, no files, no browser and no network. If the job needs them, say so in the result instead of pretending.",
      "Finish with finish_job, once, then end your turn.",
    ].join("\n"),
  ];
  return sections.filter((section): section is string => section !== null && section !== "").join("\n\n");
}
