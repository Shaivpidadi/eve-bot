import type { InputRequest, InputResolution, MessageStreamEvent } from "eve/client";

import { api, errorMessage, isRecord, redirectToLogin, SignedOutError } from "./api";
import { withoutEmoji } from "./format";
import type { IconName } from "./icons";
import type { ActivityEvent, Member } from "./types";

export interface Notice {
  readonly icon: IconName;
  readonly label: string;
  readonly detail?: string;
  readonly tone?: "error";
}

export type RoomItem =
  | { readonly kind: "you" | "bot"; readonly key: string; readonly at: string; readonly text: string }
  | ({ readonly kind: "notice"; readonly key: string; readonly at: string } & Notice)
  | { readonly kind: "ask"; readonly key: string; readonly at: string; readonly requestId: string };

export interface StepsItem {
  readonly kind: "steps";
  readonly key: string;
  readonly at: string;
  readonly jobId: string | null;
  readonly events: readonly ActivityEvent[];
}

export type TimelineItem = RoomItem | StepsItem;

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

/** Messages the runtime wrote into the room: the dispatcher, the standup, task notices. */
export function systemNotice(text: string): Notice | null {
  const due = /^Job (job_[a-z0-9]+) is due: "(.*)"\./.exec(text);
  if (due) return { icon: "clock", label: "Routine started", detail: due[2] ?? "" };
  if (/^Background task \S+ .*is completed\./.test(text)) return { icon: "check", label: "Work came back" };
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
        : { icon: "folder", label: `Assigned to ${text(bot.name) ?? "a Bot"}`, detail: text(job.title) ?? "" };
    case "update_bot":
      return output.updated === true ? { icon: "person", label: "Updated", detail: text(bot.name) ?? "" } : null;
    case "cancel_job":
      return output.cancelled === true ? { icon: "x", label: "Cancelled", detail: text(job.title) ?? "" } : null;
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
      void this.follow();
      this.poke();
      return true;
    } catch (error) {
      const pending = this.optimistic.indexOf(message);
      if (pending >= 0) this.optimistic.splice(pending, 1);
      if (error instanceof SignedOutError) this.emit();
      else this.pushError("Not sent", error instanceof Error ? error.message : undefined);
      return false;
    }
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
        const notice = systemNotice(message);
        if (notice !== null) {
          this.items.push({ kind: "notice", key, at, ...notice });
          break;
        }
        const pending = this.optimistic.indexOf(message);
        if (pending >= 0) this.optimistic.splice(pending, 1);
        this.items.push({ kind: "you", key, at, text: message });
        break;
      }
      case "message.appended": {
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
      case "turn.started":
        this.live = true;
        this.liveLabel = null;
        break;
      case "turn.failed":
        this.items.push({
          kind: "notice",
          key,
          at,
          icon: "alert",
          label: "Something went wrong",
          detail: event.data.message,
          tone: "error",
        });
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
      this.following = false;
      if (this.controller === controller) this.controller = null;
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

/**
 * The transcript: the room's own events, interleaved with the feed. In a Bot's
 * thread, consecutive steps it logged for one job fold into a single block.
 */
export function buildTimeline(
  member: Member,
  items: readonly RoomItem[],
  activity: readonly ActivityEvent[],
): TimelineItem[] {
  type Entry = { readonly at: string; readonly item: RoomItem } | { readonly at: string; readonly event: ActivityEvent };
  const entries: Entry[] = items.map((item) => ({ at: item.at, item }));
  for (const event of activity) {
    const relevant =
      member.kind === "bot"
        ? event.botId === member.id && event.kind.startsWith("job.")
        : event.kind === "bot.hired" || event.kind === "bot.retired" || event.kind.startsWith("computer.");
    if (relevant) entries.push({ at: event.at, event });
  }
  entries.sort((left, right) => left.at.localeCompare(right.at));

  const out: TimelineItem[] = [];
  for (const entry of entries) {
    if ("item" in entry) {
      out.push(entry.item);
      continue;
    }
    const { event } = entry;
    if (member.kind === "hq") {
      // HQ's thread also carries what happened to the team's computer.
      const computer = event.kind.startsWith("computer.");
      out.push({
        kind: "notice",
        key: event.id,
        at: event.at,
        icon: computer ? "monitor" : "person",
        label: withoutEmoji(event.text),
        ...(event.kind === "computer.failed" ? { tone: "error" as const } : {}),
      });
      continue;
    }
    const last = out[out.length - 1];
    if (last?.kind === "steps" && last.jobId === event.jobId) {
      out[out.length - 1] = { ...last, events: [...last.events, event] };
    } else {
      out.push({ kind: "steps", key: `steps:${event.id}`, at: event.at, jobId: event.jobId, events: [event] });
    }
  }
  return out;
}
