import { type Experimental_EvaluationQuestion as EvaluationQuestion, generateText, Output } from "ai";
import { z } from "zod";

import { confidenceFloor, jevEnabled, judge, type Judgement, spent } from "../jev";
import { readVerdict } from "../jev-watch";
import { customEndpoint, endpointModel, modelForEffort } from "../models";
import { recordUsage } from "../usage";
import { nearest } from "./rank";
import {
  acceptable,
  applyOperations,
  isMemoryKind,
  liveEntries,
  type MemoryEntry,
  type MemoryOperation,
  type MemorySlot,
  type MemorySource,
  normalize,
  readEntries,
} from "./store";

/**
 * Remembering without being asked, and keeping what is remembered true.
 *
 * After a turn, in order, cheapest first. Jev, which answers as a probability
 * for a fraction of a cent, is the gatekeeper: is there anything here worth
 * keeping at all? Only then does the quick model read the exchange, next to
 * what is already remembered, and propose changes: new entries, entries to
 * reword because the person's preference moved on, entries to retire because
 * they are no longer true. Jev judges each change (a new entry must be
 * durable, on topic and free of secrets; a rewording must really supersede;
 * a retirement must really have been said), and whether a new entry repeats
 * one already there. What survives is written with where it came from, and
 * a reworded entry keeps its earlier wording in its history.
 *
 * Without a Gateway there is no Jev. The gate then falls back to cues in the
 * wording, and the changes go through on the extractor's judgement alone.
 * Memory that only worked on Vercel would not be first class.
 */

export type CaptureMode = "conversation" | "job";

/** A change the extractor proposes, with the slot it belongs to. */
export type Proposal = MemoryOperation & { readonly slot: MemorySlot };

export interface CaptureInput {
  readonly workspaceId: string;
  readonly mode: CaptureMode;
  /** What the person said (a conversation), or the brief (a job). */
  readonly person: string;
  /** What came back: the reply, or the job's transcript tail. */
  readonly reply: string;
  readonly source: MemorySource;
  readonly operationId: string;
  readonly abortSignal?: AbortSignal;
}

/** What the extractor may change: the live entries of the slots this mode writes to. */
export type Existing = Readonly<Partial<Record<MemorySlot, readonly MemoryEntry[]>>>;

export type Judge = (
  state: unknown,
  questions: Record<string, EvaluationQuestion>,
  options: { readonly timeoutMs?: number; readonly workspaceId?: string; readonly abortSignal?: AbortSignal },
) => Promise<Judgement<Record<string, EvaluationQuestion>> | null>;

export type Extract = (input: CaptureInput, existing: Existing) => Promise<readonly Proposal[]>;

export interface CaptureDeps {
  /** Null when Jev is unavailable; the cue gate stands in. */
  readonly judge: Judge | null;
  readonly extract: Extract;
  readonly floor: number;
  readonly existing: (slot: MemorySlot) => Promise<readonly MemoryEntry[]>;
}

type Placed = MemoryEntry & { readonly slot: MemorySlot };

export interface CaptureResult {
  readonly gate: "jev" | "cues" | "closed";
  readonly proposed: number;
  readonly saved: readonly Placed[];
  readonly updated: readonly Placed[];
  readonly retired: readonly Placed[];
}

const NOTHING: CaptureResult = { gate: "closed", proposed: 0, saved: [], updated: [], retired: [] };
const MIN_PERSON_CHARS = 12;
const MAX_PROPOSALS = 6;
/** How much of a slot the extractor sees: all of a small slot, the nearest of a large one. */
const EXISTING_SHOWN = 60;

export const slotsFor = (mode: CaptureMode): readonly MemorySlot[] => (mode === "conversation" ? ["profile", "team"] : ["craft"]);

