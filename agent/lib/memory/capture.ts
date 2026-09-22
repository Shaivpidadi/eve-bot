import { type Experimental_EvaluationQuestion as EvaluationQuestion, generateText, Output } from "ai";
import { z } from "zod";

import { confidenceFloor, jevEnabled, judge, type Judgement, spent } from "../jev";
import { readVerdict } from "../jev-watch";
import { customEndpoint, endpointModel, modelForEffort } from "../models";
import { recordUsage } from "../usage";
import { nearest } from "./rank";
import { acceptable, isMemoryKind, type MemoryCandidate, type MemoryEntry, type MemorySlot, type MemorySource, normalize, readEntries, remember } from "./store";

/**
 * Remembering without being asked.
 *
 * After a turn, three questions in order, cheapest first. Jev, which answers
 * as a probability for a fraction of a cent, is the gatekeeper: is there
 * anything here worth keeping at all? Only then does the quick model read the
 * exchange and propose entries. Jev then judges each proposal (durable, about
 * the person rather than this task, not a secret) and whether it repeats
 * something already stored. What survives is written with where it came from.
 *
 * Without a Gateway there is no Jev. The gate then falls back to cues in the
 * wording, and the proposals go through on the extractor's judgement alone.
 * Memory that only worked on Vercel would not be first class.
 */

export type CaptureMode = "conversation" | "job";

export interface Proposal extends MemoryCandidate {
  readonly slot: MemorySlot;
}

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

export type Judge = (
  state: unknown,
  questions: Record<string, EvaluationQuestion>,
  options: { readonly timeoutMs?: number; readonly workspaceId?: string; readonly abortSignal?: AbortSignal },
) => Promise<Judgement<Record<string, EvaluationQuestion>> | null>;

export type Extract = (input: CaptureInput) => Promise<readonly Proposal[]>;

export interface CaptureDeps {
  /** Null when Jev is unavailable; the cue gate stands in. */
  readonly judge: Judge | null;
  readonly extract: Extract;
  readonly floor: number;
  readonly existing: (slot: MemorySlot) => Promise<readonly MemoryEntry[]>;
}

export interface CaptureResult {
  readonly gate: "jev" | "cues" | "closed";
  readonly proposed: number;
  readonly saved: readonly (MemoryEntry & { readonly slot: MemorySlot })[];
}

const NOTHING: CaptureResult = { gate: "closed", proposed: 0, saved: [] };
const MIN_PERSON_CHARS = 12;
const MAX_PROPOSALS = 5;

/** Words a person uses when they are telling you how they want things, not what to do now. */
const CUES =
  /\b(prefer|preference|always|never|from now on|going forward|in future|in the future|remember|don'?t forget|call me|my name|i am|i'm|we are|we're|our (team|company|policy|rule)|usually|typically|every (week|month|day|friday|monday|tuesday|wednesday|thursday)|cc\b|timezone|time zone|format|style|tone|rule)\b/i;

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
            "Does the person state something that will still matter in future conversations: a preference about how work should be done, a fact about themselves or their team, or a standing rule? A one-off request or task does not count.",
            "The person states a durable preference, fact, or standing rule.",
            "The person only asks for something, reacts, or gives one-off details.",
          )
        : boolean(
            "Does this job transcript reveal a durable lesson about the operator's systems or tools, such as where a control hides, which format works, or what a finished deliverable looks like here? Events of this one job do not count.",
            "The transcript reveals a lesson that will still be true next month.",
            "The transcript only shows this job's own events.",
          ),
  };
}

export function validationQuestions(proposals: readonly Proposal[], mode: CaptureMode): Record<string, EvaluationQuestion> {
  const questions: Record<string, EvaluationQuestion> = {};
  proposals.forEach((proposal, index) => {
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
  });
  return questions;
}

