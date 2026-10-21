import type { InputRequest, InputResolution, MessageStreamEvent } from "eve/client";

import { api, errorMessage, isRecord, redirectToLogin, SignedOutError } from "./api";
import { withoutEmoji } from "./format";
import { spoke } from "./voice";
import type { ActivityEvent, Member } from "./types";

/** How long a sent message may go unacknowledged by its thread before the console says so. */
/** How long a sent message may go without a turn before the thread is restarted; a little past the server's own grace. */
const NO_REPLY_MS = 50_000;

/** HQ's desk, as `agent/lib/rooms.ts` names it. */
const HQ_ROOM_NAME = "desk";

/** The glyph a notice wears; the transcript draws each with its lucide icon. */
export type NoticeIcon = "alert" | "branch" | "check" | "clock" | "dot" | "folder" | "mail" | "monitor" | "person" | "plug" | "x";

export interface Notice {
  readonly icon: NoticeIcon;
  readonly label: string;
  readonly detail?: string;
  readonly tone?: "error";
  /** Something the person can do about it, offered as a button. */
  readonly action?: "start-over" | "open-connectors";
  /** A teammate's face to show in place of the icon, by id or name. */
  readonly face?: string;
  /** The job it is about, when it is about one. */
  readonly jobId?: string;
  /** A small line rather than a notice, such as what was just remembered. */
  readonly quiet?: true;
}

/**
 * A failed turn, in words for the person reading the thread. eve's own
 * message is kept for anything not recognised here.
 */
export function failureNotice(message: string): Omit<Notice, "icon"> {
  if (/generation-bound delivery/.test(message)) {
    return {
      label: "This thread cannot continue here",
      detail:
        "It was started under the development server (npm run dev), and this server cannot pick it up. Start it over to keep talking; the roster, finished work, and memory stay.",
      tone: "error",
      action: "start-over",
    };
  }
  // AI Gateway's own refusals (see explainGatewayError in agent/lib/models.ts), said plainly.
  if (/quota_for_entity_exceeded|\b402\b[^]*\bbudget\b/i.test(message)) {
    return {
      label: "AI Gateway budget reached",
      detail: "The budget set for this team, project or key in the Vercel dashboard (AI Gateway → Budgets) is used up. Raise it there, or wait for it to reset.",
      tone: "error",
    };
  }
  if (/no_[a-z_]*providers_available|\bno\b[^.]*\bproviders\b[^.]*\bavailable\b|\bno provider for\b.*?\bsupports the requested\b/i.test(message)) {
    const model = /\bfor (?:model:\s*)?([\w-]+\/[\w./:-]*[\w-])/i.exec(message)?.[1];
    return {
      label: "No provider for this model",
      detail: `No AI Gateway provider can serve ${model ?? "the model"} with the data controls set on this deployment (BOT_ZDR, BOT_INFERENCE_REGION). Choose another model, or turn the setting off.`,
      tone: "error",
    };
  }
  if (/\bdoes not support (?:image|file|vision)\b|\bimage (?:or file )?input is not supported\b/i.test(message)) {
    return {
      label: "This model can't see the screen",
      detail: "It reads text only, and the browser works from screenshots. Choose a model that takes images for Bots on the Models page, then try again.",
      tone: "error",
    };
  }
  return { label: "Something went wrong", detail: message, tone: "error" };
}

export type RoomItem =
  | { readonly kind: "you" | "bot"; readonly key: string; readonly at: string; readonly text: string }
  /** A teammate's message to this thread's member (see `agent/lib/teammail.ts`). */
  | { readonly kind: "peer"; readonly key: string; readonly at: string; readonly from: string; readonly text: string }
  | ({ readonly kind: "notice"; readonly key: string; readonly at: string } & Notice)
  | { readonly kind: "ask"; readonly key: string; readonly at: string; readonly requestId: string }
  /** An email a Claude Code or Codex Bot asked a person to send (see ask-card.tsx's ProposalCard). */
  | { readonly kind: "proposal"; readonly key: string; readonly at: string; readonly actionId: string };

export interface StepsItem {
  readonly kind: "steps";
  readonly key: string;
  readonly at: string;
  readonly jobId: string | null;
  readonly events: readonly ActivityEvent[];
}

/** `old` marks what was said after a message the thread later went back to: still readable, on the old branch. */
export type TimelineItem = (RoomItem | StepsItem) & { readonly old?: boolean };