/** Words a person uses when they are telling you how they want things, not what to do now. */
const CUES =
  /\b(prefer|preference|always|never|from now on|going forward|in future|in the future|remember|forget|don'?t forget|no longer|not anymore|any ?more|instead|actually|call me|my name|i am|i'm|we are|we're|our (team|company|policy|rule)|usually|typically|every (week|month|day|friday|monday|tuesday|wednesday|thursday)|cc\b|timezone|time zone|format|style|tone|rule|moved|changed)\b/i;

export const cues = (text: string): boolean => CUES.test(text);

const boolean = (instructions: string, yes: string, no: string): EvaluationQuestion => ({
  type: "boolean",
  instructions,
  criteria: { true: yes, false: no },
});

export function gateQuestions(mode: CaptureMode): Record<string, EvaluationQuestion> {
  return {
    worth:
      mode === "conversation"
        ? boolean(
            "Does the person state something that will still matter in future conversations: a preference about how work should be done, a fact about themselves or their team, a standing rule, or a correction to one of those? A one-off request or task does not count.",
            "The person states a durable preference, fact, or standing rule, or corrects one.",
            "The person only asks for something, reacts, or gives one-off details.",
          )
        : boolean(
            "Does this job transcript reveal a durable lesson about the operator's systems or tools, such as where a control hides, which format works, or what a finished deliverable looks like here? Events of this one job do not count.",
            "The transcript reveals a lesson that will still be true next month.",
            "The transcript only shows this job's own events.",
          ),
  };
}

/** One set of questions for every proposal, each by its index; Jev charges for the input once. */
export function validationQuestions(proposals: readonly Proposal[], existing: Existing, mode: CaptureMode): Record<string, EvaluationQuestion> {
  const questions: Record<string, EvaluationQuestion> = {};
  const textOf = (proposal: Proposal) => (proposal.op === "retire" ? (existing[proposal.slot] ?? []).find((entry) => entry.id === proposal.id)?.text ?? "" : proposal.text);
  proposals.forEach((proposal, index) => {
    if (proposal.op === "add") {
      questions[`durable${index}`] = boolean(
        `Will this still be true and useful next month, rather than being about one task or one moment: "${proposal.text}"`,
        "It is durable.",
        "It is a one-off detail.",
      );
      questions[`about${index}`] =
        mode === "conversation"
          ? boolean(
              `Is this about the person or their team (who they are, how they like things, how they work), rather than about the assistant or a task: "${proposal.text}"`,
              "It is about the person or their team.",
              "It is about a task, the assistant, or the world at large.",
            )
          : boolean(
              `Is this a lesson about the operator's systems or tools that would help do a future job, rather than a record of what happened: "${proposal.text}"`,
              "It is a reusable lesson.",
              "It is a record of this job.",
            );
      questions[`safe${index}`] = boolean(
        `Is this free of anything secret, such as a password, code, key, token, or card number: "${proposal.text}"`,
        "It contains nothing secret.",
        "It contains something that looks secret.",
      );
    } else if (proposal.op === "update") {
      const before = (existing[proposal.slot] ?? []).find((entry) => entry.id === proposal.id)?.text ?? "";
      questions[`supersedes${index}`] = boolean(
        `Given what the person said, is B now the truth and A out of date, so that B should replace A? A: "${before}" B: "${proposal.text}"`,
        "B replaces A: the person's preference or situation moved on, or B is a more accurate wording.",
        "A still stands, or B is about something else and should be its own memory.",
      );
      questions[`safe${index}`] = boolean(
        `Is this free of anything secret, such as a password, code, key, token, or card number: "${proposal.text}"`,
        "It contains nothing secret.",
        "It contains something that looks secret.",
      );
    } else {
      questions[`gone${index}`] = boolean(
        `Did the person say, or make clear, that this is no longer true: "${textOf(proposal)}" (reason given: ${proposal.reason})`,
        "Yes: the person said it no longer holds, or replaced it with something incompatible.",
        "No: the person did not say that; it may still hold.",
      );
    }
  });
  return questions;
}

export function duplicateQuestions(pairs: readonly { readonly proposal: Proposal & { op: "add" }; readonly existing: MemoryEntry }[]): Record<string, EvaluationQuestion> {
  const questions: Record<string, EvaluationQuestion> = {};
  pairs.forEach((pair, index) => {
    questions[`same${index}`] = boolean(
      `Do these two say the same thing, so keeping both would be a duplicate? A: "${pair.proposal.text}" B: "${pair.existing.text}"`,
      "They say the same thing.",
      "They say different things.",
    );
  });
  return questions;
}

/** The entries an extractor should see for one slot: all of a small slot, else the nearest to the exchange plus the newest. */
export function existingFor(entries: readonly MemoryEntry[], exchange: string): readonly MemoryEntry[] {
  const live = liveEntries(entries);
  if (live.length <= EXISTING_SHOWN) return live;
  const picked = new Map<string, MemoryEntry>();
  for (const entry of nearest(live, exchange, EXISTING_SHOWN / 2)) picked.set(entry.id, entry);
  for (const entry of [...live].sort((left, right) => right.at.localeCompare(left.at))) {
    if (picked.size >= EXISTING_SHOWN) break;
    picked.set(entry.id, entry);
  }
  return [...picked.values()];
}

/** Runs the pipeline. Never throws: a failure to remember is not a failure of the turn. */
export async function capture(input: CaptureInput, deps: CaptureDeps): Promise<CaptureResult> {
  const person = normalize(input.person);
  if (person.length < MIN_PERSON_CHARS) return NOTHING;
  const ask = deps.judge === null ? null : (state: unknown, questions: Record<string, EvaluationQuestion>) =>
    deps.judge!(state, questions, { timeoutMs: 6_000, workspaceId: input.workspaceId, abortSignal: input.abortSignal });

  // 1. Is there anything here at all?
  let gate: CaptureResult["gate"] = "closed";
  if (ask !== null) {
    const judgement = await ask({ person: person.slice(0, 4_000), reply: normalize(input.reply).slice(0, 2_000) }, gateQuestions(input.mode));
    const { verdict } = readVerdict(judgement, "worth", deps.floor);
    if (verdict === "no") return NOTHING;
    if (verdict === "yes") gate = "jev";
  }
  if (gate === "closed") {
    const open = input.mode === "conversation" ? cues(person) : input.reply.length > 400;
    if (!open) return NOTHING;
    gate = "cues";
  }

  // 2. What is already remembered, and what would we change?
  const slots = slotsFor(input.mode);
  const existing: Partial<Record<MemorySlot, readonly MemoryEntry[]>> = {};
  for (const slot of slots) existing[slot] = existingFor(await deps.existing(slot), `${person}\n${input.reply}`);
  let proposals: Proposal[];
  try {
    proposals = (await deps.extract(input, existing))
      .filter((proposal) => slots.includes(proposal.slot))
      .map((proposal) => (proposal.op === "retire" ? proposal : { ...proposal, text: normalize(proposal.text) }))
      .filter((proposal) => {
        if (proposal.op === "add") return isMemoryKind(proposal.kind) && acceptable(proposal).ok;
        const target = (existing[proposal.slot] ?? []).find((entry) => entry.id === proposal.id);
        if (target === undefined) return false;
        return proposal.op === "retire" ? normalize(proposal.reason) !== "" : acceptable({ text: proposal.text, kind: proposal.kind ?? target.kind }).ok;
      })
      .slice(0, MAX_PROPOSALS);
  } catch {
    return { ...NOTHING, gate };
  }
  if (proposals.length === 0) return { ...NOTHING, gate };
  const proposed = proposals.length;

  // 3. Is each change right: durable, on topic and safe for a new entry; a real supersession; a real retraction?
  if (ask !== null) {
    const judgement = await ask({ person: person.slice(0, 4_000), changes: proposals.map(describeProposal) }, validationQuestions(proposals, existing, input.mode));
    proposals = proposals.filter((proposal, index) => {
      const facets = proposal.op === "add" ? ["durable", "about", "safe"] : proposal.op === "update" ? ["supersedes", "safe"] : ["gone"];
      return facets.every((facet) => {
        const { verdict } = readVerdict(judgement, `${facet}${index}`, deps.floor);
        // A change to what is stored needs a clear yes; a new entry is kept unless Jev says no.
        return proposal.op === "add" ? verdict !== "no" : verdict === "yes";
      });
    });
  } else {
    // Without Jev, only the extractor vouches for a change to what is stored; keep those to clear cases.
    proposals = proposals.filter((proposal) => proposal.op === "add" || cues(person));
  }

  // 4. Does the store already say a new entry? A person's facts and their team's rules overlap, so both slots are checked.
  const adds = proposals.filter((proposal): proposal is Proposal & { op: "add" } => proposal.op === "add");
  const pool = slots.flatMap((slot) => existing[slot] ?? []);
  const pairs = adds.flatMap((proposal) => nearest(pool, proposal.text, 3).map((entry) => ({ proposal, existing: entry })));
  if (ask !== null && pairs.length > 0) {
    const judgement = await ask({ pairs: pairs.map((pair) => [pair.proposal.text, pair.existing.text]) }, duplicateQuestions(pairs));
    const duplicated = new Set(pairs.filter((_, index) => readVerdict(judgement, `same${index}`, deps.floor).verdict === "yes").map((pair) => pair.proposal));
    proposals = proposals.filter((proposal) => !duplicated.has(proposal as Proposal & { op: "add" }));
  }

  // 5. Apply, once per operation.
  const saved: Placed[] = [];
  const updated: Placed[] = [];
  const retired: Placed[] = [];
  for (const slot of new Set(proposals.map((proposal) => proposal.slot))) {
    const outcome = await applyOperations(
      input.workspaceId,
      slot,
      proposals.filter((proposal) => proposal.slot === slot).map(({ slot: _slot, ...operation }) => operation),
      input.source,
      { operationId: `${input.operationId}:${slot}` },
    );
    for (const entry of outcome.added) saved.push({ ...entry, slot });
    for (const entry of outcome.updated) updated.push({ ...entry, slot });
    for (const entry of outcome.retired) retired.push({ ...entry, slot });
  }
  return { gate, proposed, saved, updated, retired };
}

function describeProposal(proposal: Proposal): string {
  if (proposal.op === "add") return `add: ${proposal.text}`;
  if (proposal.op === "update") return `update ${proposal.id}: ${proposal.text}`;
  return `retire ${proposal.id}: ${proposal.reason}`;
}

// ---------------------------------------------------------------------------
// The default dependencies: Jev when the Gateway is there, the quick model to extract.
// ---------------------------------------------------------------------------

const OPERATIONS_SCHEMA = z.object({
  changes: z
    .array(
      z.object({
        op: z.enum(["add", "update", "retire"]),
        slot: z.enum(["profile", "team", "craft"]),
        id: z.string().optional().describe("For update and retire: the id of the existing memory, exactly as listed."),
        text: z.string().optional().describe("For add and update: one short standalone sentence, in the third person."),
        kind: z.enum(["preference", "fact", "rule", "lesson"]).optional(),
        reason: z.string().optional().describe("For retire: what the person said that makes it no longer true."),
      }),
    )
    .max(MAX_PROPOSALS),
});

const SYSTEM: Record<CaptureMode, string> = {
  conversation: [
    "You maintain the durable memory of an AI coordinator about the person it works for and their team, from one exchange.",
    "You are given what is already remembered, each line with an id. Return the changes the exchange calls for, and nothing else:",
    "- add: something new the PERSON stated or clearly implied about themselves or their team that will still be true next month (a preference about how work should be done, a fact about them, a standing rule).",
    "- update: an existing memory whose truth moved on ('now five bullets, not three') or that this exchange makes more precise. Give the existing id and the full new sentence.",
    "- retire: an existing memory the person said is no longer true. Give the id and the reason.",
    "Never add one-off requests, the details of a task, opinions of the assistant, or anything secret: passwords, codes, keys, tokens, card numbers.",
    "Never add what is already remembered in other words; update or leave it.",
    "Write each sentence short, in the third person, e.g. 'Prefers summaries as three bullets.' or 'Their company is Acme Robotics.'",
    "slot 'profile' is about the person; slot 'team' is about how the team or workspace works. Never use 'craft'.",
    "Return an empty list when nothing qualifies. Most exchanges qualify for nothing.",
  ].join("\n"),
  job: [
    "You maintain the durable lessons an AI teammate keeps about the operator's systems and tools, from the transcript of one job.",
    "You are given what is already remembered, each line with an id. Return the changes the transcript calls for, and nothing else:",
    "- add: a reusable lesson about the operator's systems: where a control or setting hides, which export or format works and which loses data, what a finished deliverable looks like here, which site needs a person to sign in.",
    "- update: an existing lesson this job showed to be imprecise or changed. Give the id and the full new sentence.",
    "- retire: an existing lesson this job showed to be wrong. Give the id and the reason.",
    "Never add what happened in this job, its results, the teammate's own tools, or anything secret.",
    "Write each lesson as one short imperative or factual sentence, e.g. 'Export the CRM report as CSV; the PDF drops rows.'",
    "Always use slot 'craft' and kind 'lesson'. Return an empty list when nothing qualifies.",
  ].join("\n"),
};

/** The model that reads exchanges: `BOT_MEMORY_MODEL`, else a fast small Gateway model, else the endpoint's quick model. */
export const DEFAULT_MEMORY_MODEL = "anthropic/claude-haiku-4-5";

function extractionModelId(): string {
  const named = process.env.BOT_MEMORY_MODEL?.trim();
  if (named) return named;
  return customEndpoint() === null ? DEFAULT_MEMORY_MODEL : modelForEffort("quick");
}

function extractionModel() {
  const id = extractionModelId();
  const endpoint = customEndpoint();
  return endpoint === null ? id : endpointModel(endpoint, id);
}

const renderExisting = (existing: Existing): string =>
  Object.entries(existing)
    .map(([slot, entries]) => `## ${slot}\n${entries.length === 0 ? "(nothing yet)" : entries.map((entry) => `- ${entry.id} [${entry.kind}]: ${entry.text}`).join("\n")}`)
    .join("\n\n");

/** Proposes changes with the quick model, and counts what that cost. */
export const modelExtract: Extract = async (input, existing) => {
  const model = extractionModel();
  const result = await generateText({
    model,
    output: Output.object({ schema: OPERATIONS_SCHEMA }),
    system: SYSTEM[input.mode],
    prompt: [
      "# Already remembered",
      renderExisting(existing),
      "",
      input.mode === "conversation" ? "# What the person said" : "# The brief",
      input.person.slice(0, 6_000),
      "",
      input.mode === "conversation" ? "# What the coordinator replied" : "# What happened",
      input.reply.slice(0, 6_000),
    ].join("\n"),
    maxRetries: 0,
    abortSignal: input.abortSignal ?? AbortSignal.timeout(45_000),
  });
  void recordUsage(input.workspaceId, "memory", spent(result.usage, result.providerMetadata, extractionModelId())).catch(
    () => undefined,
  );
  const changes = result.output?.changes ?? [];
  return changes.flatMap((change): Proposal[] => {
    if (change.op === "add" && change.text !== undefined) return [{ op: "add", slot: change.slot, text: change.text, kind: change.kind ?? (change.slot === "craft" ? "lesson" : "fact") }];
    if (change.op === "update" && change.id !== undefined && change.text !== undefined) return [{ op: "update", slot: change.slot, id: change.id, text: change.text, ...(change.kind === undefined ? {} : { kind: change.kind }) }];
    if (change.op === "retire" && change.id !== undefined) return [{ op: "retire", slot: change.slot, id: change.id, reason: change.reason ?? "the person said so" }];
    return [];
  });
};

export function defaultDeps(workspaceId: string): CaptureDeps {
  return {
    judge: jevEnabled() ? judge : null,
    extract: modelExtract,
    floor: memoryFloor(),
    existing: (slot) => readEntries(workspaceId, slot),
  };
}

/** How sure Jev must be before a memory is kept; `BOT_MEMORY_FLOOR`, else Jev's own floor. */
export function memoryFloor(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.BOT_MEMORY_FLOOR);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : confidenceFloor(env);
}
