# Safety model

What stops a Bot from doing something nobody meant, and what does not. The
store decisions behind it are in
[decisions/0001-state-store.md](decisions/0001-state-store.md).

## Run fencing

A job is worked by one run at a time, the holder of its lease. A Bot's session
is bound to that run when it reads its brief, and every job write and every
outward action (email, connector call, browser action, `create_bot`) checks it
still is. A run whose lease lapsed and was taken over, or whose job was
cancelled, is refused, even holding an approval it was given earlier.

## Cancellation

Stop in the console (`DELETE /bot/v1/jobs/:id`) cancels the job durably and
stops its sessions immediately. Cancelling from a chat (HQ's `cancel_job`)
refuses all of the Bot's actions immediately, kills the run's shell commands,
and stops the Bot before its next model call (a context compaction included);
a run waiting on an approval card ends within a minute. Either way nothing can
mark the job done afterwards.

## Connectors

Every tool has a recorded effect, read or change. A tool nobody classified,
one the server grew since its last check, or one whose name says it can run
anything (SQL, HTTP, shell) counts as a change and needs approval under the
"before changes" gate. HQ never asks, so it only gets reads a person confirmed
(the "reads?" chips, or **Review** on the connector's page) or that the catalog
vouches for.

Every call re-reads the connector, so switching it or a tool off, re-marking a
tool, or rotating a key bites on the next call. An approval is recorded with
the permission version the person was asked under, only if the settings have
not changed since, and stops counting once any of them change. An approval
that lands after the job was cancelled or taken over, or for a tool switched
off or a connector removed since the request, is rejected: the call never
runs, and the person denies the card.

Approvals are structured answers sent through the signed-in console
(`/respond`); a plain "yes" typed into a chat is a new message, not an
approval.

## Browser

Every click, Enter, selection, checkbox and upload is classified first. It
asks when the control's words send, spend, publish, delete, confirm or save a
change ("Save", "Add member", "Apply"), when it submits a non-GET form or a
form posting to another site, on checkout and payment pages, when the element
cannot be inspected, and for every file upload. Typing, plain navigation, and
whole labels that only rearrange the page ("Apply filters", "Clear search",
"Reset zoom") on a control that submits nothing do not.

An approval is bound to the exact page address (query and fragment included)
and the element as it looked: its role, name, form target, its row and
position among same-named elements, and the field's value for an Enter. If
any of that changed, or the page renumbered the ref, it asks again.

Words and structure cannot see a button labelled "Continue" or "Done" whose
page script posts an order, so every click the gate lets through runs with a
network guard on the Bot's tab: reads (GET, HEAD, OPTIONS) go on, and anything
else the click sends (a POST, PUT, PATCH or DELETE, a JSON call, a form posted
from script) is stopped inside the browser and turns the click into an
approval request; once approved, the click is made again with nothing held
back. The new page a link opens loads freely, and beacons and well-known
analytics are dropped quietly rather than asked about. A click whose sending
cannot be watched asks first.

Not seen: requests a page's service worker makes on its own, WebSocket
messages, a GET with side effects, and what a page sends more than a moment
after the click (`BOT_BROWSER_GUARD_MS`, default 1200). Use an egress
allow-list for anything sensitive.

## Email

Each send is recorded in an action ledger before it goes out, with an id bound
to the run and the exact payload, and the relay receives it as
`Idempotency-Key`. Delivery toward the relay is at least once, so the relay
must dedupe; see [Outbound email relay](configuration.md#outbound-email-relay).

## Budgets

`BOT_BUDGET_MONTHLY_USD` and `BOT_BUDGET_DAILY_USD` cap what the workspace
spends on models, per UTC month and day. A run reserves an estimate before it
starts; one that would not fit is blocked with the reason. Spend is counted
after each model step, so the limit can be overshot by the steps in flight
when it runs out: a run past its reservation with no budget left is halted
before its next step. A step whose provider reported no cost is counted and
shown as unknown, never as free.

Vercel Sandbox runtime is charged to the workspace once you set its rate
(`BOT_COMPUTER_USD_PER_HOUR` and friends): each session the computer ran is
charged once it stops, swept before the next run is admitted and whenever the
usage page loads (and by the tick); until a rate is set it is shown as
unpriced. `BOT_JOB_COST_LIMIT_USD` and `BOT_HQ_COST_LIMIT_USD` still cap each
session.

## Shell

The Bots' shell runs as a separate unprivileged user behind a network fence,
so it cannot reach the browser, the team's sign-ins, or the gateway key. See
[The Bots' shell](configuration.md#the-bots-shell).

## Limits

- One computer per deployment, shared by every Bot and workspace. Sign-ins are
  pooled. Use separate deployments for work that must be isolated.
- Backups can be up to `BOT_BACKUP_EVERY_MINUTES` old; browser profiles are not
  archived, the team's sign-ins are.
- Egress is open by default so the browser can install itself. Set an
  allow-list before pointing a Bot at anything sensitive.
- Page content is untrusted. An allow-list is the control that holds, not the
  instruction to ignore text on a page.
- A local computer's Chrome runs without its own sandbox unless eve is given
  the seccomp wrapper in `scripts/`; Docker Compose does this by default.
- Delivery is at-least-once. Anything a Bot does outwardly should be idempotent
  or gated on approval.