export interface RoomSnapshot {
  readonly loaded: boolean;
  readonly items: readonly RoomItem[];
  /** Assistant text still streaming in. */
  readonly drafts: readonly string[];
  readonly asks: ReadonlyMap<string, InputRequest>;
  readonly resolutions: ReadonlyMap<string, InputResolution>;
  readonly answering: ReadonlySet<string>;
  /** Sent, not yet confirmed by the stream. */
  readonly optimistic: readonly string[];
  readonly live: boolean;
  readonly liveLabel: string | null;
}

const TOOL_WORDS: Readonly<Record<string, string>> = {
  hire_bot: "Hiring",
  assign_job: "Writing the brief",
  run_job: "Handing off the job",
  job_status: "Checking the job",
  list_jobs: "Looking at the work",
  list_bots: "Reading the roster",
  activity_feed: "Reading what happened",
  update_bot: "Updating the Bot",
  retire_bot: "Retiring a Bot",
  cancel_job: "Cancelling a job",
  ask_question: "Asking you",
  request_takeover: "Asking you to take over",
  browse: "Opening a page",
  page_click: "Clicking",
  page_fill: "Typing",
  task_update: "Checking in",
};

export function humanTool(name: string): string {
  const bare = name.split("__").pop() ?? name;
  return TOOL_WORDS[bare] ?? bare.replaceAll("_", " ").replace(/^\w/, (first) => first.toUpperCase());
}

/** A teammate's note as it arrived: who sent it and what they said, without the guidance for the reader. */
export function teammateNote(text: string): { from: string; text: string } | null {
  const match = /^Teammate message from (.+?) \[mail_[a-z0-9]+\]:\n([\s\S]*)$/.exec(text);
  if (match === null) return null;
  const body = (match[2] ?? "").replace(/\n\n— If [\s\S]*$/, "").trim();
  return { from: match[1] ?? "A teammate", text: body };
}

