"use client";

import { useEffect, useRef, useState } from "react";

/** A small question for the person: a name to type, or a yes to a consequence. */
export interface Prompt {
  readonly title: string;
  readonly description?: string;
  /** With a label the dialog asks for text; without one it only confirms. */
  readonly label?: string;
  readonly defaultValue?: string;
  readonly placeholder?: string;
  readonly maxLength?: number;
  readonly confirm: string;
  readonly danger?: boolean;
  /** Returns an error to show, or null when done. */
  readonly onConfirm: (value: string) => Promise<string | null>;
}

export function PromptDialog({ prompt, onClose }: { prompt: Prompt | null; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (prompt !== null && !element.open) {
      setError(null);
      element.showModal();
      element.querySelector<HTMLInputElement>("input")?.select();
    } else if (prompt === null && element.open) {
      element.close();
    }
  }, [prompt]);

  return (
    <dialog ref={dialog} onClose={onClose} className="prompt-dialog">
      {prompt === null ? null : (
        <form
          key={prompt.title + (prompt.defaultValue ?? "")}
          onSubmit={async (event) => {
            event.preventDefault();
            const value = String(new FormData(event.currentTarget).get("value") ?? "").trim();
            if (prompt.label !== undefined && value === "") return;
            setBusy(true);
            setError(null);
            try {
              const problem = await prompt.onConfirm(value);
              if (problem === null) onClose();
              else setError(problem);
            } finally {
              setBusy(false);
            }
          }}
        >
          <h2>{prompt.title}</h2>
          {prompt.description === undefined ? null : <p>{prompt.description}</p>}
          {prompt.label === undefined ? null : (
            <label>
              {prompt.label}
              <input
                name="value"
                defaultValue={prompt.defaultValue ?? ""}
                placeholder={prompt.placeholder}
                maxLength={prompt.maxLength ?? 120}
                required
                autoComplete="off"
              />
            </label>
          )}
          {error === null ? null : <p className="error-text">{error}</p>}
          <div className="actions">
            <button type="button" className="btn" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className={prompt.danger ? "btn danger-fill" : "btn primary"} disabled={busy}>
              {busy ? "…" : prompt.confirm}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
