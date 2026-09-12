import { COMPUTER_NAME } from "../computer";
import { readDoc, updateDoc, writeDoc } from "../store";

/**
 * Screens on the team's computer.
 *
 * A workspace has one screen: the team's browser, which HQ and every Bot share
 * and the operator can watch and take over from any thread. One Chrome profile
 * means one set of tabs and sign-ins, so what a person signs in to for one Bot
 * is there for the next. Screens are a small, fixed pool on one machine, so
 * they are allocated to workspaces on demand and reclaimed from the least
 * recently used workspace. The table lives in the app store, never on the
 * computer, so the console can read it without waking the sandbox.
 */
export type ServiceState = "off" | "starting" | "on" | "error";

export interface ScreenControl {
  /** The operator holding control. */
  readonly by: string;
  readonly since: string;
  readonly until: string;
  /** The Bot's pending takeover request this control answers, if any. */
  readonly requestId: string | null;
}

/** A Bot waiting for a person to do one step in its browser. */
export interface Handover {
  /** What the Bot needs done, in its words. */
  readonly reason: string;
  readonly url: string | null;
  readonly at: string;
  /** The thread holding the Bot's request. */
  readonly room: string;
  /** The request's id in the Bot's own session; the thread's copy adds a task prefix. */
  readonly requestId: string;
  readonly jobId: string | null;
  /** The Bot that asked. Older records may lack it; `jobId` still says whose it was. */
  readonly botId?: string;
}

export interface ScreenAllocation {
  readonly n: number;
  readonly workspaceId: string;
  /** The Bot (or HQ) that last used the team's screen. */
  readonly botId: string;
  readonly allocatedAt: string;
  readonly lastUsedAt: string;
  readonly browser: { readonly state: ServiceState; readonly at: string; readonly detail?: string };
  readonly control: ScreenControl | null;
  readonly posterAt: string | null;
  /** Whose tab the latest still frame shows, so HQ and idle Bots still have one after runs end. */
  readonly posterBotId?: string | null;
  readonly handover?: Handover | null;
  /** What the person said they did, handed to the Bot when it resumes. */
  readonly handoverNote?: string | null;
}

export interface ScreenTable {
  readonly computer: string;
  readonly screens: readonly ScreenAllocation[];
}

/** The id HQ uses when it is the one on the team's screen. */
export const HQ_SCREEN_USER = "hq";

/** Which Bot and screen a teammate session is working as. */
export interface SessionBinding {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly botId: string;
  readonly jobId: string;
  readonly n: number;
  readonly at: string;
  /** The Bot's own tab in the shared browser, once its first browser action opens it. */
  readonly targetId?: string;
  /** agent-browser's label for that tab, so a later action finds it again. */
  readonly tabLabel?: string;
}

/**
 * Which tab each Bot is working in, on the shared browser. The team's one
 * window holds a tab per running job; this says which is whose, so the console
 * can show a Bot its own tab and bring it to the front, and so a finished job's
 * tab is the one that gets closed. Kept next to the screen table, one document
 * per workspace, read without waking the computer.
 */
export interface BotTab {
  readonly targetId: string;
  readonly sessionId: string;
  readonly at: string;
}

const tabsKey = (workspaceId: string) => `computer/${COMPUTER_NAME}/tabs/${workspaceId}.json`;

export async function readBotTabs(workspaceId: string): Promise<Record<string, BotTab>> {
  return (await readDoc<Record<string, BotTab>>(tabsKey(workspaceId)))?.value ?? {};
}

export async function botTab(workspaceId: string, botId: string): Promise<BotTab | null> {
  return (await readBotTabs(workspaceId))[botId] ?? null;
}

export async function setBotTab(workspaceId: string, botId: string, tab: BotTab): Promise<void> {
  await updateDoc<Record<string, BotTab>>(tabsKey(workspaceId), (current) => ({ ...(current ?? {}), [botId]: tab }));
}

/** Forget a Bot's tab, but only if it is still the run that claimed it. */
export async function clearBotTab(workspaceId: string, botId: string, sessionId?: string): Promise<void> {
  await updateDoc<Record<string, BotTab>>(tabsKey(workspaceId), (current) => {
    if (current === null) return null;
    const held = current[botId];
    if (held === undefined || (sessionId !== undefined && held.sessionId !== sessionId)) return null;
    const { [botId]: _gone, ...rest } = current;
    return rest;
  });
}

