"use client";

import { useEffect, useRef, useState } from "react";

import { api, errorMessage, SignedOutError } from "./api";

/** A new Bot is a name, a job, and a short description of how it should work. */
export function HireDialog({
  open,
  onClose,
  onHired,
}: {
  open: boolean;
  onClose: () => void;
  onHired: (botId: string) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) {
      setError(null);
      element.showModal();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open]);

  return (
    <dialog ref={dialog} onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          const field = (name: string) => String(data.get(name) ?? "").trim();
          setBusy(true);
          setError(null);
          try {
            const response = await api("/bot/v1/bots", {
              method: "POST",
              body: JSON.stringify({ name: field("name"), role: field("role"), persona: field("persona") }),
            });
            if (!response.ok) {
              setError(await errorMessage(response, "Could not create the Bot."));
              return;
            }
            const created = (await response.json()) as { bot: { id: string } };
            form.reset();
            onClose();
            await onHired(created.bot.id);
          } catch (caught) {
            if (!(caught instanceof SignedOutError)) setError("Could not create the Bot.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <h2>New Bot</h2>
        <p>Give it a name, a job, and a short description of how it should work.</p>
        <label>
          Name
          <input name="name" maxLength={40} required placeholder="Ava" />
        </label>
        <label>
          Job
          <input name="role" maxLength={120} required placeholder="Handles inbound sales follow-up" />
        </label>
        <label>
          How it should work
          <textarea
            name="persona"
            rows={5}
            minLength={20}
            maxLength={4000}
            required
            placeholder="Warm and brief. Never promises a discount. Drafts come to me before anything is sent."
          />
        </label>
        {error === null ? null : <p className="error-text">{error}</p>}
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            Create Bot
          </button>
        </div>
      </form>
    </dialog>
  );
}
