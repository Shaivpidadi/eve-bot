# Plan: the console as an app that reaches out

Branch `feat/notifications`. Tags: `[to-do]`, `[in-progress]`, `[done]`, `[parked]`.
Conventional Commits, no co-author line, one commit per small task. Full check (typecheck, tests, build) after each
task; a live check on a real device after each phase.

## Why

Bots work while nobody watches, so the moments that matter happen when the console is closed: a Bot needs an
approval, a job finished or failed, or a routine found something worth knowing. Today a person learns of them only by
opening the console. Assistants like Muse reach out instead: a push notification when there is something to say, and
silence when there is not. eve-bot should do the same, without a third-party push service, on Vercel and locally.

## Decisions (asked 20 Oct)

- **D1. Standard Web Push, no vendor.** The server signs pushes with its own VAPID keys, made on first use and kept
  sealed in the store like the computer key. It works in Chrome, Edge, Firefox and Safari on the desktop and on
  Android; on iPhone and iPad only once the console is installed to the Home Screen (iOS 16.4+), which is why the
  installable app comes first.
- **D2. A notification opens; it never approves.** Clicking one opens the approval card, the job or the thread. Nothing
  outward is approved from a lock screen without seeing what it is.
- **D3. Few, and worth it.** Three kinds, and silence otherwise:
  - **Needs you:** an approval, a Bot's question, a job blocked on a person, a budget stop. At once, always.
  - **Done:** a job finished (with what it made) or failed for good. At once.
  - **Proactive:** a Bot or HQ decides something is worth telling (a watched price dropped, a brief is ready). Through
    a `notify` tool, rate-limited and de-duplicated.

  Never: step progress, memory saves, a routine run with nothing new.
- **D4. Per person, with quiet hours.** Each person chooses the kinds, quiet hours in their timezone (only "Needs you"
  breaks them; the rest waits for the morning) and a limit per hour. "Only when I'm away" skips a push for what an
  open, focused console tab already shows.

## Phases

### N1. The console installs as an app `[done]`
- A web app manifest for the console (`/bot/manifest.webmanifest`): name, icons (including maskable), `start_url`
  and `scope` `/bot`, standalone display, theme colors. Linked from the console only, with credentials, so a
  deployment behind Vercel Authentication can still be installed.
- A service worker at `/bot/sw.js`, scoped to the console, never cached by the browser. No fetch handler and no
  offline caching: the console needs the server anyway, and a cached console is how stale-UI bugs start.
- Apple's home-screen tags (title, status bar, touch icon).
- "Install the app" in the sidebar's footer where the browser offers it (`beforeinstallprompt`), and on iPhone
  Safari a short how-to (Share → Add to Home Screen). Dismissible; never shown inside the installed app.
- **Done when:** the console installs from Chrome on macOS and from Safari on iPhone, opens in its own window at
  `/bot`, and signs in. Installed and signed in on iPhone, 20 Oct.

### N2. Push basics `[done]`
- VAPID keys made once and sealed in the store; the public key served to the console.
- Subscribe and unsubscribe from the console; subscriptions stored per person and workspace
  (`push/<ws>/<id>.json`), dropped when a push service answers 404 or 410.
- Sending through the durable outbox, so a push survives a function ending and is retried.
- The service worker shows the notification and, on click, focuses an open console or opens one at the link.
- "Send a test" in Settings, and "Show one here" (a notification made on the device alone), with a line saying what
  became of the test: shown, arrived but not shown, or never arrived.
- Checked 20 Oct on iPhone (installed app) and Chrome on a Mac. The Mac first received pushes it never showed: two
  server instances had each made a key pair on first use, and Chrome drops a push signed with a key other than the one
  it subscribed with. The server now always signs with the stored pair, and a device on another key subscribes again.

### N3. Needs you and Done `[done]`
- Rules on `record()` (`agent/lib/activity.ts`), the one place every event passes: `input.requested`, approvals,
  `job.blocked`, budget stops, `job.done` (with the files it made), `job.failed` for good.
- Deep links to the approval, job or thread; a tag per job, so a newer push replaces an older one.
- Skipped when a focused console tab already shows it; held in quiet hours unless it needs the person.
- As built: rules in `agent/lib/notify.ts`, called from `record()` for four kinds only; a job a person sent back
  themselves, a failed turn and steps never notify; the same push within 30 seconds goes once; "skipped when looking"
  is decided in the service worker (Chrome only; Safari always shows, as it revokes push for silent ones); links are
  `/bot?thread=<id>`. Checked live 20 Oct: a recorded "needs you" event was shown by a subscribed browser.

### N4. Proactive `[to-do]`
- A `notify` tool for HQ and Bots: title, body, link, and a key so the same news is sent once.
- A per-workspace limit per hour, and a routine option, "tell me only if something changed".
- A morning brief that pushes only when there is something in it.

### N5. Settings → Notifications `[to-do]`
- Per person: the kinds, quiet hours, the limit, "only when I'm away", the devices subscribed (with Remove).
- Docs: `docs/configuration.md`, and a short section in the README.

## Not in scope
- Approving or denying from the notification itself (D2).
- Email or SMS fallbacks; Slack already has its own channel.
- A native desktop app; the installable console covers what this needs.
