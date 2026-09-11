import { recentActivity } from "./activity";
import { listBots } from "./bots";
import { computerMode, vercelCredentialsError, type ComputerMode } from "./computer-config";
import {
  handoverBelongsTo,
  liveControl,
  readScreens,
  workspaceScreen,
  type ScreenAllocation,
  type ServiceState,
} from "./computer/screens";
import { listOpenJobs } from "./jobs";
import { HQ_ROOM, roomForBot } from "./rooms";
import { getRoomState, type AnsweredInput, type RoomState } from "./roomstate";
import type { ActivityEvent, Bot, Job } from "./types";

/**
 * What the console shows: one roster entry per teammate with its presence, and
 * the feed its transcripts interleave. Presence is derived from durable records
 * — open jobs, the room's pending requests, recent outcomes — never guessed.
 *
 * Building the board never touches the computer itself, so an open console
 * does not keep it awake.
 */
export type Presence = "idle" | "thinking" | "working" | "waiting" | "blocked" | "done";

export interface Routine {
  readonly jobId: string;
  readonly title: string;
  readonly everyMinutes: number | null;
  readonly nextRunAt: string;
  readonly status: Job["status"];
  readonly lastRunAt: string | null;
}

export interface FileRef {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly at: string;
  readonly jobId: string | null;
}

/**
 * The team's one screen, as seen from a member's thread. The browser, control,
 * and still frame are the same for everyone; `active`, `jobId`, and `handover`
 * are this member's own.
 */
export interface MemberComputer {
  /** A job is running, so this Bot is likely using the browser; for HQ, any Bot is. */
  readonly active: boolean;
  /** The run the console follows. */
  readonly jobId: string | null;
  /** The team's screen on the computer, once the workspace has one. */
  readonly screen: number | null;
  readonly browser: ServiceState;
  /** Someone holding the team's browser, for example to sign in. */
  readonly control: { readonly by: string; readonly until: string } | null;
  /** When the still frame of the screen was last refreshed. */
  readonly posterAt: string | null;
  /** This Bot is waiting for a person to do one step in the browser; on HQ, whichever Bot is. */
  readonly handover: {
    readonly reason: string;
    readonly url: string | null;
    readonly at: string;
    readonly room: string;
    /** The request's id in the Bot's own session; the thread's copy adds a task prefix. */
    readonly requestId: string;
  } | null;
}

export interface Member {
  readonly id: string;
  readonly kind: "hq" | "bot";
  readonly room: string;
  readonly name: string;
  readonly title: string;
  readonly status: "active" | "paused";
  readonly presence: Presence;
  /** What it is doing right now, in a line; shown on hover. */
  readonly action: string | null;
  readonly preview: { text: string; from: "you" | "bot" | "activity"; at: string } | null;
  readonly pending: number;
  /** Requests in this room a person has answered, for cards the stream never resolves. */
  readonly answered: Readonly<Record<string, { readonly outcome: AnsweredInput["outcome"]; readonly optionId: string | null }>>;
  readonly computer: MemberComputer;
  readonly routines: readonly Routine[];
  readonly files: readonly FileRef[];
  readonly profile: {
    readonly persona: string;
    readonly skills: readonly string[];
    readonly playbook: readonly string[];
    readonly stats: Bot["stats"];
    readonly hiredAt: string;
    /** Name of the Bot that created this one, when a Bot did. */
    readonly createdBy: string | null;
  } | null;
}

export interface Board {
  readonly workspaceId: string;
  readonly members: readonly Member[];
  readonly activity: readonly ActivityEvent[];
  readonly computer: {
    readonly backend: ComputerMode;
    /** Why the computer cannot start, or its most recent failure. */
    readonly error: string | null;
  };
}

export const HQ_MEMBER_ID = "hq";

const DONE_GLOW_MS = 20 * 60_000;
const FAILED_STICKS_MS = 6 * 60 * 60_000;
const SCREEN_WINDOW_MS = 30 * 60_000;
const COMPUTER_ERROR_WINDOW_MS = 30 * 60_000;
const FEED_WINDOW = 150;

