import { recentActivity } from "./activity";
import { getBot, HQ_BOT_ID, listBots } from "./bots";
import { budgetStatus, type BudgetStatus } from "./budget";
import { computerMode, vercelCredentialsError, type ComputerMode } from "./computer-config";
import { currentKind, type HandsKind } from "./hands/kinds";
import { exportEnabled } from "./store/transfer";
import {
  handoverBelongsTo,
  liveControl,
  readScreens,
  workspaceScreen,
  type ScreenAllocation,
  type ServiceState,
} from "./computer/screens";
import { jobHealth, type Health } from "./health";
import { isRoutine, listOpenJobs } from "./jobs";
import { describeSchedule } from "./schedule";
import { ledgerTotal, NO_USAGE, readLedger, type Usage } from "./usage";
import { HQ_ROOM, roomForBot } from "./rooms";
import { getRoomState, type AnsweredInput, type Branch, type RoomState } from "./roomstate";
import type { ActivityEvent, Bot, Job } from "./types";
import { liveEnv } from "./settings/store";
import { type Engine, engineChoices, engineOf } from "./engines";

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
  /** How a clock routine reads, when it has one rather than an interval. */
  readonly schedule?: string;
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
  /** Where the computer runs, for people (see `hands/kinds.ts`). */
  readonly kind: string;
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

export interface WorkInHand {
  readonly id: string;
  readonly title: string;
  readonly room: string;
  readonly status: Job["status"];
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
  /** When the thread was last started over; activity before it stays out of the thread. */
  readonly clearedAt: string | null;
  /** Times the thread was taken back to an earlier message (see `roomstate.ts`). */
  readonly branches: readonly Branch[];
  /** What this member's model steps have cost, all time. */
  readonly usage: Usage;
  readonly pending: number;
  /** Requests in this room a person has answered, for cards the stream never resolves. */
  readonly answered: Readonly<Record<string, { readonly outcome: AnsweredInput["outcome"]; readonly optionId: string | null }>>;
  readonly computer: MemberComputer;
  readonly routines: readonly Routine[];
  readonly files: readonly FileRef[];
  /** Work in hand right now, and the thread each job was asked in, so that thread can show who is on it. */
  readonly jobs: readonly WorkInHand[];
  /** Roster placement from the row menu: pinned rows first, grouped by section, hidden rows folded away. */
  readonly pinned: boolean;
  readonly section: string | null;
  readonly hidden: boolean;
  readonly profile: {
    readonly persona: string;
    readonly skills: readonly string[];
    readonly playbook: readonly string[];
    readonly stats: Bot["stats"];
    readonly hiredAt: string;
    /** Name of the Bot that created this one, when a Bot did. */
    readonly createdBy: string | null;
    /** What runs its jobs. */
    readonly engine: Engine;
    /** Its hello and first jobs, for its empty thread. */
    readonly intro: Bot["intro"];
  } | null;
}

export interface Board {
  readonly workspaceId: string;
  readonly members: readonly Member[];
  readonly activity: readonly ActivityEvent[];
  readonly computer: {
    readonly backend: ComputerMode;
    /** Which kind of machine it is and what it can do (see `hands/kinds.ts`). */
    readonly kind: HandsKind;
    /** Why the computer cannot start, or its most recent failure. */
    readonly error: string | null;
  };
  /** What the workspace has spent on models, all time: HQ's own turns and every Bot's jobs. */
  readonly usage: { readonly total: Usage; readonly hq: Usage; readonly bots: Readonly<Record<string, Usage>> };
  /** This month's workspace budget (see `budget.ts`): limit, spent, held by running jobs, unknown-cost flags. */
  readonly budget: BudgetStatus;
  /** Work that should have started and has not, and runs whose worker stopped (see `health.ts`). */
  readonly health: Health;
  /** Whether the console may offer the workspace as an export file (`BOT_EXPORT`). */
  readonly exportable: boolean;
  /** What a Bot here may run on: always eve, and the engines the owner turned on (`lib/engines`). */
  readonly engines: readonly Engine[];
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
    kind: currentKind().label,
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
  const [bots, open, recent, screens, ledger, budget, hqWorker] = await Promise.all([
    listBots(workspaceId),
    listOpenJobs(workspaceId),
    recentActivity(workspaceId, { limit: FEED_WINDOW }),
    readScreens(),
    readLedger(workspaceId),
    budgetStatus(workspaceId),
    // HQ does work too; its jobs are recorded like a Bot's (see `bots.ts`).
    getBot(workspaceId, HQ_BOT_ID).then((worker) => worker!),
  ]);
  const rooms = await Promise.all(
    [HQ_ROOM, ...bots.map((bot) => roomForBot(bot.id))].map((room) =>
      getRoomState(workspaceId, room),
    ),
  );