/** Messages the runtime wrote into the room: the dispatcher, the standup, task notices. */
export function systemNotice(text: string): Notice | null {
  const due = /^Job (job_[a-z0-9]+) is due: "(.*)"\./.exec(text);
  if (due) return { icon: "clock", label: "Due now", detail: due[2] ?? "" };
  if (/^Background task \S+ .*is completed\./.test(text)) {
    const job = /"jobId":"(job_[a-z0-9]+)"/.exec(text)?.[1];
    return { icon: "check", label: "Work came back", ...(job === undefined ? {} : { jobId: job }) };
  }
  if (/^Background task \S+ .*failed\./.test(text)) return { icon: "alert", label: "Work failed", tone: "error" };
  if (/^Background task \S+ .*needs authorization\./.test(text)) return { icon: "alert", label: "Needs a sign-in" };
  if (/^Background task /.test(text)) return { icon: "dot", label: "Progress update" };
  // A routine's run reports after each cycle; HQ relays what is new (see run_job).
  if (text.startsWith("Routine report:")) return { icon: "clock", label: "Routine ran" };
  if (text.startsWith("Write the daily standup")) return { icon: "clock", label: "Daily standup" };
  return null;
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** The event a successful tool call represents in the transcript, if any. */
export function actionNotice(toolName: string, output: unknown): Notice | null {
  if (!isRecord(output)) return null;
  const bot = isRecord(output.bot) ? output.bot : {};
  const job = isRecord(output.job) ? output.job : {};
  switch (toolName.split("__").pop()) {
    case "hire_bot":
      return output.hired === true ? { icon: "person", label: "Hired", detail: text(bot.name) ?? "" } : null;
    case "assign_job":
      if (output.assigned !== true) return null;
      return typeof job.everyMinutes === "number"
        ? { icon: "clock", label: "Created Routine", detail: text(job.title) ?? "" }
        : {
            icon: "folder",
            label: bot.pickedBy === "named" || bot.pickedBy === "fit" ? `Handed to ${text(bot.name) ?? "a teammate"}` : "Took it on",
            detail: text(job.title) ?? "",
            ...(text(bot.id) === undefined ? {} : { face: text(bot.id) }),
            ...(text(job.id) === undefined ? {} : { jobId: text(job.id) }),
          };
    case "update_bot":
      return output.updated === true ? { icon: "person", label: "Updated", detail: text(bot.name) ?? "" } : null;
    case "cancel_job":
      return output.cancelled === true ? { icon: "x", label: "Cancelled", detail: text(job.title) ?? "" } : null;
    case "message_teammate":
      return output.sent === true
        ? { icon: "mail", label: `Messaged ${text(output.to) ?? "a teammate"}`, ...(text(output.to) === undefined ? {} : { face: text(output.to) }) }
        : null;
    case "retire_bot":
      return output.retired === true ? { icon: "person", label: "Retired a Bot" } : null;
    default:
      return null;
  }
}

/**
 * One room's conversation, read from its durable NDJSON stream.
 *
 * Stores outlive the components that show them, so switching Bots and back does
 * not replay a thread: the store keeps its cursor and resumes from there.
 * Components read it through `useSyncExternalStore`.
 */
export class RoomStore {
  readonly room: string;

  private items: RoomItem[] = [];
  private drafts = new Map<string, string>();
  private asks = new Map<string, InputRequest>();
  private resolutions = new Map<string, InputResolution>();
  private answering = new Set<string>();
  private optimistic: string[] = [];
  /** Sent messages the thread has not picked up yet, each with a deadline. */
  private readonly unanswered = new Map<string, ReturnType<typeof setTimeout>>();
  /** Messages the watchdog already sent again once; a second silence is shown, not retried. */
  private readonly recovered = new Set<string>();
  private live = false;
  private liveLabel: string | null = null;
  private loaded = false;
  private terminal = false;

  private sessionId: string | null = null;
  private index = 0;
  private idle = 0;
  private following = false;
  private controller: AbortController | null = null;
  private wake: (() => void) | null = null;

  private listeners = new Set<() => void>();
  private snapshot: RoomSnapshot;
  private emitQueued = false;

  constructor(room: string) {
    this.room = room;
    this.snapshot = this.capture();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    void this.follow();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.controller?.abort();
    };
  };

  getSnapshot = (): RoomSnapshot => this.snapshot;

  async send(message: string): Promise<boolean> {
    this.optimistic.push(message);
    this.loaded = true;
    this.terminal = false;
    this.emit();
    try {
      const response = await api(`/bot/v1/rooms/${encodeURIComponent(this.room)}/messages`, {
        method: "POST",
        body: JSON.stringify({ message }),
      });
      if (!response.ok) throw new Error(await errorMessage(response, "Could not send"));
      const sent: unknown = await response.json().catch(() => null);
      const sessionId = typeof sent === "object" && sent !== null && typeof (sent as { sessionId?: unknown }).sessionId === "string" ? (sent as { sessionId: string }).sessionId : null;
      // The message went into a different session than the one being read (after a
      // branch, or once the server moved a stranded thread on): the open stream will
      // never carry the reply, so read the room again from its start.
      if (sessionId !== null && this.sessionId !== null && sessionId !== this.sessionId) this.switchSession();
      void this.follow();
      this.poke();
      this.expectReply(message);
      return true;
    } catch (error) {
      const pending = this.optimistic.indexOf(message);
      if (pending >= 0) this.optimistic.splice(pending, 1);
      if (error instanceof SignedOutError) this.emit();
      else this.pushError("Not sent", error instanceof Error ? error.message : undefined);
      return false;
    }
  }

  /**
   * A message the server accepted but the thread never picks up hangs
   * otherwise: eve emits nothing when a turn cannot start, which is what
   * happens to a thread the development server made once a production server
   * takes over. After a while the message is taken back and the thread offers
   * to start over.
   */
  private expectReply(message: string): void {
    this.replied(message);
    this.unanswered.set(
      message,
      setTimeout(() => {
        this.unanswered.delete(message);
        if (!this.optimistic.includes(message)) return;
        if (this.recovered.has(message)) {
          this.giveUp(message);
          return;
        }
        void this.recover(message);
      }, NO_REPLY_MS),
    );
  }

  /**
   * The watchdog. The server moves the thread to a fresh session and sends the
   * message again; here the conversation shown stays as it was, and the new
   * session is read from its start. A thread that is still answering is left
   * alone by the server, in which case the wait simply continues.
   */
  private async recover(message: string): Promise<void> {
    this.recovered.add(message);
    try {
      const response = await api(`/bot/v1/rooms/${encodeURIComponent(this.room)}/recover`, { method: "POST", body: JSON.stringify({ message }) });
      if (response.status === 409) {
        // Not wedged after all: a slow turn. Wait once more, then say so.
        this.expectReply(message);
        return;
      }
      if (!response.ok) throw new Error(await errorMessage(response, "The server refused."));
    } catch (error) {
      if (!(error instanceof SignedOutError)) this.giveUp(message);
      return;
    }
    // Same thread, new session: drop the old follower and read the new one from its first event.
    this.controller?.abort();
    this.controller = null;
    this.following = false;
    this.sessionId = null;
    this.index = 0;
    this.terminal = false;
    this.items.push({
      kind: "notice",
      key: `recovered:${Date.now()}:${this.items.length}`,
      at: new Date().toISOString(),
      icon: "check",
      label: "Thread restarted",
      detail: "It had stopped answering, so it was started fresh and your message sent again. It will not remember this conversation, only what is in Memory.",
    });
    this.emit();
    this.expectReply(message);
    void this.follow();
  }

  private giveUp(message: string): void {
    const pending = this.optimistic.indexOf(message);
    if (pending < 0) return;
    this.optimistic.splice(pending, 1);
    this.items.push({
      kind: "notice",
      key: `unanswered:${Date.now()}:${this.items.length}`,
      at: new Date().toISOString(),
      icon: "alert",
      label: "No reply",
      detail: "The message was accepted, but this thread never picked it up, even after a restart. Check the server logs, or start the thread over.",
      tone: "error",
      action: "start-over",
    });
    this.settle();
    this.emit();
  }

  private replied(message: string): void {
    const timer = this.unanswered.get(message);
    if (timer !== undefined) clearTimeout(timer);
    this.unanswered.delete(message);
  }

  async answer(requestId: string, optionId: string | undefined, note: string): Promise<boolean> {
    const trimmed = note.trim();
    if (optionId === undefined && trimmed === "") return false;
    this.answering.add(requestId);
    this.emit();
    try {
      const response = await api(`/bot/v1/rooms/${encodeURIComponent(this.room)}/respond`, {
        method: "POST",
        body: JSON.stringify({
          responses: [
            {
              requestId,
              ...(optionId === undefined ? {} : { optionId }),
              ...(trimmed === "" ? {} : { text: trimmed }),
            },
          ],
        }),
      });
      if (!response.ok) throw new Error(await errorMessage(response, "Could not answer"));
      void this.follow();
      this.poke();
      return true;
    } catch (error) {
      this.answering.delete(requestId);
      if (error instanceof SignedOutError) this.emit();
      else this.pushError("Answer not sent", error instanceof Error ? error.message : undefined);
      return false;
    }
  }

  async cancel(): Promise<void> {
    try {
      await api(`/bot/v1/rooms/${encodeURIComponent(this.room)}/cancel`, { method: "POST" });
    } catch {
      // The stream still shows whether the turn stopped.
    }
  }

  /**
   * Starts the thread over: clears its conversation and cancels its open
   * one-off jobs on the server, then this store, so the next message opens a
   * fresh session. The roster, finished work, and memory stay.
   */
  async startOver(): Promise<boolean> {
    try {
      const response = await api(`/bot/v1/rooms/${encodeURIComponent(this.room)}/reset`, { method: "POST" });
      if (!response.ok) {
        this.pushError("Could not start over", await errorMessage(response, "The server refused."));
        return false;
      }
    } catch (error) {
      if (error instanceof SignedOutError) return false;
      this.pushError("Could not start over", error instanceof Error ? error.message : String(error));
      return false;
    }
    this.restart();
    return true;
  }

  /**
   * Takes the thread back to one of its messages (see the fork route). What
   * was said after it stays where it is, faded under a divider the board
   * brings; the next message carries on from the chosen one.
   */
  async branch(eventId: string): Promise<boolean> {
    try {
      const response = await api(`/bot/v1/rooms/${encodeURIComponent(this.room)}/fork`, { method: "POST", body: JSON.stringify({ eventId }) });
      if (!response.ok) {
        this.pushError("Could not go back to that message", await errorMessage(response, "The server refused."));
        return false;
      }
    } catch (error) {
      if (error instanceof SignedOutError) return false;
      this.pushError("Could not go back to that message", error instanceof Error ? error.message : String(error));
      return false;
    }
    this.poke();
    return true;
  }

  /**
   * The room moved to another session while this reader follows the old one.
   * The stream reads the room's earlier sessions first, so starting over from
   * its first event rebuilds the whole thread and then follows the new session.
   */
  private switchSession(): void {
    this.controller?.abort();
    this.controller = null;
    this.following = false;
    this.reset();
    this.sessionId = null;
  }

  /** The thread was started over on the server: show it empty and follow whatever comes next. */
  restart(): void {
    // The current follower is on the old session's stream; drop it before reading again.
    this.controller?.abort();
    this.controller = null;
    this.following = false;
    this.reset();
    this.sessionId = null;
    this.loaded = true;
    this.emit();
    void this.follow();
  }

  private capture(): RoomSnapshot {
    return {
      loaded: this.loaded,
      items: [...this.items],
      drafts: [...this.drafts.values()].filter((draft) => draft.trim() !== ""),
      asks: new Map(this.asks),
      resolutions: new Map(this.resolutions),
      answering: new Set(this.answering),
      optimistic: [...this.optimistic],
      live: this.live,
      liveLabel: this.liveLabel,
    };
  }

  /** Coalesces a burst of events into one snapshot and one render. */
  private emit(): void {
    if (this.emitQueued) return;
    this.emitQueued = true;
    queueMicrotask(() => {
      this.emitQueued = false;
      this.snapshot = this.capture();
      for (const listener of this.listeners) listener();
    });
  }

  private pushError(label: string, detail: string | undefined): void {
    this.items.push({
      kind: "notice",
      key: `error:${Date.now()}:${this.items.length}`,
      at: new Date().toISOString(),
      icon: "alert",
      label,
      tone: "error",
      ...(detail === undefined ? {} : { detail }),
    });
    this.emit();
  }

  private settle(): void {
    this.live = false;
    this.liveLabel = null;
    this.drafts.clear();
  }

  private reset(): void {
    for (const timer of this.unanswered.values()) clearTimeout(timer);
    this.unanswered.clear();
    this.items = [];
    this.drafts.clear();
    this.asks.clear();
    this.resolutions.clear();
    this.answering.clear();
    this.index = 0;
    this.terminal = false;
    this.settle();
  }

  private apply(event: MessageStreamEvent): void {
    const at = event.meta.at;
    const key = event.meta.id || `${this.room}:${this.index}`;
    switch (event.type) {
      case "message.received": {
        const message = event.data.message;
        const note = teammateNote(message);
        if (note !== null) {
          this.items.push({ kind: "peer", key, at, from: note.from, text: note.text });
          break;
        }
        const notice = systemNotice(message);
        if (notice !== null) {
          this.items.push({ kind: "notice", key, at, ...notice });
          break;
        }
        const pending = this.optimistic.indexOf(message);
        if (pending >= 0) this.optimistic.splice(pending, 1);
        this.replied(message);
        this.items.push({ kind: "you", key, at, text: message });
        break;
      }
      case "message.appended": {
        spoke(this.room);
        const draft = `${event.data.turnId}:${event.data.stepIndex}`;
        this.drafts.set(draft, (this.drafts.get(draft) ?? "") + event.data.messageDelta);
        break;
      }
      case "message.completed":
        this.drafts.delete(`${event.data.turnId}:${event.data.stepIndex}`);
        if (event.data.message) this.items.push({ kind: "bot", key, at, text: event.data.message });
        break;
      case "actions.requested":
        for (const action of event.data.actions) {
          const label = event.data.presentation?.[action.callId]?.label;
          if ("toolName" in action) this.liveLabel = label ?? humanTool(action.toolName);
          else if ("subagentName" in action) this.liveLabel = label ?? `Asking ${action.subagentName}`;
        }
        break;
      case "action.result": {
        const result = event.data.result;
        if (event.data.error !== undefined || !("toolName" in result) || !("output" in result)) break;
        if ("isError" in result && result.isError === true) break;
        const notice = actionNotice(result.toolName, result.output);
        if (notice !== null) this.items.push({ kind: "notice", key, at, ...notice });
        break;
      }
      case "authorization.required": {
        const name = (event.data as { name?: string; authorization?: { displayName?: string } }).authorization?.displayName ?? (event.data as { name?: string }).name ?? "a connector";
        this.items.push({
          kind: "notice",
          key: `authorization:${(event.data as { sequence?: number }).sequence ?? this.items.length}`,
          at: new Date().toISOString(),
          icon: "plug",
          label: `Sign in to ${name} to continue`,
          detail: "The Bot needs an account it can use. Connect it and the work carries on.",
          action: "open-connectors",
        });
        this.emit();
        break;
      }
      case "authorization.completed": {
        const outcome = (event.data as { outcome?: string }).outcome;
        const name = (event.data as { name?: string }).name ?? "the connector";
        this.items.push({
          kind: "notice",
          key: `authorized:${(event.data as { sequence?: number }).sequence ?? this.items.length}`,
          at: new Date().toISOString(),
          icon: outcome === "authorized" || outcome === "approved" ? "check" : "alert",
          label: outcome === "authorized" || outcome === "approved" ? `Signed in to ${name}` : `Could not sign in to ${name}`,
          ...(outcome === "authorized" || outcome === "approved" ? {} : { tone: "error" as const }),
        });
        this.emit();
        break;
      }
      case "input.requested":
        for (const request of event.data.requests) {
          if (this.asks.has(request.requestId)) continue;
          this.asks.set(request.requestId, request);
          this.items.push({ kind: "ask", key: request.requestId, at, requestId: request.requestId });
        }
        break;
      case "input.resolved":
        for (const resolution of event.data.resolutions) {
          this.resolutions.set(resolution.requestId, resolution);
          this.answering.delete(resolution.requestId);
        }
        break;
      case "task.settled": {
        // eve 0.79 hands a finished task's result to the model inside the turn, with
        // no message of its own; a job's run coming back is marked here instead.
        const data = event.data as { name?: string; status?: string; output?: unknown; error?: { message?: string } };
        if (data.name !== "run_job") break;
        const output = isRecord(data.output) ? data.output : {};
        const job = text(output.jobId);
        if (data.status === "failed") {
          this.items.push({ kind: "notice", key, at, icon: "alert", tone: "error", label: "Work failed", ...(job === undefined ? {} : { jobId: job }) });
        } else if (data.status === "completed" && output.ran === true) {
          const stopped = output.status === "cancelled";
          this.items.push({
            kind: "notice",
            key,
            at,
            icon: stopped ? "x" : "check",
            label: stopped ? "Work cancelled" : "Work came back",
            ...(job === undefined ? {} : { jobId: job }),
          });
        }
        break;
      }
      case "turn.started":
        this.live = true;
        this.liveLabel = null;
        break;
      case "turn.failed":
        this.items.push({ kind: "notice", key, at, icon: "alert", ...failureNotice(event.data.message) });
        this.settle();
        break;
      case "session.failed":
      case "session.completed":
        this.terminal = true;
        this.settle();
        break;
      case "turn.completed":
      case "turn.cancelled":
      case "session.waiting":
        this.settle();
        break;
      default:
        break;
    }
  }

  /** A pause between reconnects that sending or answering cuts short. */
  private nap(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (this.wake === done) this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }

  private poke(): void {
    this.idle = 0;
    this.wake?.();
  }

  /** Reads the room's stream from its cursor, reconnecting as needed. */
  private async follow(): Promise<void> {
    if (this.following || this.terminal) return;
    this.following = true;
    const controller = new AbortController();
    this.controller = controller;
    this.idle = 0;
    let waitingForSession = 0;

    try {
      while (!controller.signal.aborted) {
        let response: Response;
        try {
          response = await fetch(
            `/bot/v1/rooms/${encodeURIComponent(this.room)}/stream?startIndex=${this.index}`,
            { credentials: "same-origin", signal: controller.signal },
          );
        } catch {
          if (controller.signal.aborted) break;
          await this.nap(2_000);
          continue;
        }

        if (response.status === 401 || response.status === 503) {
          redirectToLogin(response.status === 503 ? "unconfigured" : undefined);
          break;
        }
        if (response.status === 204) {
          this.loaded = true;
          this.emit();
          // A first message may still be claiming its room; give it a moment.
          if (this.optimistic.length > 0 && waitingForSession++ < 30) {
            await this.nap(700);
            continue;
          }
          if (this.optimistic.length > 0) {
            this.optimistic = [];
            this.pushError("No reply", "The conversation did not start. Check the server logs.");
          }
          break;
        }
        if (!response.ok || response.body === null) {
          await this.nap(3_000);
          continue;
        }

        const sessionId = response.headers.get("x-bot-session");
        if (sessionId !== null && this.sessionId !== null && sessionId !== this.sessionId) {
          // The room moved to a new session; the old cursor means nothing there.
          void response.body.cancel();
          this.reset();
          this.sessionId = sessionId;
          continue;
        }
        this.sessionId = sessionId;

        const received = await this.read(response.body);
        this.loaded = true;
        this.emit();
        if (this.terminal) break;
        this.idle = received > 0 ? 0 : Math.min(this.idle + 1, 6);
        await this.nap(600 * 2 ** this.idle);
      }
    } finally {
      // A follower that was replaced (see `restart`) leaves the new one's state alone.
      if (this.controller === controller) {
        this.following = false;
        this.controller = null;
      }
      // Someone came back while this reader was unwinding from an abort.
      if (controller.signal.aborted && this.listeners.size > 0 && !this.terminal) void this.follow();
    }
  }

  private async read(body: ReadableStream<Uint8Array>): Promise<number> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let received = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (line.trim() === "") continue;
          this.index += 1;
          received += 1;
          try {
            this.apply(JSON.parse(line) as MessageStreamEvent);
          } catch {
            // One malformed line should not end the thread.
          }
          this.loaded = true;
          this.emit();
        }
      }
    } catch {
      // Dropped connection; the caller reconnects from the cursor.
    }
    return received;
  }
}

