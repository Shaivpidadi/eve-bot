# /workspace

The team's computer. Every Bot works here, and what you leave behind is here for
the next job.

- `shared/` — material the whole team can reuse. Add a short README to anything you put here.
- `bots/<your-name>/` — your own space. Keep work in progress here.
- `downloads/` — where the browser saves files.
- `sessions/` — per-run scratch the tools use, such as screenshots. Not backed up.

Other Bots may be working at the same time. Do not delete or rewrite files you
did not create unless your job says to.

The computer is backed up while Bots work and restored if it is ever replaced,
but a backup can be minutes old. Call `save_artifact` for anything the operator
should be able to open, and never write credentials, tokens, or one-time codes
to disk.
