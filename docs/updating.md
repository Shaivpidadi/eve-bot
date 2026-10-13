# Keeping it up to date

## Vercel

A deployment made with the Deploy button is a copy of this repository in your
GitHub account, not a fork, so nothing pulls new releases in by itself. The
copy carries a workflow, **Sync with upstream**, that does: once a week, and
whenever you run it from your repository's Actions tab, it merges this
repository's `main` into yours and pushes, and Vercel deploys the result. If
you changed code in your copy and the two conflict, it leaves the merge on an
`upstream-sync` branch with the conflicts marked and fails, so you can finish
it by hand. Set a repository variable `BOT_SYNC_UPSTREAM=off` to stop it.

The console says when a newer version is out: **Update now** in the sidebar's
footer opens your copy's sync workflow, where **Run workflow** does it and
Vercel redeploys. It asks GitHub for this repository's version at most every
six hours; `BOT_UPDATE_CHECK=off` stops it asking.

### A copy made before the sync workflow existed

It needs one manual sync to receive the workflow. Its first commit has no
history in common with this repository, so graft it onto the commit whose
files it matches, then merge:

```bash
git clone https://github.com/<you>/<your-copy> && cd <your-copy>
git remote add upstream https://github.com/Shaivpidadi/eve-bot.git && git fetch upstream main
root=$(git rev-list --max-parents=0 HEAD | tail -1)
git replace --graft "$root" "$(git log --format='%H %T' upstream/main | awk -v t="$(git rev-parse "$root^{tree}")" '$2==t{print $1; exit}')"
git merge upstream/main -m "chore: sync with upstream eve-bot" && git push
```

Vercel deploys the push. From then on the workflow keeps the copy current.

## Standalone

Update the way you installed:

```bash
git pull && npm install && npm run build && npm start     # or: docker compose up -d --build
```

## Moving a workspace

A workspace can move between Vercel and your own machine, in either
direction. Everything the app keeps in its store travels: the roster, jobs
and their journals, memory, connectors, usage, and the computer's backups.

```bash
npm run export -- --out workspace.bot.gz        # on the checkout pointed at the old store
npm run import -- --in workspace.bot.gz --dry-run
npm run import -- --in workspace.bot.gz         # on the checkout pointed at the new store, server stopped
```

Each command reads the same environment the server does, so a checkout
with `npx vercel env pull` reads Vercel Blob and a standalone checkout reads
`.data/`. Add `--workspace <id>` to move one workspace, and
`--on-conflict skip` or `fail` to keep what the destination already has.

What does not move:

- **Live runs.** They live in eve's Workflow state, which stays where it
  is. An open job arrives with its run dropped, its thread says it moved,
  and the watchdog picks it up and continues from its journal.
- **Conversations' sessions.** Each thread starts a fresh session and keeps
  its history on screen. Memory carries what the team knows.
- **The computer.** Its backup moves, and restores onto the new computer
  only when it is the same kind (Vercel Sandbox, or local Docker) and CPU.

The file holds connector keys and OAuth tokens, sealed, together with the
key they are sealed with, so treat it like a password. `--no-secrets`
leaves them out; reconnect the connectors after the import.

## Stored data

Stored data is carried forward. A release that changes what is stored reads
the old shape and writes the new one the first time it is needed, so a
deployment can skip versions. Some releases also need a decision from you.

## Upgrading to this version

- **Confirm HQ's connector reads.** HQ now uses only reads a person
  confirmed, so after the upgrade it has no tools from a custom connector, and
  only the catalog-vouched ones from a built-in. Open each connector under
  **Connectors**; where it says tools guessed as reads need your confirmation,
  click **Review**, untick anything that changes something, and confirm.
  Bots keep working meanwhile.
- **Check the email relay.** If `BOT_EMAIL_WEBHOOK` is set, make sure the
  relay dedupes on `Idempotency-Key` and answers as the
  [contract](configuration.md#outbound-email-relay) describes.
  `BOT_EMAIL_WEBHOOK_TIMEOUT_MS` sets how long Bot waits (`30000`).
- **Set a budget.** Without `BOT_BUDGET_MONTHLY_USD` (and optionally
  `BOT_BUDGET_DAILY_USD`) spend is tracked but not capped.
- **Standup room.** The standup now posts to HQ's `desk` by default. A
  `BOT_STANDUP_ROOM` that is not `desk` or a Bot's room (`bot-<id>`), such as
  the old example `standup`, is ignored with a warning; remove it or point it
  at a room the console shows.
