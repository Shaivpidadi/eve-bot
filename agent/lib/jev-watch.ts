import type { Experimental_EvaluationQuestion as EvaluationQuestion } from "ai";

import { newId } from "./ids";
import { listDocs, writeDoc } from "./store";
import { confidenceFloor, type Judgement, type Verdict, verdictOf } from "./jev";

/**
 * What Jev would have decided, written down without acting on it.
 *
 * A judgement that can stop a job, or mark one unfinished, has to earn that
 * power on this deployment's own work first. So each use starts here: the
 * question is asked, the answer is stored next to what actually happened, and
 * nothing changes. `npm run jev:report` reads the pile back, and only then is
 * there a reason to let one of these decide anything.
 */

export type ShadowKind = "completion" | "auth-wall";

export interface ShadowDecision {
  readonly id: string;
  readonly at: string;
  readonly kind: ShadowKind;
  readonly workspaceId: string;
  readonly jobId: string | null;
  /** What Jev said, in the caller's own words. */
  readonly verdict: string;
  readonly confidence: number | null;
  /** What the system did regardless, so the two can be compared later. */
  readonly actual: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

const KEY = (workspaceId: string, id: string) => `jev/${workspaceId}/${id}.json`;

export async function noteShadow(entry: Omit<ShadowDecision, "id" | "at">): Promise<void> {
  const id = `${Date.now().toString(36)}-${newId("jev")}`;
  try {
    await writeDoc(KEY(entry.workspaceId, id), { ...entry, id, at: new Date().toISOString() }, null);
  } catch {
    // An observation nobody is waiting on must never fail a job.
  }
}

export async function listShadow(workspaceId: string): Promise<ShadowDecision[]> {
  const entries = await listDocs<ShadowDecision>(`jev/${workspaceId}/`);
  return entries.sort((left, right) => left.at.localeCompare(right.at));
}

// ---------------------------------------------------------------------------
// The questions
// ---------------------------------------------------------------------------

const MAX_CRITERIA = 8;

/**
 * One boolean per success criterion, plus one for the job as a whole.
 *
 * Each question is evaluated on its own, and only the input is charged for, so
 * asking about every criterion at once costs barely more than asking about one.
 */
export function completionQuestions(criteria: readonly string[]): Record<string, EvaluationQuestion> {
  const questions: Record<string, EvaluationQuestion> = {
    overall: {
      type: "boolean",
      instructions: "Does the evidence show the job was actually finished, rather than described as finished?",
      criteria: {
        true: "The evidence shows the work was carried out and its outcome confirmed.",
        false: "The evidence only asserts the work was done, or shows it was not finished.",
      },
    },
  };
  criteria.slice(0, MAX_CRITERIA).forEach((criterion, index) => {
    questions[`criterion${index}`] = {
      type: "boolean",
      instructions: `Does the evidence show this was met: ${criterion}`,
      criteria: {
        true: "The evidence shows this criterion was met.",
        false: "The evidence does not show this criterion was met.",
      },
    };
  });
  return questions;
}

/** Is the bot looking at a wall only a person can get through? */
export function authWallQuestions(): Record<string, EvaluationQuestion> {
  return {
    wall: {
      type: "boolean",
      instructions:
        "Is this page asking to sign in, or for a second factor, a passkey, a device confirmation, or a CAPTCHA — something the automated bot cannot do for itself?",
      criteria: {
        true: "The page is a sign-in, 2FA, passkey, device confirmation, or CAPTCHA wall.",
        false: "The page is ordinary content the bot can work with.",
      },
    },
  };
}

const probabilityOf = (answer: unknown): number | undefined => {
  const value = (answer as { probability?: unknown } | undefined)?.probability;
  return typeof value === "number" ? value : undefined;
};

/** Reads one boolean answer out of a judgement, with its confidence. */
export function readVerdict(
  judgement: Judgement<Record<string, EvaluationQuestion>> | null,
  id: string,
  floor: number = confidenceFloor(),
): { readonly verdict: Verdict; readonly confidence: number | null } {
  if (judgement === null) return { verdict: "unknown", confidence: null };
  const answers = judgement.answers as Record<string, unknown>;
  const confidence = judgement.confidence[id];
  return {
    verdict: verdictOf(probabilityOf(answers[id]), confidence, floor),
    confidence: confidence ?? null,
  };
}

/** Which criteria a judgement says are unmet, by their index. */
export function unmetCriteria(
  judgement: Judgement<Record<string, EvaluationQuestion>> | null,
  count: number,
  floor: number = confidenceFloor(),
): number[] {
  if (judgement === null) return [];
  const unmet: number[] = [];
  for (let index = 0; index < Math.min(count, MAX_CRITERIA); index += 1) {
    if (readVerdict(judgement, `criterion${index}`, floor).verdict === "no") unmet.push(index);
  }
  return unmet;
}
