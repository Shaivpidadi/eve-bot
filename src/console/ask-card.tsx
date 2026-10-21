"use client";

import type { InputOption, InputRequest, InputResolution } from "eve/client";

import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { api, errorMessage, isRecord, SignedOutError } from "./api";
import { humanTool } from "./room-store";

const APPROVAL_OPTIONS: readonly InputOption[] = [
  { id: "approve", label: "Approve", style: "primary" },
  { id: "deny", label: "Deny" },
];

const optionsFor = (request: InputRequest): readonly InputOption[] =>
  request.options !== undefined && request.options.length > 0
    ? request.options
    : request.kind === "tool-approval"
      ? APPROVAL_OPTIONS
      : [];

const isEmail = (request: InputRequest): boolean =>
  request.kind === "tool-approval" && /(^|__)send_email$/.test(request.action?.toolName ?? "");

/** A Bot asking a person to use its browser for a step only they can do. */
const isTakeover = (request: InputRequest): boolean =>
  request.kind === "tool-approval" && /(^|__)request_takeover$/.test(request.action?.toolName ?? "");

/** `run_job` asks for sign-off with a question whose prompt names it. */
const isSignoff = (request: InputRequest): boolean =>
  request.kind === "question" && /needs your sign-off\./.test(request.prompt);

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string").join(", ");
  return "";
}

function resolvedText(request: InputRequest, resolution: InputResolution): string {
  const email = isEmail(request);
  const takeover = isTakeover(request);
  switch (resolution.outcome) {
    case "approved":
      return email ? "Approved to send" : takeover ? "Handed back" : "Approved";
    case "denied":
      return email ? "Discarded" : takeover ? "Skipped" : "Denied";
    case "ignored":
      return "No longer needed";
    default:
      break;
  }
  const chosen = optionsFor(request).find((option) => option.id === resolution.response?.optionId);
  if (chosen !== undefined) return `You chose ${chosen.label}`;
  const typed = resolution.response?.text;
  return typed ? `You answered: ${typed}` : "Answered";
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2.5 border-t border-border px-3 py-1.5 text-xs">
      <span className="w-[52px] flex-none text-faint">{label}</span>
      <span className="min-w-0 wrap-anywhere text-muted-foreground">{value}</span>
    </div>
  );
}

/** The card's top line: what it is, and whether it still needs you (an amber dot) or was handled. */
function Head({ title, state, done }: { title: string; state: string; done: boolean }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-[12.5px] font-medium">
      {title}
      <span
        className={cn(
          "ml-auto flex items-center gap-1.5 text-[11.5px] font-normal text-muted-foreground before:size-1.5 before:rounded-full before:content-['']",
          done ? "before:bg-faint" : "before:bg-warning",
        )}
      >
        {state}
      </span>
    </div>
  );
}

const BODY = "max-h-[280px] overflow-y-auto border-t border-border px-3 py-2.5 text-[12.5px] whitespace-pre-wrap wrap-anywhere";
const LEAD = "block font-medium";
const FOOT = "flex flex-wrap gap-1.5 px-3 py-2.5";

/**
 * Something a Bot needs from you, shaped like the thing it is: an email ready to
 * send, a deliverable waiting for sign-off, or a plain question.
 */