const stores = new Map<string, RoomStore>();

export function roomStore(room: string): RoomStore {
  let store = stores.get(room);
  if (store === undefined) {
    store = new RoomStore(room);
    stores.set(room, store);
  }
  return store;
}

/** Bots whose hire line says the QA suite made them as a fixture. */
export function qaFixtureBots(activity: readonly ActivityEvent[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const event of activity) {
    if (event.kind === "bot.hired" && event.botId != null && / as QA fixture\.?$/.test(event.text)) ids.add(event.botId);
  }
  return ids;
}

/**
 * The transcript: the room's own events, interleaved with the feed. In a Bot's
 * thread, consecutive steps it logged for one job fold into a single block.
 */
export function buildTimeline(
  member: Member,
  items: readonly RoomItem[],
  activity: readonly ActivityEvent[],
  members: readonly Member[] = [],
): TimelineItem[] {
  type Entry = { readonly at: string; readonly item: TimelineItem } | { readonly at: string; readonly event: ActivityEvent };
  const entries: Entry[] = items.map((item) => ({ at: item.at, item }));
  // Each thread shows its own work. A job remembers the thread it was asked in
  // (`data.room`, on events recorded since that was added); older events carry
  // none and keep their old place.
  const roomOf = new Map<string, string>();
  for (const event of activity) {
    const room = event.data?.room;
    if (event.jobId != null && typeof room === "string") roomOf.set(event.jobId, room);
  }
  const nameOfRoom = (room: string) =>
    room === HQ_ROOM_NAME ? "HQ" : (members.find((entry) => entry.room === room)?.name ?? "A teammate");
  // HQ relays a finished job itself when its session wakes for it. When that
  // wake never comes, the feed still knows the job closed; a notice here keeps
  // the result in front of the person either way, skipped when the relay came.
  const relayedJobs = new Set(items.flatMap((item) => (item.kind === "notice" && item.label === "Work came back" && item.jobId !== undefined ? [item.jobId] : [])));
  const relayed = items.filter((item) => item.kind === "notice" && item.label === "Work came back").map((item) => Date.parse(item.at));
  const relayedNear = (at: string) => relayed.some((when) => Math.abs(when - Date.parse(at)) < 3 * 60_000);
  const wasRelayed = (event: ActivityEvent) => (event.jobId != null && relayedJobs.has(event.jobId)) || relayedNear(event.at);
  // Bots the QA suite hired to test the roster (role "QA fixture") come and go
  // within a minute; their arrival and removal are not news for a person.
  const fixtures = qaFixtureBots(activity);
  for (const event of activity) {
    if (event.botId != null && fixtures.has(event.botId)) continue;
    // A failed turn of this thread is already on it, from its own stream (see agent/hooks/audit.ts).
    // Recorded before it was marked, it is known by its wording.
    if ((event.data?.turn === true || /^A turn failed \(/.test(event.text)) && event.data?.room === member.room) continue;
    // A thread that was started over shows nothing from before that moment.
    if (member.clearedAt !== null && event.at < member.clearedAt) continue;
    const jobRoom = event.jobId == null ? undefined : roomOf.get(event.jobId);
    const close = event.kind === "job.done" || event.kind === "job.failed";
    const relevant =
      member.kind === "bot"
        ? event.botId === member.id &&
          (event.kind.startsWith("job.") || event.kind === "memory.saved" || (event.kind === "input.requested" && typeof event.data?.proposal === "string"))
        : event.kind === "bot.hired" ||
          event.kind === "bot.retired" ||
          (event.kind === "memory.saved" && event.botId === null) ||
          event.kind.startsWith("computer.") ||
          // Only work asked here, and only when HQ's own relay never came.
          (close && (jobRoom === undefined ? true : jobRoom === member.room) && !wasRelayed(event));
    if (relevant) entries.push({ at: event.at, event });
  }
  entries.sort((left, right) => left.at.localeCompare(right.at));

  const out: TimelineItem[] = [];
  const introduced = new Set<string>();
  for (const entry of entries) {
    if ("item" in entry) {
      out.push(entry.item);
      continue;
    }
    const { event } = entry;
    if (member.kind === "hq") {
      // HQ's thread also carries what happened to the team's computer, and a
      // job's close when HQ did not relay it.
      const computer = event.kind.startsWith("computer.");
      const close = event.kind === "job.done" || event.kind === "job.failed";
      const remembered = event.kind === "memory.saved";
      const cut = event.text.indexOf(": ");
      if (remembered) {
        out.push({ kind: "notice", key: event.id, at: event.at, icon: "dot", label: "Memory", detail: event.text, quiet: true });
        continue;
      }
      out.push({
        kind: "notice",
        key: event.id,
        at: event.at,
        icon: computer ? "monitor" : close ? (event.kind === "job.done" ? "check" : "alert") : "person",
        label: close && cut > 0 ? withoutEmoji(event.text.slice(0, cut)) : withoutEmoji(event.text),
        ...(close && cut > 0 ? { detail: event.text.slice(cut + 2) } : {}),
        ...(event.kind === "computer.failed" || event.kind === "job.failed" ? { tone: "error" as const } : {}),
        ...(close && event.botId != null ? { face: event.botId } : {}),
      });
      continue;
    }
    // A Claude Code or Codex Bot's email waiting for a person: its own card.
    if (event.kind === "input.requested") {
      if (typeof event.data?.proposal === "string") out.push({ kind: "proposal", key: event.id, at: event.at, actionId: event.data.proposal });
      continue;
    }
    // Work this Bot was given from another thread reads as a conversation: who
    // asked, then the answer. The live step is on the working row meanwhile.
    const jobRoom = event.jobId == null ? undefined : roomOf.get(event.jobId);
    if (jobRoom !== undefined && jobRoom !== member.room && event.jobId != null) {
      // Who asked, once per job, from whichever of its events comes first.
      if (!introduced.has(event.jobId)) {
        introduced.add(event.jobId);
        const title = typeof event.data?.title === "string" ? event.data.title : /"([^"]+)"/.exec(event.text)?.[1];
        if (title !== undefined) out.push({ kind: "peer", key: `asked:${event.jobId}`, at: event.at, from: nameOfRoom(jobRoom), text: title });
      }
      if (event.kind === "job.done") {
        // The result itself when the job kept one, else its one-line summary.
        const deliverable = typeof event.data?.deliverable === "string" && event.data.deliverable.trim() !== "" ? event.data.deliverable : null;
        const summary = typeof event.data?.summary === "string" ? event.data.summary : event.text.slice(event.text.indexOf(": ") + 2);
        out.push({ kind: "bot", key: event.id, at: event.at, text: deliverable ?? summary });
      } else if (event.kind === "job.failed") {
        out.push({ kind: "notice", key: event.id, at: event.at, icon: "alert", tone: "error", label: withoutEmoji(event.text) });
      }
      continue;
    }
    // A Claude Code or Codex Bot's own words while it works (lib/engines/sessions.ts tellThread).
    if (event.kind === "job.progress" && event.data?.said === true) {
      out.push({ kind: "bot", key: event.id, at: event.at, text: event.text });
      continue;
    }
    const last = out[out.length - 1];
    if (last?.kind === "steps" && last.jobId === event.jobId) {
      out[out.length - 1] = { ...last, events: [...last.events, event] };
    } else {
      out.push({ kind: "steps", key: `steps:${event.id}`, at: event.at, jobId: event.jobId, events: [event] });
    }
  }
  return withBranches(out, member.branches ?? []);
}

