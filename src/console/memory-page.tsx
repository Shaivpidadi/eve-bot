"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { ChevronRightIcon, PencilIcon, PinIcon, SearchIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { cn } from "@/lib/utils";

import { api, errorMessage, isRecord, SignedOutError } from "./api";
import { Faint, PageBody, PageError, PageFrame, PageLoading, PageNote, PageSection } from "./usage-page";

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
  readonly history?: readonly { readonly text: string; readonly at: string; readonly source: Entry["source"] }[];
  readonly retired?: { readonly at: string; readonly source: Entry["source"]; readonly reason: string } | null;
  readonly confidence?: number;
  readonly lastConfirmedAt?: string | null;
}

const FADE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_CONFIDENCE: Readonly<Record<Entry["source"]["who"], number>> = { you: 1, hq: 0.85, bot: 0.8, auto: 0.7, import: 0.75 };
const confidenceOf = (entry: Entry) => entry.confidence ?? DEFAULT_CONFIDENCE[entry.source.who];
/** Not needed for ninety days: kept, but not recalled until brought back. */
const isFaded = (entry: Entry) => {
  if (entry.pinned || entry.retired) return false;
  const last = Date.parse(entry.lastRecalledAt ?? entry.lastConfirmedAt ?? entry.at);
  return Number.isFinite(last) && Date.now() - last > FADE_AFTER_MS;
};
const sureness = (entry: Entry) => {
  const value = confidenceOf(entry);
  return value >= 0.9 ? "sure" : value >= 0.7 ? "fairly sure" : "unsure";
};

interface FieldDefinition {
  readonly key: string;
  readonly label: string;
  readonly hint: string;
}

interface FieldValue {
  readonly value: string;
  readonly at: string;
  readonly source: Entry["source"];
  readonly history?: readonly { readonly value: string; readonly at: string; readonly source: Entry["source"] }[];
}