  const now = Date.now();
  const screen = workspaceScreen(screens, workspaceId);
  const members: Member[] = [
    hqMember(
      rooms[0] ?? null,
      open,
      screen,
      ledger.hq,
      botMember(
        hqWorker,
        open.filter((job) => job.botId === HQ_BOT_ID),
        rooms[0] ?? null,
        recent.filter((event) => event.botId === HQ_BOT_ID),
        screen,
        now,
        ledger.hq,
      ),
    ),
    ...bots
      .map((bot, index) =>
        botMember(
          bot,
          open.filter((job) => job.botId === bot.id),
          rooms[index + 1] ?? null,
          recent.filter((event) => event.botId === bot.id),
          screen,
          now,
          ledger.bots[bot.id] ?? NO_USAGE,
        ),
      )
      // Pinned Bots first, then the most recently active; sections and hiding are the console's to draw.
      .sort((left, right) => Number(right.pinned) - Number(left.pinned) || recency(right).localeCompare(recency(left))),
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
      kind: currentKind(),
      error: (backend === "vercel" ? vercelCredentialsError() : null) ?? failure?.text ?? null,
    },
    usage: {
      total: ledgerTotal(ledger),
      hq: ledger.hq,
      bots: ledger.bots,
    },
    budget,
    exportable: exportEnabled(liveEnv()),
    engines: engineChoices(workspaceId),
    health: jobHealth(open, {
      now,
      pausedBotIds: new Set(bots.filter((bot) => bot.status !== "active").map((bot) => bot.id)),
    }),
  };
}

const recency = (member: Member) => member.preview?.at ?? member.profile?.hiredAt ?? "";

const answeredIn = (room: RoomState | null): Member["answered"] =>
  Object.fromEntries((room?.answered ?? []).map((entry) => [entry.requestId, { outcome: entry.outcome, optionId: entry.optionId }]));

function hqMember(room: RoomState | null, open: readonly Job[], screen: ScreenAllocation | null, usage: Usage, own: Member): Member {
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
    // What HQ itself is doing: its own jobs, or the conversation.
    presence: pending.length > 0 ? "waiting" : own.presence,
    action: pending[0]?.prompt ?? own.action,
    preview: room?.preview ?? null,
    clearedAt: room?.clearedAt ?? null,
    branches: room?.branches ?? [],
    usage,
    pending: pending.length,
    answered: answeredIn(room),
    computer: sharedComputer(screen, running, running?.id ?? null, openHandover(screen?.handover ?? null, open)),
    routines: own.routines,
    files: own.files,
    jobs: own.jobs,
    pinned: false,
    section: null,
    hidden: false,
    profile: null,
  };
}

/**
 * A handover is live only while the job that raised it is still open. The
 * run clears it when the job ends; this keeps a record it missed, or one from
 * before it did, from holding a Bot in "needs you" for good.
 */
function openHandover(handover: ScreenAllocation["handover"], open: readonly Job[]): NonNullable<ScreenAllocation["handover"]> | null {
  if (handover === undefined || handover === null) return null;
  if (handover.jobId !== null && !open.some((job) => job.id === handover.jobId)) return null;
  return handover;
}

function botMember(
  bot: Bot,
  jobs: readonly Job[],
  room: RoomState | null,
  events: readonly ActivityEvent[],
  screen: ScreenAllocation | null,
  now: number,
  usage: Usage,
): Member {
  const own = openHandover(screen?.handover ?? null, jobs);
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
    clearedAt: room?.clearedAt ?? null,
    branches: room?.branches ?? [],
    usage,
    pending: room?.pending.length ?? 0,
    answered: answeredIn(room),
    computer: sharedComputer(screen, running, running?.id ?? lastRun?.jobId ?? null, handover),
    routines: jobs
      .filter((job) => isRoutine(job) || job.status === "scheduled")
      .map((job) => ({
        jobId: job.id,
        title: job.title,
        everyMinutes: job.everyMinutes,
        ...(job.schedule == null ? {} : { schedule: describeSchedule(job.schedule) }),
        nextRunAt: job.runAt,
        status: job.status,
        lastRunAt: job.lastRunAt,
      })),
    files: events
      .filter((event) => event.kind === "job.artifact" && typeof event.data?.artifactId === "string")
      .slice(0, 40)
      .map((event) => ({
        id: String(event.data?.artifactId),
        name: typeof event.data?.name === "string" ? event.data.name : "file",
        mediaType:
          typeof event.data?.mediaType === "string" ? event.data.mediaType : "application/octet-stream",
        bytes: typeof event.data?.bytes === "number" ? event.data.bytes : 0,
        at: event.at,
        jobId: event.jobId,
      })),
    jobs: jobs
      .filter((job) => job.status === "running" || job.status === "dispatched" || job.status === "blocked")
      .map((job) => ({ id: job.id, title: job.title, room: job.room, status: job.status })),
    pinned: bot.pinned === true,
    section: bot.section ?? null,
    hidden: bot.hidden === true,
    profile: {
      persona: bot.persona,
      skills: bot.skills,
      playbook: bot.playbook,
      stats: bot.stats,
      hiredAt: bot.hiredAt,
      createdBy: bot.createdBy?.name ?? null,
      engine: engineOf(bot),
      intro: bot.intro ?? null,
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
