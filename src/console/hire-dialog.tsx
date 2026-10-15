"use client";

import { ActivityIcon, ChevronLeftIcon, FlaskConicalIcon, HandshakeIcon, InboxIcon, type LucideIcon, PencilLineIcon, SearchIcon, ShuffleIcon, SparklesIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import type { ProposedBot } from "../../agent/lib/roster";
import { type BotTemplate, suggestName, TEMPLATES } from "../../agent/lib/templates";
import { api, errorMessage, SignedOutError } from "./api";

const ICONS: Readonly<Record<string, LucideIcon>> = {
  researcher: SearchIcon,
  inbox: InboxIcon,
  sales: HandshakeIcon,
  qa: FlaskConicalIcon,
  ops: ActivityIcon,
};

/**
 * A new Bot, in two steps: pick a starting point, then adjust it. A template
 * fills in the job and how it should work, and brings skills and an
 * introduction the server adds; "Start from scratch" leaves the form empty.
 */
export function HireDialog({
  open,
  taken,
  onClose,
  onHired,
}: {
  open: boolean;
  /** Names already on the team, so a suggested name is a free one. */
  taken: readonly string[];
  onClose: () => void;
  onHired: (botId: string) => Promise<void>;
}) {
  const [step, setStep] = useState<"pick" | "adjust" | "team">("pick");
  const [need, setNeed] = useState("");
  const [proposed, setProposed] = useState<readonly ProposedBot[]>([]);
  const [keep, setKeep] = useState<ReadonlySet<number>>(new Set());
  const [template, setTemplate] = useState<BotTemplate | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [persona, setPersona] = useState("");
  const [skip, setSkip] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStep("pick");
    setTemplate(null);
    setProposed([]);
    setError(null);
  }, [open]);

  const pick = (chosen: BotTemplate | null) => {
    setTemplate(chosen);
    setSkip(0);
    setName(chosen === null ? "" : suggestName(chosen, taken));
    setRole(chosen?.role ?? "");
    setPersona(chosen?.persona ?? "");
    setError(null);
    setStep("adjust");
  };
  const clash = taken.some((other) => other.toLowerCase() === name.trim().toLowerCase());

  const propose = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await api("/bot/v1/bots/propose", { method: "POST", body: JSON.stringify({ need: need.trim() }) });
      if (!response.ok) {
        setError(await errorMessage(response, "Could not propose a team."));
        return;
      }
      const { bots } = (await response.json()) as { bots: ProposedBot[] };
      setProposed(bots);
      setKeep(new Set(bots.map((_, index) => index)));
      setStep("team");
    } catch (caught) {
      if (!(caught instanceof SignedOutError)) setError("Could not propose a team.");
    } finally {
      setBusy(false);
    }
  };

  const hireTeam = async () => {
    setBusy(true);
    setError(null);
    try {
      const bots = proposed.filter((_, index) => keep.has(index)).map((bot) => ({ ...bot, ...(bot.template === "none" ? {} : { template: bot.template }) }));
      const response = await api("/bot/v1/bots/batch", { method: "POST", body: JSON.stringify({ bots }) });
      const result = (await response.json().catch(() => null)) as { hired?: { id: string }[]; skipped?: { name: string; error: string }[] } | null;
      const first = result?.hired?.[0];
      if (first === undefined) {
        setError(result?.skipped?.[0]?.error ?? "Could not hire the team.");
        return;
      }
      onClose();
      await onHired(first.id);
    } catch (caught) {
      if (!(caught instanceof SignedOutError)) setError("Could not hire the team.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-[460px]">
        {step === "pick" ? (
          <div className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>New Bot</DialogTitle>
              <DialogDescription>Describe what you need and get a team, or pick one starting point.</DialogDescription>
            </DialogHeader>
            <form
              className="flex flex-col gap-2 rounded-xl border border-border bg-muted/40 p-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (need.trim().length >= 10) void propose();
              }}
            >
              <label htmlFor="hire-need" className="flex items-center gap-1.5 text-[13px] font-semibold">
                <SparklesIcon className="size-4 text-muted-foreground" />
                Describe your team
              </label>
              <Textarea
                id="hire-need"
                value={need}
                onChange={(event) => setNeed(event.target.value)}
                rows={2}
                maxLength={2000}
                placeholder="I run a small online shop. I lose track of customer emails and want to know what competitors charge."
                className="bg-card"
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && need.trim().length >= 10) void propose();
                }}
              />
              {error === null ? null : <FieldError>{error}</FieldError>}
              <Button type="submit" size="sm" className="self-end" disabled={busy || need.trim().length < 10}>
                {busy ? "Thinking\u2026" : "Propose a team"}
              </Button>
            </form>
            <div className="grid grid-cols-2 gap-2 max-[420px]:grid-cols-1">
              {TEMPLATES.map((entry) => {
                const Icon = ICONS[entry.id] ?? SearchIcon;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    className="flex flex-col items-start gap-1 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-foreground/25 hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"
                    onClick={() => pick(entry)}
                  >
                    <Icon className="size-4 text-muted-foreground" />
                    <span className="text-[13px] font-semibold">{entry.title}</span>
                    <span className="text-[12px] leading-snug text-muted-foreground">{entry.blurb}</span>
                  </button>
                );
              })}
              <button
                type="button"
                className="flex flex-col items-start gap-1 rounded-xl border border-dashed border-border p-3 text-left transition-colors hover:border-foreground/25 hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"
                onClick={() => pick(null)}
              >
                <PencilLineIcon className="size-4 text-muted-foreground" />
                <span className="text-[13px] font-semibold">Start from scratch</span>
                <span className="text-[12px] leading-snug text-muted-foreground">Write its job and how it works yourself.</span>
              </button>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
            </DialogFooter>
          </div>
        ) : step === "team" ? (
          <div className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Your proposed team</DialogTitle>
              <DialogDescription>Keep the ones you want. Each can be edited from its thread later.</DialogDescription>
            </DialogHeader>
            <div className="flex max-h-[52vh] flex-col gap-2 overflow-y-auto">
              {proposed.map((bot, index) => (
                <label key={bot.name} className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-card p-3 has-[[data-checked]]:border-foreground/25">
                  <Checkbox
                    className="mt-0.5"
                    checked={keep.has(index)}
                    onCheckedChange={(checked) =>
                      setKeep((current) => {
                        const next = new Set(current);
                        if (checked) next.add(index);
                        else next.delete(index);
                        return next;
                      })
                    }
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-[13px] font-semibold">
                      {bot.name} <span className="font-normal text-muted-foreground">· {bot.role}</span>
                    </span>
                    <span className="text-[12px] leading-snug text-muted-foreground">{bot.why}</span>
                  </span>
                </label>
              ))}
            </div>
            {error === null ? null : <FieldError>{error}</FieldError>}
            <DialogFooter className="sm:justify-between">
              <Button type="button" variant="ghost" onClick={() => setStep("pick")}>
                <ChevronLeftIcon />
                Back
              </Button>
              <Button type="button" disabled={busy || keep.size === 0} onClick={() => void hireTeam()}>
                {keep.size === 1 ? "Hire 1 Bot" : `Hire ${keep.size} Bots`}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={async (event) => {
              event.preventDefault();
              if (clash) return;
              setBusy(true);
              setError(null);
              try {
                const response = await api("/bot/v1/bots", {
                  method: "POST",
                  body: JSON.stringify({ name: name.trim(), role: role.trim(), persona: persona.trim(), ...(template === null ? {} : { template: template.id }) }),
                });
                if (!response.ok) {
                  setError(await errorMessage(response, "Could not create the Bot."));
                  return;
                }
                const created = (await response.json()) as { bot: { id: string } };
                onClose();
                await onHired(created.bot.id);
              } catch (caught) {
                if (!(caught instanceof SignedOutError)) setError("Could not create the Bot.");
              } finally {
                setBusy(false);
              }
            }}
          >
            <DialogHeader>
              <DialogTitle>{template === null ? "New Bot" : `New ${template.title.toLowerCase()}`}</DialogTitle>
              <DialogDescription>
                {template === null ? "Give it a name, a job, and a short description of how it should work." : "Adjust anything you like; it works the way this says."}
              </DialogDescription>
            </DialogHeader>
            <FieldGroup className="gap-3">
              <Field>
                <FieldLabel htmlFor="hire-name">Name</FieldLabel>
                <div className="flex gap-1.5">
                  <Input id="hire-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={40} required placeholder="Ava" aria-invalid={clash} autoFocus />
                  {template === null ? null : (
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label="Suggest another name"
                      title="Suggest another name"
                      onClick={() => {
                        const next = skip + 1;
                        setSkip(next);
                        setName(suggestName(template, taken, next));
                      }}
                    >
                      <ShuffleIcon />
                    </Button>
                  )}
                </div>
                {clash ? <FieldError>{name.trim()} is already on the team.</FieldError> : null}
              </Field>
              <Field>
                <FieldLabel htmlFor="hire-role">Job</FieldLabel>
                <Input id="hire-role" value={role} onChange={(event) => setRole(event.target.value)} maxLength={120} required placeholder="Handles inbound sales follow-up" />
              </Field>
              <Field>
                <FieldLabel htmlFor="hire-persona">How it should work</FieldLabel>
                <Textarea
                  id="hire-persona"
                  value={persona}
                  onChange={(event) => setPersona(event.target.value)}
                  rows={6}
                  minLength={20}
                  maxLength={4000}
                  required
                  placeholder="Warm and brief. Never promises a discount. Drafts come to me before anything is sent."
                  onKeyDown={(event) => {
                    // ⌘/Ctrl+Enter hires from the long field, where Enter is a new line.
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit();
                  }}
                />
                {persona.trim().length > 0 && persona.trim().length < 20 ? (
                  <p className="m-0 text-[11.5px] text-muted-foreground">{20 - persona.trim().length} more characters: say how it should sound and what it must never do.</p>
                ) : null}
              </Field>
              {error === null ? null : <FieldError>{error}</FieldError>}
            </FieldGroup>
            <DialogFooter className="sm:justify-between">
              <Button type="button" variant="ghost" onClick={() => setStep("pick")}>
                <ChevronLeftIcon />
                Back
              </Button>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={onClose}>
                  Cancel
                </Button>
                <Button type="submit" disabled={busy || clash}>
                  Create Bot
                </Button>
              </div>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