interface SlotView {
  readonly slot: Slot;
  readonly label: string;
  readonly detail: string;
  readonly maxEntries: number;
  readonly entries: readonly Entry[];
  readonly fieldDefinitions?: readonly FieldDefinition[];
  readonly fields?: Readonly<Record<string, FieldValue>>;
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
  const [editingField, setEditingField] = useState<{ slot: Slot; key: string; value: string } | null>(null);

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
      if (event.key === "Escape" && editing === null && editingField === null) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, editing, editingField]);

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
  const total = useMemo(() => view?.slots.reduce((sum, slot) => sum + slot.entries.filter((entry) => !entry.retired).length + Object.keys(slot.fields ?? {}).length, 0) ?? 0, [view]);

  return (
    <PageFrame
      title="Memory"
      label="Memory"
      onBack={onClose}
      actions={
        <>
          <InputGroup className="mx-2 h-8 max-w-[420px] flex-1 rounded-full border-0 bg-secondary dark:bg-secondary">
            <InputGroupAddon>
              <SearchIcon className="text-faint" />
            </InputGroupAddon>
            <InputGroupInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search everything remembered" aria-label="Search memory" />
          </InputGroup>
          <span className="ml-auto hidden shrink-0 text-[11.5px] text-faint sm:inline">{view === null ? "" : `${total} ${total === 1 ? "memory" : "memories"}`}</span>
        </>
      }
    >
      {error !== null ? <PageError>{error}</PageError> : null}

      {view === null ? (
        <PageLoading />
      ) : (
        <PageBody>
          <PageNote>
            Memory forms on its own. When you tell HQ how you like things, or a Bot learns how one of your systems behaves, Jev judges whether it is worth
            keeping and it lands here with a note of where it came from. When a preference moves on, the memory is reworded and keeps its old wording; when
            something stops being true, it is retired, not lost. Each memory carries how sure the team is of it, which rises when you say it again. HQ and every Bot
            recall what is relevant on each turn; what nobody has needed for ninety days fades out of recall but stays here. Pinned memories are recalled every time.
            Nothing here is a secret: passwords, codes and keys are refused.
          </PageNote>

          {view.slots.map((slot) => {
            const shown = slot.entries.filter((entry) => !entry.retired && !isFaded(entry) && matches(entry.text));
            const faded = slot.entries.filter((entry) => !entry.retired && isFaded(entry) && matches(entry.text));
            const gone = slot.entries.filter((entry) => entry.retired && matches(entry.text));
            const draft = drafts[slot.slot] ?? "";
            return (
              <PageSection
                key={slot.slot}
                title={
                  <>
                    {slot.label}
                    <small className="font-normal text-faint">
                      {" · "}
                      {slot.entries.filter((entry) => !entry.retired).length} of {slot.maxEntries}
                    </small>
                  </>
                }
              >
                <Faint>{slot.detail}</Faint>
                {(slot.fieldDefinitions ?? []).length === 0 ? null : (
                  <dl className="m-0 grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] overflow-hidden rounded-xl border border-input bg-card">
                    {(slot.fieldDefinitions ?? [])
                      .filter((field) => needle === "" || matches(field.label) || matches(slot.fields?.[field.key]?.value ?? ""))
                      .map((field) => {
                        const current = slot.fields?.[field.key];
                        const isEditing = editingField?.slot === slot.slot && editingField.key === field.key;
                        return (
                          <div key={field.key} className="flex min-w-0 flex-col gap-0.5 px-3 py-[9px] shadow-[inset_-1px_-1px_0_var(--border)]">
                            <dt className="text-[11px] text-faint" title={field.hint}>
                              {field.label}
                            </dt>
                            {isEditing ? (
                              <form
                                className="flex flex-1 gap-2"
                                onSubmit={async (event) => {
                                  event.preventDefault();
                                  const saved = await act(
                                    `${slot.slot}:${field.key}`,
                                    () => api(`/bot/v1/memory/${slot.slot}/fields`, { method: "POST", body: JSON.stringify({ field: field.key, value: editingField.value }) }),
                                    "Could not change that.",
                                  );
                                  if (saved) setEditingField(null);
                                }}
                              >
                                <Input
                                  className="h-7 min-w-0 flex-1 text-[12.5px]"
                                  value={editingField.value}
                                  onChange={(event) => setEditingField({ slot: slot.slot, key: field.key, value: event.target.value })}
                                  placeholder={field.hint}
                                  maxLength={200}
                                  aria-label={field.label}
                                  autoFocus
                                />
                                <Button type="submit" size="xs" disabled={busy !== null}>
                                  Save
                                </Button>
                                <Button type="button" size="xs" variant="secondary" onClick={() => setEditingField(null)}>
                                  Cancel
                                </Button>
                              </form>
                            ) : (
                              <dd className="m-0 min-w-0">
                                <button
                                  type="button"
                                  className={cn(
                                    "-mx-1 -my-0.5 max-w-full cursor-pointer truncate rounded-md px-1 py-0.5 text-left text-[13px] hover:bg-accent",
                                    current === undefined ? "text-faint" : "text-foreground",
                                  )}
                                  title={
                                    current === undefined
                                      ? `Not known yet. ${field.hint}.`
                                      : `${provenance({ ...current, text: current.value, kind: "fact", id: field.key, pinned: false, recalls: 0, lastRecalledAt: null } as Entry)}${
                                          current.history && current.history.length > 0 ? `\nWas: ${current.history.map((rev) => rev.value).join(", ")}` : ""
                                        }`
                                  }
                                  onClick={() => setEditingField({ slot: slot.slot, key: field.key, value: current?.value ?? "" })}
                                >
                                  {current?.value ?? "—"}
                                </button>
                              </dd>
                            )}
                          </div>
                        );
                      })}
                  </dl>
                )}
                {shown.length === 0 ? (
                  <Faint>{slot.entries.filter((entry) => !entry.retired).length === 0 ? ((slot.fieldDefinitions ?? []).length > 0 ? "No notes yet beyond the fields above." : "Nothing remembered yet.") : "Nothing matches your search."}</Faint>
                ) : (
                  <Entries>
                    {[...shown]
                      .sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.at.localeCompare(left.at))
                      .map((entry) => (
                        <EntryRow key={entry.id} className={entry.pinned ? "bg-[color-mix(in_srgb,var(--brand)_6%,var(--card))]" : undefined}>
                          {editing?.id === entry.id ? (
                            <form
                              className="flex flex-1 gap-2"
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
                              <Input
                                className="min-w-0 flex-1"
                                value={editing.text}
                                onChange={(event) => setEditing({ id: entry.id, text: event.target.value })}
                                maxLength={500}
                                aria-label="Edit memory"
                                autoFocus
                              />
                              <Button type="submit" size="sm" disabled={busy !== null || editing.text.trim() === ""}>
                                Save
                              </Button>
                              <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(null)}>
                                Cancel
                              </Button>
                            </form>
                          ) : (
                            <>
                              <EntryText>
                                <span>
                                  {entry.pinned ? <PinIcon className="mr-1.5 inline size-[11px] -translate-y-px text-brand" /> : null}
                                  {entry.text}
                                </span>
                                <small className="text-[11.5px] text-faint" title={`Confidence ${Math.round(confidenceOf(entry) * 100)}%${entry.lastConfirmedAt ? `, last confirmed ${when(entry.lastConfirmedAt)}` : ""}`}>
                                  {entry.kind} · {provenance(entry)}
                                  {entry.recalls > 0 ? ` · recalled ${entry.recalls}×` : ""}
                                  {` · ${sureness(entry)}`}
                                </small>
                                {entry.history && entry.history.length > 0 ? (
                                  <small className="text-[11.5px] text-faint italic" title={entry.history.map((rev) => `${when(rev.at)}: ${rev.text}`).join("\n")}>
                                    Replaced “{entry.history[0]!.text}”{entry.history.length > 1 ? ` and ${entry.history.length - 1} earlier` : ""}
                                  </small>
                                ) : null}
                              </EntryText>
                              <EntryActions>
                                <IconAction
                                  label={entry.pinned ? "Unpin" : "Pin, so it is recalled every turn"}
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
                                  <PinIcon />
                                </IconAction>
                                <IconAction label="Edit" disabled={busy !== null} onClick={() => setEditing({ id: entry.id, text: entry.text })}>
                                  <PencilIcon />
                                </IconAction>
                                <IconAction
                                  label="Forget"
                                  disabled={busy !== null}
                                  onClick={() => void act(entry.id, () => api(`/bot/v1/memory/${slot.slot}/${encodeURIComponent(entry.id)}`, { method: "DELETE" }), "Could not forget that.")}
                                >
                                  <XIcon />
                                </IconAction>
                              </EntryActions>
                            </>
                          )}
                        </EntryRow>
                      ))}
                  </Entries>
                )}
                <form
                  className="flex gap-2"
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
                  <Input
                    className="min-w-0 flex-1 bg-secondary dark:bg-secondary"
                    value={draft}
                    onChange={(event) => setDrafts((current) => ({ ...current, [slot.slot]: event.target.value }))}
                    placeholder={PLACEHOLDER[slot.slot]}
                    maxLength={500}
                    aria-label={`Add to ${slot.label}`}
                  />
                  <Button type="submit" variant="secondary" disabled={busy !== null || draft.trim() === ""}>
                    Remember
                  </Button>
                </form>
                {faded.length === 0 ? null : (
                  <Folded summary={`${faded.length} not needed for 90 days`}>
                    <Entries>
                      {faded.map((entry) => (
                        <EntryRow key={entry.id}>
                          <EntryText>
                            <span className="text-muted-foreground">{entry.text}</span>
                            <small className="text-[11.5px] text-faint">
                              {entry.kind} · {provenance(entry)} · left out of recall until brought back
                            </small>
                          </EntryText>
                          <EntryActions>
                            <Button
                              size="xs"
                              variant="secondary"
                              disabled={busy !== null}
                              onClick={() =>
                                void act(entry.id, () => api(`/bot/v1/memory/${slot.slot}/${encodeURIComponent(entry.id)}`, { method: "PATCH", body: JSON.stringify({ revive: true }) }), "Could not bring that back.")
                              }
                            >
                              Bring back
                            </Button>
                            <IconAction
                              label="Forget"
                              disabled={busy !== null}
                              onClick={() => void act(entry.id, () => api(`/bot/v1/memory/${slot.slot}/${encodeURIComponent(entry.id)}`, { method: "DELETE" }), "Could not forget that.")}
                            >
                              <XIcon />
                            </IconAction>
                          </EntryActions>
                        </EntryRow>
                      ))}
                    </Entries>
                  </Folded>
                )}
                {gone.length === 0 ? null : (
                  <Folded summary={`${gone.length} no longer true`}>
                    <Entries>
                      {gone.map((entry) => (
                        <EntryRow key={entry.id}>
                          <EntryText>
                            <span className="text-muted-foreground line-through">{entry.text}</span>
                            <small className="text-[11.5px] text-faint">
                              Retired {when(entry.retired!.at)} · {entry.retired!.reason}
                            </small>
                          </EntryText>
                          <EntryActions>
                            <Button
                              size="xs"
                              variant="secondary"
                              disabled={busy !== null}
                              onClick={() =>
                                void act(entry.id, () => api(`/bot/v1/memory/${slot.slot}/${encodeURIComponent(entry.id)}`, { method: "PATCH", body: JSON.stringify({ restore: true }) }), "Could not bring that back.")
                              }
                            >
                              Still true
                            </Button>
                            <IconAction
                              label="Forget for good"
                              disabled={busy !== null}
                              onClick={() => void act(entry.id, () => api(`/bot/v1/memory/${slot.slot}/${encodeURIComponent(entry.id)}`, { method: "DELETE" }), "Could not forget that.")}
                            >
                              <XIcon />
                            </IconAction>
                          </EntryActions>
                        </EntryRow>
                      ))}
                    </Entries>
                  </Folded>
                )}
              </PageSection>
            );
          })}

          <PageSection title="Each Bot's playbook">
            <Faint>Rules a Bot wrote for itself with `learn`, replayed into every brief it gets. Edit them in the Bot's settings.</Faint>
            {view.playbooks.length === 0 ? (
              <Faint>No Bots yet.</Faint>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2.5">
                {view.playbooks.map((bot) => {
                  const shown = bot.playbook.filter(matches);
                  if (needle !== "" && shown.length === 0) return null;
                  return (
                    <div key={bot.botId} className="flex flex-col gap-1.5 rounded-xl border border-input bg-card px-3 py-2.5 text-[13px]">
                      <b className="font-semibold">
                        {bot.emoji} {bot.name}
                      </b>
                      {shown.length === 0 ? (
                        <span className="text-[11.5px] text-faint">Nothing learned yet.</span>
                      ) : (
                        <ul className="m-0 list-disc pl-[18px] text-muted-foreground">
                          {shown.map((lesson) => (
                            <li key={lesson} className="my-0.5">
                              {lesson}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </PageSection>

          <PageSection title="Recipes">
            <Faint>Work that went well, saved as the brief that worked. HQ briefs a repeat request from it; ask HQ to save one after a job you liked.</Faint>
            {recipes.filter((recipe) => matches(`${recipe.name} ${recipe.when} ${recipe.brief}`)).length === 0 ? (
              <Faint>{recipes.length === 0 ? "No recipes yet." : "Nothing matches your search."}</Faint>
            ) : (
              <Entries>
                {recipes
                  .filter((recipe) => matches(`${recipe.name} ${recipe.when} ${recipe.brief}`))
                  .map((recipe) => (
                    <EntryRow key={recipe.id}>
                      <EntryText>
                        <span>
                          <b className="font-semibold">{recipe.name}</b> · {recipe.when}
                        </span>
                        <small className="text-[11.5px] text-faint">
                          {recipe.brief.slice(0, 160)}
                          {recipe.brief.length > 160 ? "…" : ""}
                          {recipe.uses > 0 ? ` · used ${recipe.uses}×` : ""}
                        </small>
                      </EntryText>
                      <EntryActions>
                        <IconAction
                          label={`Forget recipe ${recipe.name}`}
                          title="Forget this recipe"
                          disabled={busy !== null}
                          onClick={() => void act(`recipe:${recipe.id}`, () => api(`/bot/v1/recipes/${encodeURIComponent(recipe.id)}`, { method: "DELETE" }), "Could not forget that recipe.")}
                        >
                          <XIcon />
                        </IconAction>
                      </EntryActions>
                    </EntryRow>
                  ))}
              </Entries>
            )}
          </PageSection>
        </PageBody>
      )}
    </PageFrame>
  );
}

/** A boxed list of memories, one row each. */
function Entries({ children }: { children: ReactNode }) {
  return <ul className="m-0 list-none divide-y divide-border overflow-hidden rounded-xl border border-input bg-card p-0">{children}</ul>;
}

function EntryRow({ className, children }: { className?: string; children: ReactNode }) {
  return <li className={cn("group/entry flex items-start gap-2.5 px-3 py-2.5", className)}>{children}</li>;
}

function EntryText({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-[13px] leading-snug [overflow-wrap:anywhere]">{children}</div>;
}

/** A row's buttons: quiet until the row is pointed at or focused. */
function EntryActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-none items-center gap-0.5 opacity-55 transition-opacity group-focus-within/entry:opacity-100 group-hover/entry:opacity-100">{children}</div>;
}

function IconAction({ label, title, disabled, onClick, children }: { label: string; title?: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" aria-label={label} title={title ?? label} disabled={disabled} onClick={onClick}>
      {children}
    </Button>
  );
}

/** Memories kept out of the main list, folded until asked for. */
function Folded({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <Collapsible className="mt-1 flex flex-col gap-1.5">
      <CollapsibleTrigger className="group/fold flex w-fit cursor-pointer items-center gap-1 py-1 text-[11.5px] text-faint hover:text-muted-foreground">
        <ChevronRightIcon className="size-3.5 transition-transform group-aria-expanded/fold:rotate-90" />
        {summary}
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}
