import { type Experimental_EvaluationQuestion as EvaluationQuestion, generateText, Output } from "ai";
import { z } from "zod";

import { confidenceFloor, jevEnabled, judge, type Judgement, spent } from "../jev";
import { probabilityOf, readVerdict } from "../jev-watch";
import { customEndpoint, endpointModel, modelForEffort } from "../models";
import { recordUsage } from "../usage";
import { nearest } from "./rank";
import {
  acceptable,
  applyOperations,
  confirm,
  type FieldChange,
  fieldFor,
  FIELDS,
  isMemoryKind,
  liveEntries,
  looksSecret,
  type MemoryEntry,
  type MemoryFieldValue,
  type MemoryOperation,
  type MemorySlot,
  type MemorySource,
  normalize,
  readEntries,
  readFields,
  readForgotten,
  resolveField,
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

/**
 * Where an exchange came from: a person talking to HQ, a job's transcript, a
 * person sending a job back with a note, or a person declining an action a
 * Bot asked approval for. The last two are the strongest signals a person
 * gives, and they arrive without anyone saying "remember".
 */
export type CaptureMode = "conversation" | "job" | "feedback" | "denial";

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
/** The typed core as it stands, by slot then field key. */
export type Fields = Readonly<Partial<Record<MemorySlot, Readonly<Record<string, MemoryFieldValue>>>>>;

export type Judge = (
  state: unknown,
  questions: Record<string, EvaluationQuestion>,
  options: { readonly timeoutMs?: number; readonly workspaceId?: string; readonly abortSignal?: AbortSignal },
) => Promise<Judgement<Record<string, EvaluationQuestion>> | null>;

export type Extract = (input: CaptureInput, existing: Existing, fields: Fields) => Promise<readonly Proposal[]>;

export interface CaptureDeps {
  /** Null when Jev is unavailable; the cue gate stands in. */
  readonly judge: Judge | null;
  readonly extract: Extract;
  readonly floor: number;
  readonly existing: (slot: MemorySlot) => Promise<readonly MemoryEntry[]>;
  /** The typed core of a slot; absent means empty. */
  readonly fields?: (slot: MemorySlot) => Promise<Readonly<Record<string, MemoryFieldValue>>>;
  /** What a person forgot by hand; a new entry that says the same thing is not kept. Absent means nothing. */
  readonly forgotten?: (slot: MemorySlot) => Promise<readonly { readonly text: string }[]>;
  /** The person said an existing entry again: it grows surer. Defaults to the store's own. */
  readonly confirm?: (slot: MemorySlot, ids: readonly string[]) => Promise<void>;
}

type Placed = MemoryEntry & { readonly slot: MemorySlot };

export interface CaptureResult {
  readonly gate: "jev" | "cues" | "closed";
  readonly proposed: number;
  readonly saved: readonly Placed[];
  readonly updated: readonly Placed[];
  readonly retired: readonly Placed[];
  readonly fields: readonly (FieldChange & { readonly slot: MemorySlot })[];
  /** Existing entries the person said again, now surer. */
  readonly confirmed: readonly string[];
  /** How many changes the extractor returned before any were filtered out. */
  readonly raw?: number;
  /** Why the extractor produced nothing, when it failed rather than found nothing. */
  readonly error?: string;
}

const NOTHING: CaptureResult = { gate: "closed", proposed: 0, saved: [], updated: [], retired: [], fields: [], confirmed: [] };
const MIN_PERSON_CHARS = 12;
const MAX_PROPOSALS = 6;
/** How much of a slot the extractor sees: all of a small slot, the nearest of a large one. */
const EXISTING_SHOWN = 60;

export const slotsFor = (mode: CaptureMode): readonly MemorySlot[] => (mode === "conversation" || mode === "feedback" ? ["profile", "team"] : ["craft"]);

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
  if (mode === "feedback") {
    return {
      worth: boolean(
        "A person sent a finished job back with this note. Does the note say how they want work done in general (format, length, tone, what to include, who to involve), rather than only what to fix in this one job?",
        "The note states a preference or rule that applies to future work.",
        "The note only corrects this job.",
      ),
    };
  }
  if (mode === "denial") {
    return {
      worth: boolean(
        "A person declined an action a Bot asked approval for. Does the decline imply a standing rule about what Bots must not do, or must ask before doing, in this workspace, rather than a one-off no for this job?",
        "It implies a standing rule.",
        "It was a one-off decision about this job.",
      ),
    };
  }
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
export function validationQuestions(proposals: readonly Proposal[], existing: Existing, mode: CaptureMode, fields: Fields = {}): Record<string, EvaluationQuestion> {
  const questions: Record<string, EvaluationQuestion> = {};
  const textOf = (proposal: Proposal) =>
    proposal.op === "retire" || proposal.op === "confirm" ? (existing[proposal.slot] ?? []).find((entry) => entry.id === proposal.id)?.text ?? "" : proposal.op === "set" ? proposal.value : proposal.text;
  proposals.forEach((proposal, index) => {
    if (proposal.op === "confirm") return;
    if (proposal.op === "set") {
      const label = fieldFor(proposal.slot, proposal.field)?.label ?? proposal.field;
      const before = fields[proposal.slot]?.[proposal.field]?.value;
      questions[`current${index}`] = boolean(
        before === undefined
          ? `Did the person state, or make clear, that their ${label} is "${proposal.value}"?`
          : `Did the person state, or make clear, that their ${label} is now "${proposal.value}" rather than "${before}"?`,
        "Yes, that is what the person conveyed about themselves or their team.",
        "No: the person did not say that, or it is a guess.",
      );
      questions[`safe${index}`] = boolean(
        `Is this free of anything secret, such as a password, code, key, token, or card number: "${proposal.value}"`,
        "It contains nothing secret.",
        "It contains something that looks secret.",
      );
      return;
    }
    if (proposal.op === "add") {
      questions[`durable${index}`] = boolean(
        `Will this still be true and useful next month, rather than being about one task or one moment: "${proposal.text}"`,
        "It is durable.",
        "It is a one-off detail.",
      );
      questions[`about${index}`] =
        mode === "conversation" || mode === "feedback"
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
    } else if (isMigration(proposal)) {
      const set = proposals.filter((other): other is Proposal & { op: "set" } => other.op === "set" && other.slot === proposal.slot);
      const now = [...set.map((other) => `${fieldFor(other.slot, other.field)?.label ?? other.field}: ${other.value}`), ...Object.entries(fields[proposal.slot] ?? {}).map(([key, value]) => `${fieldFor(proposal.slot, key)?.label ?? key}: ${value.value}`)];
      questions[`gone${index}`] = boolean(
        `With these fields on record (${now.join("; ") || "none"}), does this note add nothing beyond them, so it is redundant: "${textOf(proposal)}"`,
        "Yes: everything the note says is in the fields.",
        "No: the note says something the fields do not.",
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

/** A retirement that only moves a note's content into the fields, rather than saying it stopped being true. */
const isMigration = (proposal: Proposal): proposal is Proposal & { op: "retire" } => proposal.op === "retire" && /\bnow (the |a )?\w[\w ,]* fields?\b/i.test(proposal.reason);

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
    // Feedback and denials are signals in themselves; a conversation needs cue words, a transcript some substance.
    const open = input.mode === "conversation" ? cues(person) : input.mode === "job" ? input.reply.length > 400 : true;
    if (!open) return NOTHING;
    gate = "cues";
  }

  // 2. What is already remembered, and what would we change?
  const slots = slotsFor(input.mode);
  const existing: Partial<Record<MemorySlot, readonly MemoryEntry[]>> = {};
  const fields: Partial<Record<MemorySlot, Readonly<Record<string, MemoryFieldValue>>>> = {};
  for (const slot of slots) {
    existing[slot] = existingFor(await deps.existing(slot), `${person}\n${input.reply}`);
    fields[slot] = deps.fields === undefined ? {} : await deps.fields(slot);
  }
  let proposals: Proposal[];
  let raw = 0;
  try {
    const returned = await deps.extract(input, existing, fields);
    raw = returned.length;
    proposals = returned
      .filter((proposal) => slots.includes(proposal.slot))
      .map((proposal) => {
        if (proposal.op === "retire" || proposal.op === "confirm") return proposal;
        if (proposal.op === "set") {
          // Models name fields loosely; settle on the key before anything compares it.
          const field = resolveField(proposal.slot, proposal.field);
          return { ...proposal, field: field?.key ?? proposal.field, value: normalize(proposal.value) };
        }
        return { ...proposal, text: normalize(proposal.text) };
      })
      .filter((proposal) => {
        if (proposal.op === "confirm") return (existing[proposal.slot] ?? []).some((entry) => entry.id === proposal.id);
        if (proposal.op === "set") {
          return fieldFor(proposal.slot, proposal.field) !== undefined && proposal.value !== "" && !looksSecret(proposal.value) && (fields[proposal.slot]?.[proposal.field]?.value ?? "") !== proposal.value;
        }
        if (proposal.op === "add") return isMemoryKind(proposal.kind) && acceptable(proposal).ok;
        const target = (existing[proposal.slot] ?? []).find((entry) => entry.id === proposal.id);
        if (target === undefined) return false;
        return proposal.op === "retire" ? normalize(proposal.reason) !== "" : acceptable({ text: proposal.text, kind: proposal.kind ?? target.kind }).ok;
      })
      .slice(0, MAX_PROPOSALS);
  } catch (error) {
    return { ...NOTHING, gate, error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : String(error).slice(0, 300) };
  }
  if (proposals.length === 0) return { ...NOTHING, gate, raw };
  const proposed = proposals.length;

  // 3. Is each change right: durable, on topic and safe for a new entry; a real supersession; a real retraction?
  if (ask !== null) {
    const judgement = await ask({ person: person.slice(0, 4_000), changes: proposals.map(describeProposal) }, validationQuestions(proposals, existing, input.mode, fields));
    const answers = (judgement?.answers ?? {}) as Record<string, unknown>;
    proposals = proposals
      .filter((proposal, index) => {
        if (proposal.op === "confirm") return true;
        const facets = proposal.op === "add" ? ["durable", "about", "safe"] : proposal.op === "update" ? ["supersedes", "safe"] : proposal.op === "set" ? ["current", "safe"] : ["gone"];
        // Something new (an entry, or a field with no value yet) is kept unless Jev says no; a change to what is stored needs a clear yes.
        const fresh = proposal.op === "add" || (proposal.op === "set" && fields[proposal.slot]?.[proposal.field] === undefined);
        return facets.every((facet) => {
          const { verdict } = readVerdict(judgement, `${facet}${index}`, deps.floor);
          return fresh ? verdict !== "no" : verdict === "yes";
        });
      })
      .map((proposal) => {
        // How sure to be of a new or reworded entry: what Jev thought of its substance, not of its safety.
        if (proposal.op !== "add" && proposal.op !== "update") return proposal;
        const index = proposals.indexOf(proposal);
        const facets = proposal.op === "add" ? ["durable", "about"] : ["supersedes"];
        const probabilities = facets.map((facet) => probabilityOf(answers[`${facet}${index}`])).filter((value): value is number => value !== undefined);
        return probabilities.length === 0 ? proposal : { ...proposal, confidence: probabilities.reduce((sum, value) => sum + value, 0) / probabilities.length };
      });
  } else {
    // Without Jev, only the extractor vouches for a change to what is stored; keep those to clear cases.
    proposals = proposals.filter((proposal) => proposal.op === "add" || proposal.op === "confirm" || (proposal.op === "set" && fields[proposal.slot]?.[proposal.field] === undefined) || cues(person));
  }

  // 4. Does the store already say a new entry, or did a person forget it by hand? A person's facts and
  //    their team's rules overlap, so both slots are checked; the same for what was forgotten.
  const adds = proposals.filter((proposal): proposal is Proposal & { op: "add" } => proposal.op === "add");
  const forgotten: MemoryEntry[] = [];
  if (deps.forgotten !== undefined) {
    for (const slot of slots) {
      for (const item of await deps.forgotten(slot)) {
        forgotten.push({ id: `forgotten:${forgotten.length}`, text: item.text, kind: "fact", source: { who: "you" }, at: "", pinned: false, recalls: 0, lastRecalledAt: null });
      }
    }
  }
  const pool = [...slots.flatMap((slot) => existing[slot] ?? []), ...forgotten];
  const pairs = adds.flatMap((proposal) => nearest(pool, proposal.text, 3).map((entry) => ({ proposal, existing: entry })));
  const confirmed: string[] = [];
  if (ask !== null && pairs.length > 0) {
    const judgement = await ask({ pairs: pairs.map((pair) => [pair.proposal.text, pair.existing.text]) }, duplicateQuestions(pairs));
    const same = pairs.filter((_, index) => readVerdict(judgement, `same${index}`, deps.floor).verdict === "yes");
    const duplicated = new Set(same.map((pair) => pair.proposal));
    proposals = proposals.filter((proposal) => !duplicated.has(proposal as Proposal & { op: "add" }));
    // Saying a stored thing again is a confirmation of it, not noise.
    const bySlot = new Map<MemorySlot, string[]>();
    for (const pair of same) {
      if (pair.existing.id.startsWith("forgotten:")) continue;
      const slot = pair.proposal.slot;
      bySlot.set(slot, [...(bySlot.get(slot) ?? []), pair.existing.id]);
      confirmed.push(pair.existing.id);
    }
    const confirmer = deps.confirm ?? ((slot: MemorySlot, ids: readonly string[]) => confirm(input.workspaceId, slot, ids));
    for (const [slot, ids] of bySlot) await confirmer(slot, ids).catch(() => undefined);
  }

  // 5. Apply, once per operation.
  const saved: Placed[] = [];
  const updated: Placed[] = [];
  const retired: Placed[] = [];
  const set: (FieldChange & { readonly slot: MemorySlot })[] = [];
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
    for (const change of outcome.fields) set.push({ ...change, slot });
    confirmed.push(...outcome.confirmed);
  }
  return { gate, proposed, raw, saved, updated, retired, fields: set, confirmed };
}

function describeProposal(proposal: Proposal): string {
  if (proposal.op === "add") return `add: ${proposal.text}`;
  if (proposal.op === "update") return `update ${proposal.id}: ${proposal.text}`;
  if (proposal.op === "set") return `set ${proposal.field} = ${proposal.value}`;
  if (proposal.op === "confirm") return `confirm ${proposal.id}`;
  return `retire ${proposal.id}: ${proposal.reason}`;
}

// ---------------------------------------------------------------------------
// The default dependencies: Jev when the Gateway is there, the quick model to extract.
// ---------------------------------------------------------------------------

const OPERATIONS_SCHEMA = z.object({
  changes: z
    .array(
      z.object({
        op: z.enum(["set", "add", "update", "retire", "confirm"]),
        slot: z.enum(["profile", "team", "craft"]),
        field: z.string().optional().describe("For set: the field key, exactly as listed."),
        value: z.string().optional().describe("For set: the field's new value, short."),
        id: z.string().optional().describe("For update, retire and confirm: the id of the existing memory, exactly as listed."),
        text: z.string().optional().describe("For add and update: one short standalone sentence, in the third person."),
        kind: z.enum(["preference", "fact", "rule", "lesson"]).optional(),
        reason: z.string().optional().describe("For retire: what the person said that makes it no longer true."),
      }),
    )
    .max(MAX_PROPOSALS),
});

const SYSTEM: Record<CaptureMode, string> = {
  feedback: [
    "You maintain the durable memory of an AI coordinator about the person it works for and their team. A person has sent a finished job back with a note saying what to change.",
    "You are given what is already remembered: fields with their current values, and notes each with an id. Return the changes the note calls for, and nothing else:",
    "- set: a field's value the note makes clear (length, tone, spelling, date or time format, who approves what, who to copy). Prefer set whenever a field fits.",
    "- add: a preference or rule about how work should be done that will apply to future jobs, phrased generally ('Wants reports to open with the number that changed.'), not the fix for this job.",
    "- update: an existing memory the note shows has moved on. Give the id and the full new sentence.",
    "- retire: an existing memory the note contradicts. Give the id and the reason.",
    "Never keep what is specific to this one job, and never anything secret.",
    "slot 'profile' is about the person; slot 'team' is about how the team works. Return an empty list when the note only fixes this job.",
  ].join("\n"),
  denial: [
    "You maintain the durable lessons an AI teammate keeps about working in the operator's workspace. A person declined an action the teammate asked approval for.",
    "You are given what is already remembered, each line with an id. Return the changes the decline calls for, and nothing else:",
    "- add: a standing rule about what Bots must not do, or must ask before doing, that the decline makes clear ('Never send mail to customers without a person reading it first.'). Phrase it as a rule, not as a record of this decline.",
    "- update or retire an existing lesson only when the decline shows it wrong.",
    "Most declines are one-off decisions about one job: return an empty list for those. Always use slot 'craft' and kind 'rule'.",
  ].join("\n"),
  conversation: [
    "You maintain the durable memory of an AI coordinator about the person it works for and their team, from one exchange.",
    "You are given what is already remembered: fields with their current values, and notes each with an id. Return the changes the exchange calls for, and nothing else:",
    "- set: a field's value, when the person stated or clearly implied it (their name, company, location, timezone, spelling, date or time format, who approves what, where tickets live, and so on). Setting a field that already has a value replaces it. Prefer set over add whenever a field fits, and set a field that is (unset) even when a note already says the same thing: fields are where these facts belong. Use the field keys exactly as listed.",
    "- add: something new the PERSON stated or clearly implied about themselves or their team that fits no field and will still be true next month (a preference about how work should be done, a fact about them, a standing rule).",
    "- update: an existing memory whose truth moved on ('now five bullets, not three') or that this exchange makes more precise. Give the existing id and the full new sentence.",
    "- retire: an existing memory the person said is no longer true, or a note that only restates a field you are setting in this same answer (reason: 'now the <field> field'). Give the id and the reason. Never retire a note merely because it was confirmed again.",
    "Never add one-off requests, the details of a task, opinions of the assistant, or anything secret: passwords, codes, keys, tokens, card numbers.",
    "- confirm: an existing note the person said again, in the same or other words. Give the id. Never add what is already remembered in other words; confirm it.",
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

const renderExisting = (existing: Existing, fields: Fields): string =>
  Object.entries(existing)
    .map(([slot, entries]) => {
      const defined = FIELDS[slot as MemorySlot];
      const values = fields[slot as MemorySlot] ?? {};
      const fieldLines = defined.map((field) => `- ${field.key} (${field.hint}): ${values[field.key]?.value ?? "(unset)"}`);
      return [
        `## ${slot}`,
        ...(defined.length === 0 ? [] : ["fields:", ...fieldLines]),
        "notes:",
        entries.length === 0 ? "(none yet)" : entries.map((entry) => `- ${entry.id} [${entry.kind}]: ${entry.text}`).join("\n"),
      ].join("\n");
    })
    .join("\n\n");

/** Proposes changes with the quick model, and counts what that cost. */
export const modelExtract: Extract = async (input, existing, fields) => {
  const model = extractionModel();
  const result = await generateText({
    model,
    output: Output.object({ schema: OPERATIONS_SCHEMA }),
    system: SYSTEM[input.mode],
    prompt: [
      "# Already remembered",
      renderExisting(existing, fields),
      "",
      input.mode === "conversation" ? "# What the person said" : input.mode === "feedback" ? "# The person's note on the finished job" : input.mode === "denial" ? "# What the person declined" : "# The brief",
      input.person.slice(0, 6_000),
      "",
      input.mode === "conversation" ? "# What the coordinator replied" : input.mode === "feedback" ? "# The job and the result that was sent back" : input.mode === "denial" ? "# The job the Bot was doing" : "# What happened",
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
    if (change.op === "set" && change.field !== undefined && change.value !== undefined) return [{ op: "set", slot: change.slot, field: change.field, value: change.value }];
    if (change.op === "confirm" && change.id !== undefined) return [{ op: "confirm", slot: change.slot, id: change.id }];
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
    fields: (slot) => readFields(workspaceId, slot),
    forgotten: (slot) => readForgotten(workspaceId, slot),
  };
}

/** How sure Jev must be before a memory is kept; `BOT_MEMORY_FLOOR`, else Jev's own floor. */
export function memoryFloor(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.BOT_MEMORY_FLOOR);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : confidenceFloor(env);
}
