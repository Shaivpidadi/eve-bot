import type { Experimental_EvaluationQuestion as EvaluationQuestion } from "ai";

import { confidenceFloor, type Judgement } from "../../../lib/jev";

import { CONSEQUENTIAL_WORDS } from "./consequence";

/**
 * Driving a few browser steps without a model turn for each one.
 *
 * Most of a browser job is not thinking: click the account menu, click
 * Billing, wait, click the latest invoice. Each of those costs a full turn of
 * the job's model today, with the page re-sent every time. The parts that
 * genuinely need a model — deciding what to do at all, reading a document,
 * judging something ambiguous — are a small share of the steps.
 *
 * So the model sets a subgoal and supplies any text to type, and a loop takes
 * it from there: read the page, offer the controls that exist, let a decision
 * model pick one, act, check that something moved. It stops the moment it is
 * unsure, out of steps, out of time, or facing anything that spends money or
 * sends something, and hands back to the model with what it saw.
 *
 * It is navigation only. No input can authorise it to take a consequential
 * step: such a step comes back as a proposal (see `gate.ts`), and only a
 * person's approval through `page_confirm` makes it happen.
 *
 * Everything here is pure; the loop that uses it lives in `tools/page_pilot.ts`.
 */

/** `  - button "Send" [ref=e12]` — the role, the name, and the ref. */
const CONTROL = /^\s*-\s+([A-Za-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?[^"]*\[ref=(e\d+)\]/;

/** Controls that take text rather than a click. */
const FILLABLE = new Set(["textbox", "searchbox", "combobox", "textarea", "spinbutton"]);

/**
 * The pilot never picks a control whose name spends, sends, or destroys: it
 * stops there and the gate in `gate.ts` turns the step into a proposal a person
 * approves. The words are the classifier's own (`consequence.ts`), so a step
 * the pilot lets through by name is still checked against the element itself
 * before it is taken.
 */
const CONSEQUENTIAL = CONSEQUENTIAL_WORDS;

export interface Candidate {
  readonly id: string;
  readonly ref: string;
  readonly role: string;
  readonly name: string;
  readonly action: "click" | "fill";
  readonly consequential: boolean;
}

export const MAX_CANDIDATES = 20;

/** The controls on a page the pilot could act on, as the choices it will be offered. */
export function candidateActions(tree: string, options: { readonly canType?: boolean } = {}): Candidate[] {
  const candidates: Candidate[] = [];
  for (const line of tree.split("\n")) {
    const match = CONTROL.exec(line);
    if (match === null) continue;
    const [, role = "", rawName, ref = ""] = match;
    const name = (rawName ?? "").trim();
    const action = FILLABLE.has(role) ? "fill" : "click";
    // A field is only worth offering when the model gave text to put in it.
    if (action === "fill" && options.canType !== true) continue;
    if (name === "" && action === "click" && role !== "button" && role !== "link") continue;
    candidates.push({
      id: `a${candidates.length + 1}`,
      ref: `@${ref}`,
      role,
      name,
      action,
      consequential: CONSEQUENTIAL.test(name),
    });
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  return candidates;
}

export const DONE = "done";
export const STUCK = "stuck";

/** The one question the pilot asks per step: which control moves toward the goal. */
export function stepQuestion(goal: string, candidates: readonly Candidate[]): Record<string, EvaluationQuestion> {
  const criteria: Record<string, string> = {
    [DONE]: "The goal has already been reached on this page; nothing further is needed.",
    [STUCK]: "None of these controls moves toward the goal.",
  };
  for (const candidate of candidates) {
    criteria[candidate.id] =
      `${candidate.action === "fill" ? "Type into" : "Click"} the ${candidate.role}${candidate.name === "" ? "" : ` "${candidate.name}"`}`;
  }
  return {
    next: {
      type: "choice",
      instructions: `A browser is on a page and the goal is: ${goal}. Which one of these moves toward that goal?`,
      criteria,
    },
  };
}

export type Stop =
  | "reached"
  | "stuck"
  | "unsure"
  | "consequential"
  | "no-progress"
  | "out-of-steps"
  | "out-of-time"
  | "cancelled"
  | "refused"
  | "failed"
  | "unavailable";

/** Why the loop must not take another step, or null when it may. */
export function stopBefore(state: {
  readonly step: number;
  readonly maxSteps: number;
  readonly now: number;
  readonly deadline: number;
  readonly cancelled: boolean;
  readonly idleRuns: number;
}): Stop | null {
  if (state.cancelled) return "cancelled";
  if (state.step >= state.maxSteps) return "out-of-steps";
  if (state.now >= state.deadline) return "out-of-time";
  // Twice in a row where the page did not react means the approach is wrong,
  // not that the same click needs a third try.
  if (state.idleRuns >= 2) return "no-progress";
  return null;
}

export interface Choice {
  readonly pick: Candidate | null;
  readonly stop: Stop | null;
}

/** Reads the step answer: a control to act on, or a reason to hand back. */
export function readChoice(
  judgement: Judgement<Record<string, EvaluationQuestion>> | null,
  candidates: readonly Candidate[],
  options: { readonly floor?: number } = {},
): Choice {
  if (judgement === null) return { pick: null, stop: "unavailable" };
  const answer = (judgement.answers as Record<string, unknown>).next as { choice?: unknown } | undefined;
  const chosen = typeof answer?.choice === "string" ? answer.choice : null;
  if (chosen === null) return { pick: null, stop: "unsure" };
  const floor = options.floor ?? confidenceFloor();
  const confidence = judgement.confidence.next;
  // A spread answer is the pilot saying it does not know; the model decides those.
  if (confidence !== undefined && confidence < floor) return { pick: null, stop: "unsure" };
  if (chosen === DONE) return { pick: null, stop: "reached" };
  if (chosen === STUCK) return { pick: null, stop: "stuck" };
  const pick = candidates.find((candidate) => candidate.id === chosen) ?? null;
  if (pick === null) return { pick: null, stop: "unsure" };
  // Never taken by the pilot, whatever it was asked: a person approves these.
  if (pick.consequential) return { pick, stop: "consequential" };
  return { pick, stop: null };
}

/** What the tool says about a stop, for the model that has to carry on from it. */
export const STOP_NOTE: Readonly<Record<Stop, string>> = {
  reached: "The goal looks reached. Confirm it on the page before you rely on it.",
  stuck: "Nothing on the page moved toward the goal. Read the page and decide yourself.",
  unsure: "The next step was not clear enough to take without you. Read the page and decide yourself.",
  consequential:
    "The next step could send, spend, publish, delete or commit something, so it was not taken. If the brief calls for it, ask a person with page_confirm using the proposal here; otherwise take another route.",
  "no-progress": "The page stopped reacting. Read it and try a different route.",
  "out-of-steps": "The step limit was reached. Read the page and carry on, or run the pilot again with the next subgoal.",
  "out-of-time": "The time limit was reached. Read the page and carry on.",
  cancelled: "The job was cancelled.",
  refused: "This run no longer owns its job. Stop: nothing you do now counts.",
  failed: "A browser action failed. Read the page and carry on yourself.",
  unavailable: "The pilot is not available on this deployment. Drive the page yourself with page_click and page_fill.",
};