export const MAX_SCREENS = Math.min(9, Math.max(1, Number(process.env.BOT_COMPUTER_MAX_SCREENS ?? 4)));

/** Everything on a screen listens on localhost only; websockify is the way in. */
export const screenPorts = (n: number) => ({
  display: `:${n}`,
  vnc: 5900 + n,
  cdp: 9300 + n,
  terminal: 7000 + n,
});

const TABLE_KEY = `computer/${COMPUTER_NAME}/screens.json`;
const bindingKey = (workspaceId: string, sessionId: string) => `sessions/${workspaceId}/${sessionId}.json`;

const now = () => new Date().toISOString();
const emptyTable = (): ScreenTable => ({ computer: COMPUTER_NAME, screens: [] });

export async function readScreens(): Promise<ScreenTable> {
  return (await readDoc<ScreenTable>(TABLE_KEY))?.value ?? emptyTable();
}

/**
 * The workspace's screen among the table's rows. A table from before screens
 * were shared holds one per Bot; the most recently used one becomes the team's,
 * and the rest go idle until another workspace reclaims them.
 */
export function workspaceScreen(table: ScreenTable, workspaceId: string): ScreenAllocation | null {
  return (
    [...table.screens]
      .filter((screen) => screen.workspaceId === workspaceId)
      .sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt))[0] ?? null
  );
}

/** The workspace's screen, if it has one yet. */
export async function teamScreen(workspaceId: string): Promise<ScreenAllocation | null> {
  return workspaceScreen(await readScreens(), workspaceId);
}

/**
 * The team's screen, allocating one if the workspace has none. A Bot starting
 * work passes its id, so the screen says who is using it; a person opening it
 * from the console leaves that as it is. With every screen taken, the least
 * recently used screen that nobody is controlling moves to this workspace.
 */
export async function allocateScreen(workspaceId: string, botId?: string): Promise<ScreenAllocation> {
  const outcome: { screen: ScreenAllocation | null } = { screen: null };
  await updateDoc<ScreenTable>(TABLE_KEY, (current) => {
    const table = current ?? emptyTable();
    const at = now();
    const mine = workspaceScreen(table, workspaceId);
    if (mine !== null) {
      outcome.screen = { ...mine, botId: botId ?? mine.botId, lastUsedAt: at };
      return replace(table, outcome.screen);
    }

    const taken = new Set(table.screens.map((screen) => screen.n));
    const free = Array.from({ length: MAX_SCREENS }, (_, index) => index + 1).find((n) => !taken.has(n));
    const reclaim =
      free === undefined
        ? [...table.screens]
            .filter((screen) => screen.control === null)
            .sort((left, right) => left.lastUsedAt.localeCompare(right.lastUsedAt))[0]
        : undefined;
    const n = free ?? reclaim?.n;
    if (n === undefined) {
      outcome.screen = null;
      return null;
    }

    outcome.screen = {
      n,
      workspaceId,
      botId: botId ?? HQ_SCREEN_USER,
      allocatedAt: at,
      lastUsedAt: at,
      // A reclaimed screen keeps its running browser; its state carries over.
      browser: reclaim?.browser ?? { state: "off", at },
      control: null,
      posterAt: null,
      posterBotId: null,
      handover: null,
      handoverNote: null,
    };
    return {
      ...table,
      screens: [...table.screens.filter((screen) => screen.n !== n), outcome.screen].sort((a, b) => a.n - b.n),
    };
  });
  if (outcome.screen === null) {
    throw new Error("Every screen on the computer is under someone's control right now. Try again in a minute.");
  }
  return outcome.screen;
}

export function touchScreen(n: number): Promise<void> {
  return patchScreen(n, (screen) => ({ ...screen, lastUsedAt: now() }));
}

export function setBrowserState(n: number, state: ServiceState, detail?: string): Promise<void> {
  return patchScreen(n, (screen) => ({
    ...screen,
    browser: { state, at: now(), ...(detail === undefined ? {} : { detail: detail.slice(0, 300) }) },
  }));
}

export function setPosterAt(n: number, at: string, botId?: string): Promise<void> {
  return patchScreen(n, (screen) => ({ ...screen, posterAt: at, ...(botId === undefined ? {} : { posterBotId: botId }) }));
}