/** The team's screen from one member's point of view; see `MemberComputer`. */
function sharedComputer(
  screen: ScreenAllocation | null,
  running: Job | undefined,
  jobId: string | null,
  handover: NonNullable<ScreenAllocation["handover"]> | null,
): MemberComputer {
  const control = screen === null ? null : liveControl(screen);
  return {
    active: running !== undefined,
    jobId,
    screen: screen?.n ?? null,
    browser: screen?.browser.state ?? "off",
    control: control === null ? null : { by: control.by, until: control.until },
    posterAt: screen?.posterAt ?? null,
    handover:
      handover === null
        ? null
        : {
            reason: handover.reason,
            url: handover.url,
            at: handover.at,
            room: handover.room,
            requestId: handover.requestId,
          },
  };
}

export async function buildBoard(
  workspaceId: string,
  options: { after?: string } = {},
): Promise<Board> {
  const [bots, open, recent, screens] = await Promise.all([
    listBots(workspaceId),
    listOpenJobs(workspaceId),
    recentActivity(workspaceId, { limit: FEED_WINDOW }),
    readScreens(),
  ]);
  const rooms = await Promise.all(
    [HQ_ROOM, ...bots.map((bot) => roomForBot(bot.id))].map((room) =>
      getRoomState(workspaceId, room),
    ),
  );

  const now = Date.now();
  const screen = workspaceScreen(screens, workspaceId);
  const members: Member[] = [
    hqMember(rooms[0] ?? null, open, screen),
    ...bots
      .map((bot, index) =>
        botMember(
          bot,
          open.filter((job) => job.botId === bot.id),
          rooms[index + 1] ?? null,
          recent.filter((event) => event.botId === bot.id),
          screen,
          now,
        ),
      )
      .sort((left, right) => recency(right).localeCompare(recency(left))),
  ];

  const failure = recent.find(
    (event) => event.kind === "computer.failed" && now - Date.parse(event.at) < COMPUTER_ERROR_WINDOW_MS,
  );
  const backend = computerMode();
  const after = options.after;
  return {
    workspaceId,
    members,
    activity: after === undefined ? recent : recent.filter((event) => event.at >= after),
    computer: {
      backend,
      error: (backend === "vercel" ? vercelCredentialsError() : null) ?? failure?.text ?? null,
    },
  };
}

const recency = (member: Member) => member.preview?.at ?? member.profile?.hiredAt ?? "";

const answeredIn = (room: RoomState | null): Member["answered"] =>
  Object.fromEntries((room?.answered ?? []).map((entry) => [entry.requestId, { outcome: entry.outcome, optionId: entry.optionId }]));

function hqMember(room: RoomState | null, open: readonly Job[], screen: ScreenAllocation | null): Member {
  const pending = room?.pending ?? [];
  // From HQ's desk the team's browser is whoever is on it right now.
  const running = open.find((job) => job.status === "running");
  return {
    id: HQ_MEMBER_ID,
    kind: "hq",
    room: HQ_ROOM,
    name: "HQ",
    title: "Runs the team",
    status: "active",
    presence: pending.length > 0 ? "waiting" : room?.active === true ? "thinking" : "idle",
    action: pending[0]?.prompt ?? (room?.active === true ? "Thinking" : null),
    preview: room?.preview ?? null,
    pending: pending.length,
    answered: answeredIn(room),
    computer: sharedComputer(screen, running, running?.id ?? null, screen?.handover ?? null),
    routines: [],
    files: [],
    profile: null,
  };
}

