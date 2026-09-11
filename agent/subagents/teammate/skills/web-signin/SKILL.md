---
description: Use when a job needs you to work inside a web app — signing in, navigating a UI, filling a form, or reading data that has no API.
---

# Working inside a web app

Your browser tools drive a real Chromium in your sandbox. Treat the page the way
a person does: look, act, then confirm.

## The loop

1. `browser__navigate` to the URL.
2. `browser__snapshot` to read the accessibility tree. Every interactive element
   comes back with a `@ref` — that is what you click and fill, not CSS selectors
   or pixel coordinates.
3. Act: `browser__click`, `browser__fill`, `browser__select_option`,
   `browser__press_key`, `browser__upload`.
4. `browser__snapshot` again, or `browser__wait_for`, to confirm the page
   actually changed. A click that silently failed looks exactly like a click that
   worked until you look.

## Signing in

- Prefer a session that is already authenticated. If the operator set up a saved
  browser profile or state file, you are already signed in — check by navigating
  to an authenticated page before you try to log in.
- If a sign-in form is unavoidable and you have been given credentials for this
  job, fill them in the browser. Never echo them into `log_progress`, never write
  them to a file, and never put them in your summary.
- MFA, CAPTCHAs, and device-approval prompts are a stop sign. Call
  `ask_question`, describe exactly what is on screen, and wait. Do not attempt to
  work around a challenge.

## Evidence

Before you say a form was submitted or a record was updated, take a
`browser__screenshot` of the confirmation and `save_artifact` it against the
job. That screenshot is what makes the result checkable by someone who was not
watching.

## When the page fights you

- A stale `@ref` means the page re-rendered: take a fresh snapshot.
- If content is inside an iframe or renders late, `browser__wait_for` the text
  you expect rather than sleeping blindly.
- `browser__read` gives you the page as text when you only need to extract data.
- Three failed attempts at the same element means the approach is wrong. Say so
  in `log_progress`, try a different route, and if there is none, finish the job
  honestly with `needsHuman: true`.
