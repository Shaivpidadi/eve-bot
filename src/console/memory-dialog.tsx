"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { api, errorMessage, isRecord, SignedOutError } from "./api";
import { Icon } from "./icons";

type Slot = "profile" | "team" | "craft";

interface SlotMemory {
  readonly slot: Slot;
  readonly shared: boolean;
  readonly started: boolean;
  readonly entries: readonly { readonly index: number; readonly text: string }[];
  readonly used: number;
  readonly maxCharacters: number;
}

const COPY: Readonly<Record<Slot, { title: string; detail: string; placeholder: string }>> = {
  profile: {
    title: "About you",
    detail: "How you like things done. HQ keeps it for you alone.",
    placeholder: "Keep summaries to five bullets",
  },
  team: {
    title: "Your team",
    detail: "Conventions everyone in this workspace shares, such as who approves what.",
    placeholder: "Invoices over $5,000 need Priya's approval",
  },
  craft: {
    title: "How to do your work",
    detail: "What Bots have learned doing jobs for you: the quirks of your tools and what a finished job looks like.",
    placeholder: "Export reports from the CRM as CSV; the PDF drops rows",
  },
};

/**
 * What HQ and the Bots remember, recalled before every turn. HQ and the Bots
 * save and forget memories as they work; here a person can see all of it and
 * add or forget one by hand.
 */
export function MemoryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [slots, setSlots] = useState<readonly SlotMemory[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});

  const load = useCallback(async () => {
    try {
      const response = await api("/bot/v1/memory");
      const body: unknown = await response.json().catch(() => null);
      if (response.ok && isRecord(body) && Array.isArray(body.slots)) setSlots(body.slots as SlotMemory[]);
      else setError("Could not load memory.");
    } catch (caught) {
      if (!(caught instanceof SignedOutError)) setError("Could not load memory.");
    }
  }, []);

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) {
      setError(null);
      element.showModal();
      void load();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open, load]);

  /** Runs one change, shows its error if any, and reloads. */
  const act = async (id: string, request: () => Promise<Response>, fallback: string): Promise<boolean> => {
    setBusy(id);
    setError(null);
    try {
      const response = await request();
      if (!response.ok) {
        setError(await errorMessage(response, fallback));
        return false;
      }
      await load();
      return true;
    } catch (caught) {
      if (!(caught instanceof SignedOutError)) setError(fallback);
      return false;
    } finally {
      setBusy(null);
    }
  };

  return (
    <dialog ref={dialog} onClose={onClose} className="memory-dialog">
      <div className="dialog-body">
        <h2>Memory</h2>
        <p>What HQ and your Bots remember and bring to every conversation. They save and forget things as they work.</p>

        {slots === null ? <p className="faint">Loading…</p> : null}
        {slots?.map((memory) => {
          const copy = COPY[memory.slot];
          const draft = drafts[memory.slot] ?? "";
          const full = Math.min(100, Math.round((memory.used / memory.maxCharacters) * 100));
          return (
            <section key={memory.slot} className="plugins-section">
              <h3>{copy.title}</h3>
              <p className="faint">{copy.detail}</p>
              {memory.entries.length === 0 ? (
                <p className="faint">
                  {memory.started
                    ? "Nothing remembered yet."
                    : memory.slot === "craft"
                      ? "Bots start this memory with their first job for you."
                      : "HQ starts this memory the first time you message it."}
                </p>
              ) : (
                <ul className="memory-list">
                  {memory.entries.map((entry) => (
                    <li key={entry.index}>
                      <span>{entry.text}</span>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label="Forget"
                        title="Forget"
                        disabled={busy !== null}
                        onClick={() =>
                          void act(
                            `${memory.slot}:${entry.index}`,
                            () => api(`/bot/v1/memory/${memory.slot}/${entry.index}`, { method: "DELETE" }),
                            "Could not forget that.",
                          )
                        }
                      >
                        <Icon name="x" size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {memory.started ? (
                <form
                  className="memory-add"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    const saved = await act(
                      memory.slot,
                      () => api(`/bot/v1/memory/${memory.slot}`, { method: "POST", body: JSON.stringify({ text: draft }) }),
                      "Could not save that.",
                    );
                    if (saved) setDrafts((current) => ({ ...current, [memory.slot]: "" }));
                  }}
                >
                  <input
                    value={draft}
                    onChange={(event) => setDrafts((current) => ({ ...current, [memory.slot]: event.target.value }))}
                    placeholder={copy.placeholder}
                    maxLength={500}
                    aria-label={`Add to ${copy.title}`}
                  />
                  <button type="submit" className="btn" disabled={busy !== null || draft.trim() === ""}>
                    Add
                  </button>
                </form>
              ) : null}
              {memory.entries.length === 0 ? null : (
                <span className="faint">{`${memory.entries.length} saved · ${full}% full`}</span>
              )}
            </section>
          );
        })}

        <p className="faint">Each Bot also keeps its own Playbook of lessons, in its settings.</p>
        {error === null ? null : <p className="error-text">{error}</p>}
        <div className="actions">
          <button type="button" className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </dialog>
  );
}