export function duplicateQuestions(pairs: readonly { readonly proposal: Proposal; readonly existing: MemoryEntry }[]): Record<string, EvaluationQuestion> {
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

  // 2. What would we keep?
  let proposals: Proposal[];
  try {
    proposals = (await deps.extract(input))
      .filter((proposal) => isMemoryKind(proposal.kind) && (input.mode === "job" ? proposal.slot === "craft" : proposal.slot !== "craft"))
      .map((proposal) => ({ ...proposal, text: normalize(proposal.text) }))
      .filter((proposal) => acceptable(proposal).ok)
      .slice(0, MAX_PROPOSALS);
  } catch {
    return { gate, proposed: 0, saved: [] };
  }
  if (proposals.length === 0) return { gate, proposed: 0, saved: [] };
  const proposed = proposals.length;

  // 3. Is each one durable, on topic, and safe?
  if (ask !== null) {
    const judgement = await ask({ person: person.slice(0, 4_000), proposals: proposals.map((proposal) => proposal.text) }, validationQuestions(proposals, input.mode));
    proposals = proposals.filter((_, index) =>
      ["durable", "about", "safe"].every((facet) => readVerdict(judgement, `${facet}${index}`, deps.floor).verdict !== "no"),
    );
  }

  // 4. Does the store already say it? A person's facts and their team's rules
  //    overlap, so a conversation checks both slots; a job checks craft.
  const slots: readonly MemorySlot[] = input.mode === "conversation" ? ["profile", "team"] : ["craft"];
  const existing = (await Promise.all(slots.map((slot) => deps.existing(slot)))).flat();
  const pairs = proposals.flatMap((proposal) => nearest(existing, proposal.text, 3).map((entry) => ({ proposal, existing: entry })));
  if (ask !== null && pairs.length > 0) {
    const judgement = await ask({ pairs: pairs.map((pair) => [pair.proposal.text, pair.existing.text]) }, duplicateQuestions(pairs));
    const duplicated = new Set(pairs.filter((_, index) => readVerdict(judgement, `same${index}`, deps.floor).verdict === "yes").map((pair) => pair.proposal));
    proposals = proposals.filter((proposal) => !duplicated.has(proposal));
  }

  // 5. Keep what is left, once per operation.
  const saved: (MemoryEntry & { readonly slot: MemorySlot })[] = [];
  for (const slot of new Set(proposals.map((proposal) => proposal.slot))) {
    const outcome = await remember(
      input.workspaceId,
      slot,
      proposals.filter((proposal) => proposal.slot === slot),
      input.source,
      { operationId: `${input.operationId}:${slot}` },
    );
    for (const entry of outcome.added) saved.push({ ...entry, slot });
  }
  return { gate, proposed, saved };
}

// ---------------------------------------------------------------------------
// The default dependencies: Jev when the Gateway is there, the quick model to extract.
// ---------------------------------------------------------------------------

const PROPOSALS_SCHEMA = z.object({
  memories: z
    .array(
      z.object({
        text: z.string().describe("One short standalone sentence, in the third person."),
        kind: z.enum(["preference", "fact", "rule", "lesson"]),
        slot: z.enum(["profile", "team", "craft"]),
      }),
    )
    .max(MAX_PROPOSALS),
});

const SYSTEM: Record<CaptureMode, string> = {
  conversation: [
    "You extract durable memories from one exchange between a person and the AI coordinator of their team.",
    "Keep only what the PERSON stated or clearly implied about themselves or their team that will still be true next month: preferences about how work should be done, facts about them (name, company, role, timezone, accounts they use), and standing rules (who approves what, who to cc, house style).",
    "Never keep one-off requests, the details of a task, opinions of the assistant, or anything secret: passwords, codes, keys, tokens, card numbers.",
    "Write each memory as one short sentence in the third person, e.g. 'Prefers summaries as three bullets.' or 'Their company is Acme Robotics.'",
    "slot 'profile' is about the person; slot 'team' is about how the team or workspace works. Never use 'craft'.",
    "Return an empty list when nothing qualifies. Most exchanges qualify for nothing.",
  ].join(" "),
  job: [
    "You extract lessons from the transcript of a job an AI teammate ran in the operator's tools.",
    "Keep only durable, reusable lessons about the operator's systems: where a control or setting hides, which export or format works and which loses data, what a finished deliverable looks like here, which site needs a person to sign in.",
    "Never keep what happened in this job, its results, or anything secret.",
    "Write each lesson as one short imperative or factual sentence, e.g. 'Export the CRM report as CSV; the PDF drops rows.'",
    "Always use slot 'craft' and kind 'lesson'. Return an empty list when nothing qualifies.",
  ].join(" "),
};

function extractionModel() {
  const id = modelForEffort("quick");
  const endpoint = customEndpoint();
  return endpoint === null ? id : endpointModel(endpoint, id);
}

/** Proposes memories with the quick model, and counts what that cost. */
export const modelExtract: Extract = async (input) => {
  const model = extractionModel();
  const result = await generateText({
    model,
    output: Output.object({ schema: PROPOSALS_SCHEMA }),
    system: SYSTEM[input.mode],
    prompt: [
      input.mode === "conversation" ? "## What the person said" : "## The brief",
      input.person.slice(0, 6_000),
      "",
      input.mode === "conversation" ? "## What the coordinator replied" : "## What happened",
      input.reply.slice(0, 6_000),
    ].join("\n"),
    maxRetries: 1,
    abortSignal: input.abortSignal ?? AbortSignal.timeout(30_000),
  });
  void recordUsage(input.workspaceId, "memory", spent(result.usage, result.providerMetadata, typeof model === "string" ? model : modelForEffort("quick"))).catch(
    () => undefined,
  );
  return (result.output?.memories ?? []).map((memory) => ({ text: memory.text, kind: memory.kind, slot: memory.slot }));
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