export function setControl(n: number, control: ScreenControl | null): Promise<void> {
  return patchScreen(n, (screen) => ({ ...screen, control, lastUsedAt: now() }));
}

export function setHandover(n: number, handover: Handover | null): Promise<void> {
  return patchScreen(n, (screen) => ({ ...screen, handover, ...(handover === null ? {} : { handoverNote: null }) }));
}

export function setHandoverNote(n: number, note: string | null): Promise<void> {
  return patchScreen(n, (screen) => ({ ...screen, handoverNote: note }));
}

/** Ends a handover once the Bot has resumed, returning what the person said. */
export async function finishHandover(n: number): Promise<string | null> {
  const outcome: { note: string | null } = { note: null };
  await updateDoc<ScreenTable>(TABLE_KEY, (current) => {
    const screen = current?.screens.find((entry) => entry.n === n);
    if (current === null || screen === undefined) return null;
    outcome.note = screen.handoverNote ?? null;
    if ((screen.handover ?? null) === null && outcome.note === null) return null;
    return replace(current, { ...screen, handover: null, handoverNote: null });
  });
  return outcome.note;
}

/** Clears handovers whose requests were answered. Thread copies of an id carry a task prefix. */
export async function clearHandovers(workspaceId: string, answeredIds: readonly string[]): Promise<void> {
  await updateDoc<ScreenTable>(TABLE_KEY, (current) => {
    if (current === null) return null;
    let changed = false;
    const screens = current.screens.map((screen) => {
      const id = screen.handover?.requestId;
      if (screen.workspaceId !== workspaceId || id === undefined) return screen;
      if (!answeredIds.some((answered) => answered === id || answered.endsWith(`:${id}`))) return screen;
      changed = true;
      return { ...screen, handover: null };
    });
    return changed ? { ...current, screens } : null;
  });
}

/** An operator's control lapses on its own if the console stops renewing it. */
export function liveControl(screen: ScreenAllocation): ScreenControl | null {
  return screen.control !== null && Date.parse(screen.control.until) > Date.now() ? screen.control : null;
}

/**
 * A retired Bot leaves the team's screen as it is — the browser and its
 * sign-ins belong to the team — but a handover it was waiting on is over.
 */
export async function forgetBot(workspaceId: string, botId: string): Promise<void> {
  await updateDoc<ScreenTable>(TABLE_KEY, (current) => {
    if (current === null) return null;
    const screen = workspaceScreen(current, workspaceId);
    if (screen === null || !handoverBelongsTo(screen.handover ?? null, botId)) return null;
    return replace(current, { ...screen, handover: null, handoverNote: null });
  });
}

/** Whether a handover on the team's screen is this Bot's. */
export function handoverBelongsTo(handover: Handover | null, botId: string, jobIds: readonly string[] = []): boolean {
  if (handover === null) return false;
  if (handover.botId !== undefined) return handover.botId === botId;
  return handover.jobId !== null && jobIds.includes(handover.jobId);
}

async function patchScreen(n: number, patch: (screen: ScreenAllocation) => ScreenAllocation): Promise<void> {
  await updateDoc<ScreenTable>(TABLE_KEY, (current) => {
    const screen = current?.screens.find((entry) => entry.n === n);
    if (current === null || screen === undefined) return null;
    return replace(current, patch(screen));
  });
}

function replace(table: ScreenTable, screen: ScreenAllocation): ScreenTable {
  return { ...table, screens: table.screens.map((entry) => (entry.n === screen.n ? screen : entry)) };
}

const bindings = new Map<string, SessionBinding>();

export async function bindSession(binding: Omit<SessionBinding, "at">): Promise<SessionBinding> {
  const stored: SessionBinding = { ...binding, at: now() };
  bindings.set(binding.sessionId, stored);
  await writeDoc(bindingKey(binding.workspaceId, binding.sessionId), stored);
  return stored;
}

/** The Bot and screen a teammate session works as, set by `job_brief`. */
export async function sessionBinding(workspaceId: string, sessionId: string): Promise<SessionBinding | null> {
  const cached = bindings.get(sessionId);
  if (cached !== undefined) return cached;
  const stored = (await readDoc<SessionBinding>(bindingKey(workspaceId, sessionId)))?.value ?? null;
  if (stored !== null) bindings.set(sessionId, stored);
  return stored;
}
