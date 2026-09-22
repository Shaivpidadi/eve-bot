"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { api, errorMessage, isRecord, SignedOutError } from "./api";
import { Icon } from "./icons";

type Slot = "profile" | "team" | "craft";
type Kind = "preference" | "fact" | "rule" | "lesson";

interface Entry {
  readonly id: string;
  readonly text: string;
  readonly kind: Kind;
  readonly source: { readonly who: "hq" | "bot" | "you" | "auto" | "import"; readonly name?: string; readonly room?: string | null; readonly jobId?: string | null };
  readonly at: string;
  readonly pinned: boolean;
  readonly recalls: number;
  readonly lastRecalledAt: string | null;
}

interface SlotView {
  readonly slot: Slot;
  readonly label: string;
  readonly detail: string;
  readonly maxEntries: number;
  readonly entries: readonly Entry[];
}

interface Playbook {
  readonly botId: string;
  readonly name: string;
  readonly emoji: string;
  readonly playbook: readonly string[];
}

interface RecipeRow {
  readonly id: string;
  readonly name: string;
  readonly when: string;
  readonly brief: string;
  readonly uses: number;
}

interface View {
  readonly slots: readonly SlotView[];
  readonly playbooks: readonly Playbook[];
}

const PLACEHOLDER: Readonly<Record<Slot, string>> = {
  profile: "Prefers summaries as three bullets",
  team: "Invoices over $5,000 need Priya's approval",
  craft: "Export reports from the CRM as CSV; the PDF drops rows",
};

const when = (at: string) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Where a memory came from, in a few words. */
function provenance(entry: Entry): string {
  const { source } = entry;
  const from = source.room === undefined || source.room === null ? "" : source.room === "desk" ? " from the desk" : "";
  switch (source.who) {
    case "you":
      return `You added it · ${when(entry.at)}`;
    case "hq":
      return `HQ saved it${from} · ${when(entry.at)}`;
    case "bot":
      return `${source.name ?? "A Bot"} saved it${source.jobId ? " during a job" : ""} · ${when(entry.at)}`;
    case "auto":
      return `Picked up${source.name ? ` from ${source.name}'s job` : from} · ${when(entry.at)}`;
    case "import":
      return `Carried over · ${when(entry.at)}`;
  }
}

/**
 * Everything the team remembers, on one page: the three shared slots with
 * where each memory came from, each Bot's playbook, and the recipes. Memory
 * forms on its own as people talk to HQ and Bots do jobs; here it can be
 * read, searched, pinned, corrected, and forgotten.
 */
