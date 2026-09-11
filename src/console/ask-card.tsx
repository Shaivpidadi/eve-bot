"use client";

import type { InputOption, InputRequest, InputResolution } from "eve/client";

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
    <div className="field">
      <span className="k">{label}</span>
      <span className="v">{value}</span>
    </div>
  );
}

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
  const className = done ? "card done" : "card";

  const label = (option: InputOption) =>
    email ? (option.id === "approve" ? "Send email" : "Discard") : option.label;
  const buttonClass = (option: InputOption) =>
    option.style === "primary" || option.id === "approve"
      ? "btn primary"
      : option.style === "danger"
        ? "btn danger"
        : "btn";

  const foot = done ? (
    <div className="card-foot">
      <span className="answered">{resolvedText(request, resolution)}</span>
    </div>
  ) : (
    <div className="card-foot">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className={buttonClass(option)}
          disabled={answering}
          onClick={() => onAnswer(option.id)}
        >
          {label(option)}
        </button>
      ))}
      {options.length === 0 ? (
        <button
          type="button"
          className="btn primary"
          disabled={answering || note.trim() === ""}
          onClick={() => onAnswer(undefined)}
        >
          Send
        </button>
      ) : null}
    </div>
  );

  const noteBox =
    !done && (request.allowFreeform === true || options.length === 0) ? (
      <div className="card-note">
        <textarea
          rows={2}
          value={note}
          placeholder={signoff ? "Add a note for the Bot (optional)" : "Type an answer"}
          onChange={(event) => onNote(event.target.value)}
        />
      </div>
    ) : null;

  if (email) {
    const cc = asText(input.cc);
    return (
      <div className={className}>
        <div className="card-head">
          New email<span className="state">{done ? "Handled" : "Ready to send"}</span>
        </div>
        <Field label="From" value={user || "you"} />
        <Field label="To" value={asText(input.to)} />
        {cc === "" ? null : <Field label="Cc" value={cc} />}
        <Field label="Subject" value={asText(input.subject)} />
        <div className="card-body">{asText(input.body)}</div>
        {foot}
      </div>
    );
  }

  if (isTakeover(request)) {
    const url = asText(input.url);
    const skip = options.find((option) => option.id !== "approve")?.id ?? "deny";
    return (
      <div className={className}>
        <div className="card-head">
          Take over the browser<span className="state">{done ? "Handled" : "Needs you"}</span>
        </div>
        <div className="card-body">
          <span className="lead">{asText(input.reason)}</span>
          {url === "" ? "" : `${url}\n`}
          Open the computer, take control, do this step in the browser, then hand it back. What you type goes
          straight to the page, never into the chat.
        </div>
        {done ? (
          foot
        ) : (
          <div className="card-foot">
            <button type="button" className="btn primary" disabled={answering} onClick={onOpenComputer}>
              Open computer
            </button>
            <button type="button" className="btn" disabled={answering} onClick={() => onAnswer(skip)}>
              Skip
            </button>
          </div>
        )}
      </div>
    );
  }

  if (signoff) {
    const [lead = "", ...rest] = request.prompt.split("\n");
    return (
      <div className={className}>
        <div className="card-head">
          Sign-off<span className="state">{done ? "Handled" : "Ready for review"}</span>
        </div>
        <div className="card-body">
          <span className="lead">{lead}</span>
          {rest.join("\n").trim()}
        </div>
        {noteBox}
        {foot}
      </div>
    );
  }

  const title =
    request.kind === "tool-approval"
      ? `${humanTool(request.action?.toolName ?? "this")}?`
      : request.kind === "session-limit"
        ? "Limit reached"
        : "Question";

  return (
    <div className={className}>
      <div className="card-head">
        {title}
        <span className="state">{done ? "Handled" : "Needs you"}</span>
      </div>
      <div className="card-body">{request.prompt}</div>
      {request.kind === "tool-approval"
        ? Object.entries(input)
            .slice(0, 6)
            .map(([key, value]) => (
              <Field key={key} label={key} value={typeof value === "string" ? value : JSON.stringify(value)} />
            ))
        : null}
      {noteBox}
      {foot}
    </div>
  );
}