export function AskCard({
  request,
  resolution,
  answering,
  note,
  user,
  onNote,
  onAnswer,
  onOpenComputer,
}: {
  request: InputRequest;
  resolution: InputResolution | undefined;
  answering: boolean;
  note: string;
  user: string;
  onNote: (value: string) => void;
  onAnswer: (optionId: string | undefined) => void;
  onOpenComputer: () => void;
}) {
  const done = resolution !== undefined;
  const options = optionsFor(request);
  const email = isEmail(request);
  const signoff = isSignoff(request);
  const input = request.action?.input ?? {};
  const className = "my-2 w-full max-w-[440px] gap-0 self-start py-0 text-[12.5px]";

  const label = (option: InputOption) =>
    email ? (option.id === "approve" ? "Send email" : "Discard") : option.label;
  const variantOf = (option: InputOption) =>
    option.style === "primary" || option.id === "approve" ? "default" : option.style === "danger" ? "destructive" : "secondary";

  const foot = done ? (
    <div className={FOOT}>
      <span className="text-xs text-muted-foreground">{resolvedText(request, resolution)}</span>
    </div>
  ) : (
    <div className={FOOT}>
      {options.map((option) => (
        <Button key={option.id} size="sm" variant={variantOf(option)} disabled={answering} onClick={() => onAnswer(option.id)}>
          {label(option)}
        </Button>
      ))}
      {options.length === 0 ? (
        <Button size="sm" disabled={answering || note.trim() === ""} onClick={() => onAnswer(undefined)}>
          Send
        </Button>
      ) : null}
    </div>
  );

  const noteBox =
    !done && (request.allowFreeform === true || options.length === 0) ? (
      <div className="border-t border-border px-3 pt-2">
        <Textarea
          rows={2}
          value={note}
          className="min-h-9 resize-y text-[12.5px]"
          placeholder={signoff ? "Add a note for the Bot (optional)" : "Type an answer"}
          onChange={(event) => onNote(event.target.value)}
        />
      </div>
    ) : null;

  if (email) {
    const cc = asText(input.cc);
    return (
      <Card className={className}>
        <Head title="New email" state={done ? "Handled" : "Ready to send"} done={done} />
        <Field label="From" value={user || "you"} />
        <Field label="To" value={asText(input.to)} />
        {cc === "" ? null : <Field label="Cc" value={cc} />}
        <Field label="Subject" value={asText(input.subject)} />
        <div className={BODY}>{asText(input.body)}</div>
        {foot}
      </Card>
    );
  }

  if (isTakeover(request)) {
    const url = asText(input.url);
    const skip = options.find((option) => option.id !== "approve")?.id ?? "deny";
    return (
      <Card className={className}>
        <Head title="Take over the browser" state={done ? "Handled" : "Needs you"} done={done} />
        <div className={BODY}>
          <span className={LEAD}>{asText(input.reason)}</span>
          {url === "" ? "" : `${url}\n`}
          Open the computer, take control, do this step in the browser, then hand it back. What you type goes
          straight to the page, never into the chat.
        </div>
        {done ? (
          foot
        ) : (
          <div className={FOOT}>
            <Button size="sm" disabled={answering} onClick={onOpenComputer}>
              Open computer
            </Button>
            <Button size="sm" variant="secondary" disabled={answering} onClick={() => onAnswer(skip)}>
              Skip
            </Button>
          </div>
        )}
      </Card>
    );
  }

  if (signoff) {
    const [lead = "", ...rest] = request.prompt.split("\n");
    return (
      <Card className={className}>
        <Head title="Sign-off" state={done ? "Handled" : "Ready for review"} done={done} />
        <div className={BODY}>
          <span className={LEAD}>{lead}</span>
          {rest.join("\n").trim()}
        </div>
        {noteBox}
        {foot}
      </Card>
    );
  }

  const title =
    request.kind === "tool-approval"
      ? `${humanTool(request.action?.toolName ?? "this")}?`
      : request.kind === "session-limit"
        ? "Limit reached"
        : "Question";

  return (
    <Card className={className}>
      <Head title={title} state={done ? "Handled" : "Needs you"} done={done} />
      <div className={BODY}>{request.prompt}</div>
      {request.kind === "tool-approval"
        ? Object.entries(input)
            .slice(0, 6)
            .map(([key, value]) => (
              <Field key={key} label={key} value={typeof value === "string" ? value : JSON.stringify(value)} />
            ))
        : null}
      {noteBox}
      {foot}
    </Card>
  );
}

interface Proposal {
  readonly actionId: string;
  readonly email: { readonly to: readonly string[]; readonly cc: readonly string[]; readonly subject: string; readonly text: string };
  readonly decided: { readonly outcome: "approved" | "denied"; readonly by: string; readonly status: string } | null;
}

/**
 * An email a Claude Code or Codex Bot asked to send (agent/lib/engines/proposals.ts).
 * Such a Bot has no eve approval card, so this one reads its proposal and answers
 * it: eve-bot sends it exactly as shown when the person says so, once.
 */
export function ProposalCard({ actionId }: { actionId: string }) {
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await api(`/bot/v1/proposals/${encodeURIComponent(actionId)}`);
      const body: unknown = await response.json().catch(() => null);
      if (response.ok && isRecord(body) && isRecord(body.proposal)) setProposal(body.proposal as unknown as Proposal);
    } catch (caught) {
      if (!(caught instanceof SignedOutError)) setError("Could not load this request.");
    }
  }, [actionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const response = await api(`/bot/v1/proposals/${encodeURIComponent(actionId)}`, { method: "POST", body: JSON.stringify({ approve }) });
      if (!response.ok) setError(await errorMessage(response, "Could not answer this request."));
      await load();
    } catch (caught) {
      if (!(caught instanceof SignedOutError)) setError("Could not answer this request.");
    } finally {
      setBusy(false);
    }
  };

  if (proposal === null) return error === null ? null : <p className="m-0 my-2 text-xs text-destructive">{error}</p>;
  const { email, decided } = proposal;
  const sent = decided?.outcome === "approved" && decided.status === "sent";
  const state = decided === null ? "Needs you" : decided.outcome === "denied" ? "Discarded" : sent ? "Sent" : "Not sent";
  return (
    <Card className="my-2 w-full max-w-[440px] gap-0 self-start py-0 text-[12.5px]">
      <Head title="Email ready to send" state={state} done={decided !== null} />
      <Field label="To" value={email.to.join(", ")} />
      {email.cc.length > 0 ? <Field label="Cc" value={email.cc.join(", ")} /> : null}
      <Field label="Subject" value={email.subject} />
      <div className={BODY}>{email.text}</div>
      <div className={FOOT}>
        {decided === null ? (
          <>
            <Button size="sm" disabled={busy} onClick={() => void decide(true)}>
              Send email
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void decide(false)}>
              Discard
            </Button>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">
            {decided.outcome === "denied" ? `Discarded by ${decided.by}` : sent ? `Sent, approved by ${decided.by}` : `Approved by ${decided.by}, but not sent (${decided.status})`}
          </span>
        )}
        {error === null ? null : <span className="basis-full text-xs text-destructive">{error}</span>}
      </div>
    </Card>
  );
}