export function MemoryPage({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<View | null>(null);
  const [recipes, setRecipes] = useState<readonly RecipeRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await api("/bot/v1/memory");
      const body: unknown = await response.json().catch(() => null);
      if (response.ok && isRecord(body) && Array.isArray(body.slots)) {
        setView(body as unknown as View);
        setError(null);
      } else setError("Could not load memory.");
      const saved = await api("/bot/v1/recipes");
      const list: unknown = await saved.json().catch(() => null);
      if (saved.ok && isRecord(list) && Array.isArray(list.recipes)) setRecipes(list.recipes as RecipeRow[]);
    } catch (caught) {
      if (!(caught instanceof SignedOutError)) setError("Could not load memory.");
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 20_000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && editing === null) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, editing]);

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

  const needle = query.trim().toLowerCase();
  const matches = (text: string) => needle === "" || text.toLowerCase().includes(needle);
  const total = useMemo(() => view?.slots.reduce((sum, slot) => sum + slot.entries.length, 0) ?? 0, [view]);

  return (
    <div className="usage-page memory-page" role="region" aria-label="Memory">
      <header className="usage-head">
        <button type="button" className="icon-btn" aria-label="Back to the console" title="Back" onClick={onClose}>
          <Icon name="left" size={18} />
        </button>
        <h1>Memory</h1>
        <label className="search memory-search">
          <Icon name="search" size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search everything remembered" aria-label="Search memory" />
        </label>
        <span className="faint">{view === null ? "" : `${total} ${total === 1 ? "memory" : "memories"}`}</span>
      </header>

      {error !== null ? <p className="error-text usage-error">{error}</p> : null}

      {view === null ? (
        <p className="faint usage-loading">Loading…</p>
      ) : (
        <div className="usage-body">
          <p className="usage-note memory-intro">
            Memory forms on its own. When you tell HQ how you like things, or a Bot learns how one of your systems behaves, Jev judges whether it is worth
            keeping and it lands here with a note of where it came from. HQ and every Bot recall what is relevant on each turn. Pinned memories are recalled
            every time. Nothing here is a secret: passwords, codes and keys are refused.
          </p>

          {view.slots.map((slot) => {
            const shown = slot.entries.filter((entry) => matches(entry.text));
            const draft = drafts[slot.slot] ?? "";
            return (
              <section key={slot.slot} className="usage-section memory-slot">
                <h2>
                  {slot.label}
                  <small className="faint">
                    {" · "}
                    {slot.entries.length} of {slot.maxEntries}
                  </small>
                </h2>
                <p className="faint">{slot.detail}</p>
                {shown.length === 0 ? (
                  <p className="faint">{slot.entries.length === 0 ? "Nothing remembered yet." : "Nothing matches your search."}</p>
                ) : (
                  <ul className="memory-entries">
                    {[...shown]
                      .sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.at.localeCompare(left.at))
                      .map((entry) => (
                        <li key={entry.id} className={entry.pinned ? "pinned" : undefined}>
                          {editing?.id === entry.id ? (
                            <form
                              className="memory-edit"
                              onSubmit={async (event) => {
                                event.preventDefault();
                                const saved = await act(
                                  entry.id,
                                  () => api(`/bot/v1/memory/${slot.slot}/${encodeURIComponent(entry.id)}`, { method: "PATCH", body: JSON.stringify({ text: editing.text }) }),
                                  "Could not change that.",
                                );
                                if (saved) setEditing(null);
                              }}
                            >
                              <input
                                value={editing.text}
                                onChange={(event) => setEditing({ id: entry.id, text: event.target.value })}
                                maxLength={500}
                                aria-label="Edit memory"
                                autoFocus
                              />
                              <button type="submit" className="btn primary" disabled={busy !== null || editing.text.trim() === ""}>
                                Save
                              </button>
                              <button type="button" className="btn" onClick={() => setEditing(null)}>
                                Cancel
                              </button>
                            </form>
                          ) : (
                            <>
                              <div className="memory-text">
                                <span>
                                  {entry.pinned ? <Icon name="pin" size={11} className="memory-pin" /> : null}
                                  {entry.text}
                                </span>
                                <small className="faint">
                                  {entry.kind} · {provenance(entry)}
                                  {entry.recalls > 0 ? ` · recalled ${entry.recalls}×` : ""}
                                </small>
                              </div>
                              <div className="memory-actions">
                                <button
                                  type="button"
                                  className="icon-btn"
                                  aria-label={entry.pinned ? "Unpin" : "Pin, so it is recalled every turn"}
                                  title={entry.pinned ? "Unpin" : "Pin: recall this every turn"}
                                  disabled={busy !== null}
                                  onClick={() =>
                                    void act(
                                      entry.id,
                                      () => api(`/bot/v1/memory/${slot.slot}/${encodeURIComponent(entry.id)}`, { method: "PATCH", body: JSON.stringify({ pinned: !entry.pinned }) }),
                                      "Could not change that.",
                                    )
                                  }
                                >
                                  <Icon name="pin" size={14} />
                                </button>
                                <button type="button" className="icon-btn" aria-label="Edit" title="Edit" disabled={busy !== null} onClick={() => setEditing({ id: entry.id, text: entry.text })}>
                                  <Icon name="edit" size={14} />
                                </button>
                                <button
                                  type="button"
                                  className="icon-btn"
                                  aria-label="Forget"
                                  title="Forget"
                                  disabled={busy !== null}
                                  onClick={() =>
                                    void act(entry.id, () => api(`/bot/v1/memory/${slot.slot}/${encodeURIComponent(entry.id)}`, { method: "DELETE" }), "Could not forget that.")
                                  }
                                >
                                  <Icon name="x" size={14} />
                                </button>
                              </div>
                            </>
                          )}
                        </li>
                      ))}
                  </ul>
                )}
                <form
                  className="memory-add"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    const saved = await act(
                      slot.slot,
                      () => api(`/bot/v1/memory/${slot.slot}`, { method: "POST", body: JSON.stringify({ text: draft }) }),
                      "Could not save that.",
                    );
                    if (saved) setDrafts((current) => ({ ...current, [slot.slot]: "" }));
                  }}
                >
                  <input
                    value={draft}
                    onChange={(event) => setDrafts((current) => ({ ...current, [slot.slot]: event.target.value }))}
                    placeholder={PLACEHOLDER[slot.slot]}
                    maxLength={500}
                    aria-label={`Add to ${slot.label}`}
                  />
                  <button type="submit" className="btn" disabled={busy !== null || draft.trim() === ""}>
                    Remember
                  </button>
                </form>
              </section>
            );
          })}

          <section className="usage-section">
            <h2>Each Bot's playbook</h2>
            <p className="faint">Rules a Bot wrote for itself with `learn`, replayed into every brief it gets. Edit them in the Bot's settings.</p>
            {view.playbooks.length === 0 ? (
              <p className="faint">No Bots yet.</p>
            ) : (
              <div className="memory-playbooks">
                {view.playbooks.map((bot) => {
                  const shown = bot.playbook.filter(matches);
                  if (needle !== "" && shown.length === 0) return null;
                  return (
                    <div key={bot.botId} className="memory-playbook">
                      <b>
                        {bot.emoji} {bot.name}
                      </b>
                      {shown.length === 0 ? <span className="faint">Nothing learned yet.</span> : <ul>{shown.map((lesson) => <li key={lesson}>{lesson}</li>)}</ul>}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="usage-section">
            <h2>Recipes</h2>
            <p className="faint">Work that went well, saved as the brief that worked. HQ briefs a repeat request from it; ask HQ to save one after a job you liked.</p>
            {recipes.filter((recipe) => matches(`${recipe.name} ${recipe.when} ${recipe.brief}`)).length === 0 ? (
              <p className="faint">{recipes.length === 0 ? "No recipes yet." : "Nothing matches your search."}</p>
            ) : (
              <ul className="memory-entries">
                {recipes
                  .filter((recipe) => matches(`${recipe.name} ${recipe.when} ${recipe.brief}`))
                  .map((recipe) => (
                    <li key={recipe.id}>
                      <div className="memory-text">
                        <span>
                          <b>{recipe.name}</b> · {recipe.when}
                        </span>
                        <small className="faint">
                          {recipe.brief.slice(0, 160)}
                          {recipe.brief.length > 160 ? "…" : ""}
                          {recipe.uses > 0 ? ` · used ${recipe.uses}×` : ""}
                        </small>
                      </div>
                      <div className="memory-actions">
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={`Forget recipe ${recipe.name}`}
                          title="Forget this recipe"
                          disabled={busy !== null}
                          onClick={() => void act(`recipe:${recipe.id}`, () => api(`/bot/v1/recipes/${encodeURIComponent(recipe.id)}`, { method: "DELETE" }), "Could not forget that recipe.")}
                        >
                          <Icon name="x" size={14} />
                        </button>
                      </div>
                    </li>
                  ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
