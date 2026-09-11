---
description: Use when writing a job brief, deciding which bot should do something, or setting up recurring work.
---

# Running the team

## Choosing the bot

Match the work to a bot's role, not its name. If two bots could do it, pick the
one whose playbook already covers this system — it will need fewer round trips.
If none fit, hire one; a bot with a sharp role beats a generalist with five.

## Writing a brief that a stranger could execute

The bot cannot see this conversation. Assume it knows nothing about the operator,
the company, or what was said five minutes ago. A brief that works includes:

- **The goal in one sentence**, phrased as the outcome, not the activity.
- **The inputs**: URLs, account names, file paths, the exact search terms.
- **The destination**: which system the finished work lands in, and where.
- **The constraints**: tone, format, length, deadline, what not to touch.
- **Sign-ins**: if the work is inside an app that may need signing in, say "if a
  sign-in, 2FA, or CAPTCHA appears, ask the operator to take over with
  `request_takeover`, then continue". A person signs in in the Bot's live
  browser; never tell a Bot to stop at a login screen or handle credentials.
- **Done means**: two or three checkable statements. "The row exists in the CRM
  with stage = Contacted" is checkable; "the CRM is updated" is not.

If you cannot write the success criteria, you do not yet understand the request
well enough to delegate it. Ask the operator one question instead of guessing.

## Effort

Every job has an effort level, and it decides the model the bot works on:

| Effort | For | Relative cost |
| --- | --- | --- |
| `quick` | a lookup, a status check, a simple recurring monitor | about a tenth of standard |
| `standard` | most work: operating web apps, reading, summarizing, drafting | baseline |
| `deep` | hard multi-step research, analysis, coding, anything high-stakes | about 2.5x standard |

Pick the lowest level that will do the job well. Recurring jobs run many times,
so they are the first place to use `quick`. A job that fails re-runs one level
up automatically, so starting low costs little.

## Recurring work

`everyMinutes` turns a job into a standing duty; it re-arms itself after every
run. Start it with `run_job` like any job; the run reports after every cycle and
waits for the next one by itself. Call `run_job` again only when a result
carries `next`. Two rules keep that from becoming noise:

1. Make the brief conditional — "report only if something changed" — so a quiet
   day produces silence rather than a report saying nothing happened.
2. Give it success criteria that hold on every run, not just the first.

Use `runAt` for a one-off in the future. Both are UTC on Vercel.

## Sign-off

Set `requiresSignoff: true` when the operator wants to review the work first, or
the deliverable is public, irreversible, or expensive to undo. Research,
analysis, saved files, and monitors do not need it. The bot will do all the work
and then wait for a human, holding no compute while it waits. That is cheaper
than an apology.

A person answers on the sign-off card. When they send work back with a note, the
result says `sent back`: call `run_job` for the same job right away, and the same
bot revises it with the note in its brief. A result that says `signedOff` was
already approved, so never ask again.

## Reporting back

When a job finishes, say what it produced, not that it ran. Lead with the
deliverable. Mention `openQuestions` only if the operator has to act on them, and
say plainly when a result was not verified.
