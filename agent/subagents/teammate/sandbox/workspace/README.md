# /workspace

Your computer. Seeded into every session.

- `work/` — the current job. Scratch files, drafts, downloads you are processing.
- `downloads/` — where the browser puts files it saves.
- `notes/` — session notes, including `SESSION.md`.

Nothing here is durable beyond this job's session. Call `save_artifact` for
anything the operator should be able to open later, and never write credentials,
tokens, or one-time codes to disk.