/**
 * Marks what a thread said after a message it later went back to, and puts a
 * divider where the new branch starts: how much stayed behind, and the jobs
 * started back there that are still going, so nothing continues unseen.
 */
export function withBranches(items: readonly TimelineItem[], branches: readonly Member["branches"][number][]): TimelineItem[] {
  let out = [...items];
  for (const branch of branches) {
    const point = out.findIndex((item) => item.key === branch.eventId);
    if (point < 0) continue;
    let last = point;
    let left = 0;
    for (let index = point + 1; index < out.length; index++) {
      const item = out[index];
      if (item === undefined || item.at > branch.at) break;
      out[index] = { ...item, old: true };
      last = index;
      if (item.kind === "you" || item.kind === "bot" || item.kind === "peer") left++;
    }
    const open = branch.jobs.filter((job) => !["done", "failed", "cancelled"].includes(job.status));
    const said = out[point];
    const words = said !== undefined && "text" in said ? said.text.replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim().replace(/^(?:[-•]|\d+[.)])\s+/, "") : "";
    const quote = words === "" ? null : `\u201c${words.length > 60 ? `${words.slice(0, 58).replace(/\s+\S*$/, "")}\u2026` : words}\u201d`;
    const divider: TimelineItem = {
      kind: "notice",
      key: `branch:${branch.at}`,
      at: branch.at,
      icon: "branch",
      label: quote === null ? "Went back to an earlier message" : `Went back to ${quote}`,
      ...(left > 0 || open.length > 0
        ? {
            detail: [
              left > 0 ? `${left} ${left === 1 ? "message" : "messages"} above stay on the old branch` : null,
              open.length > 0 ? `still going from it: ${open.map((job) => job.title).join(", ")}` : null,
            ]
              .filter((part) => part !== null)
              .join(" · "),
          }
        : {}),
    };
    out = [...out.slice(0, last + 1), divider, ...out.slice(last + 1)];
  }
  return out;
}