function botMember(
  bot: Bot,
  jobs: readonly Job[],
  room: RoomState | null,
  events: readonly ActivityEvent[],
  screen: ScreenAllocation | null,
  now: number,
): Member {
  const own = screen?.handover ?? null;
  const handover = handoverBelongsTo(own, bot.id, jobs.map((job) => job.id)) ? own : null;
  const derived = presenceOf(jobs, room, events, now);
  // A Bot waiting for someone to take over its browser is waiting on you, not stuck.
  const { presence, action } =
    handover === null ? derived : { presence: "waiting" as const, action: `Needs you: ${handover.reason}` };
  const running = jobs.find((job) => job.status === "running");
  const lastRun = events.find(
    (event) =>
      (event.kind === "job.started" || event.kind === "job.done" || event.kind === "job.failed") &&
      now - Date.parse(event.at) < SCREEN_WINDOW_MS,
  );
  const latest = events[0];

  return {
    id: bot.id,
    kind: "bot",
    room: roomForBot(bot.id),
    name: bot.name,
    title: bot.role,
    status: bot.status,
    presence,
    action,
    preview:
      room?.preview ??
      (latest === undefined ? null : { text: latest.text, from: "activity", at: latest.at }),
    pending: room?.pending.length ?? 0,
    answered: answeredIn(room),
    computer: sharedComputer(screen, running, running?.id ?? lastRun?.jobId ?? null, handover),
    routines: jobs
      .filter((job) => job.everyMinutes !== null || job.status === "scheduled")
      .map((job) => ({
        jobId: job.id,
        title: job.title,
        everyMinutes: job.everyMinutes,
        nextRunAt: job.runAt,
        status: job.status,
        lastRunAt: job.lastRunAt,
      })),
    files: events
      .filter((event) => event.kind === "job.artifact" && typeof event.data?.artifactId === "string")
      .slice(0, 8)
      .map((event) => ({
        id: String(event.data?.artifactId),
        name: typeof event.data?.name === "string" ? event.data.name : "file",
        mediaType:
          typeof event.data?.mediaType === "string" ? event.data.mediaType : "application/octet-stream",
        bytes: typeof event.data?.bytes === "number" ? event.data.bytes : 0,
        at: event.at,
        jobId: event.jobId,
      })),
    profile: {
      persona: bot.persona,
      skills: bot.skills,
      playbook: bot.playbook,
      stats: bot.stats,
      hiredAt: bot.hiredAt,
      createdBy: bot.createdBy?.name ?? null,
    },
  };
}

function presenceOf(
  jobs: readonly Job[],
  room: RoomState | null,
  events: readonly ActivityEvent[],
  now: number,
): { presence: Presence; action: string | null } {
  const latestFor = (jobId: string, kinds: readonly string[]) =>
    events.find((event) => event.jobId === jobId && kinds.includes(event.kind))?.text;

  const signoff = jobs.find((job) => job.status === "blocked" && job.lease?.kind === "signoff");
  const pending = room?.pending[0];
  if (pending !== undefined || signoff !== undefined) {
    return {
      presence: "waiting",
      action: pending?.prompt ?? `Waiting for your sign-off on "${signoff?.title ?? "a job"}"`,
    };
  }

  const blocked = jobs.find((job) => job.status === "blocked");
  if (blocked !== undefined) {
    return {
      presence: "blocked",
      action: latestFor(blocked.id, ["job.blocked"]) ?? `Needs help with "${blocked.title}"`,
    };
  }

  const running = jobs.find((job) => job.status === "running");
  if (running !== undefined) {
    return {
      presence: "working",
      action:
        latestFor(running.id, ["job.progress", "job.artifact", "job.started"]) ??
        `Working on "${running.title}"`,
    };
  }

  const starting = jobs.find(
    (job) =>
      job.status === "dispatched" || (job.status === "queued" && Date.parse(job.runAt) <= now),
  );
  if (room?.active === true || starting !== undefined) {
    return { presence: "thinking", action: starting ? `Getting to "${starting.title}"` : "Thinking" };
  }

  const outcome = events.find((event) => event.kind === "job.done" || event.kind === "job.failed");
  const age = outcome === undefined ? Infinity : now - Date.parse(outcome.at);
  if (outcome?.kind === "job.failed" && age < FAILED_STICKS_MS) {
    return { presence: "blocked", action: outcome.text };
  }
  if (outcome?.kind === "job.done" && age < DONE_GLOW_MS) {
    return { presence: "done", action: outcome.text };
  }
  return { presence: "idle", action: null };
}
