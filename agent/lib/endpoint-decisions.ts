import { type Experimental_DecisionModel, generateText, type LanguageModel, NoObjectGeneratedError, Output } from "ai";
import { z } from "zod";

/**
 * Jev's questions, answered by an ordinary chat model on your own provider.
 *
 * On AI Gateway, Jev is a decision model: it answers a choice, a score or a
 * yes/no as a calibrated probability, from the input alone. An OpenAI-
 * compatible provider has no such model, so here the same questions go to a
 * chat model (`BOT_JEV_MODEL` on that provider, else its quick model) as
 * structured output, and come back in the decision model's shape: a choice
 * with no distribution, a score, and for yes/no the model's own estimate of
 * how likely "yes" is. Those estimates are not calibrated the way Jev's are;
 * every caller already treats a judgement as advice and has a path for none.
 */

/** The decision model interface itself: the one member of `ai`'s union that decides. */
type DecisionModel = Extract<Exclude<Experimental_DecisionModel, string>, { doDecide: unknown }>;
type CallOptions = Parameters<DecisionModel["doDecide"]>[0];
type Question = CallOptions["questions"][string];
type Answer = Awaited<ReturnType<DecisionModel["doDecide"]>>["answers"][string];

/** The question's text, whether it came as a string or as content parts. */
const words = (input: unknown): string => {
  if (typeof input === "string") return input;
  if (Array.isArray(input)) return input.map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text: unknown }).text) : "")).join(" ");
  return input === null || input === undefined ? "" : JSON.stringify(input);
};

/** What the model reads: the state's text and data (files are left out: not every provider reads them). */
function stateText(state: CallOptions["state"]): string {
  return state
    .map((part) => (part.type === "text" ? part.text : part.type === "json" ? JSON.stringify(part.value) : ""))
    .filter((text) => text !== "")
    .join("\n\n");
}

function schemaFor(question: Question): z.ZodType {
  if (question.type === "choice") {
    const options = Object.keys(question.criteria);
    return z.enum(options as [string, ...string[]]);
  }
  if (question.type === "score") return z.number().min(0).max(question.criteria.length - 1);
  return z.object({ answer: z.boolean(), probability: z.number().min(0).max(1).describe("How likely the answer is true, from 0 to 1.") });
}

function described(id: string, question: Question): string {
  const lines = [`${id}: ${words(question.instructions)}`];
  if (question.type === "choice") {
    for (const [option, meaning] of Object.entries(question.criteria)) lines.push(`  - ${option}${meaning === null ? "" : `: ${words(meaning)}`}`);
  } else if (question.type === "score") {
    question.criteria.forEach((level, index) => lines.push(`  - ${index}${level === null ? "" : `: ${words(level)}`}`));
  } else {
    if (question.criteria?.true) lines.push(`  - true: ${words(question.criteria.true)}`);
    if (question.criteria?.false) lines.push(`  - false: ${words(question.criteria.false)}`);
  }
  return lines.join("\n");
}

/**
 * The answers in a reply that is not quite the shape asked: its JSON when it
 * has some, read question by question (a choice by an option's name, a score by
 * a number, a yes/no by true/false or yes/no, nested or flat), else nothing.
 */
export function lenient(text: string, questions: CallOptions["questions"]): Record<string, unknown> {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = json === undefined ? null : JSON.parse(json);
    if (typeof value === "object" && value !== null) parsed = value as Record<string, unknown>;
  } catch {
    // Not JSON: nothing to read.
  }
  const out: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(questions)) {
    let value = parsed[id];
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const inner = value as Record<string, unknown>;
      value = inner.answer ?? inner.choice ?? inner.score ?? inner.value ?? value;
    }
    if (question.type === "choice") {
      const options = Object.keys(question.criteria);
      const said = String(value ?? "").toLowerCase();
      const match = options.find((option) => option.toLowerCase() === said) ?? options.find((option) => said.includes(option.toLowerCase()));
      if (match !== undefined) out[id] = match;
    } else if (question.type === "score") {
      const number = typeof value === "number" ? value : Number(value);
      if (Number.isFinite(number)) out[id] = Math.min(Math.max(number, 0), question.criteria.length - 1);
    } else {
      const said = typeof value === "boolean" ? value : /^(true|yes)$/i.test(String(value ?? "").trim()) ? true : /^(false|no)$/i.test(String(value ?? "").trim()) ? false : undefined;
      const probability = typeof parsed[id] === "object" && parsed[id] !== null ? (parsed[id] as { probability?: unknown }).probability : undefined;
      if (said !== undefined) out[id] = { answer: said, ...(typeof probability === "number" ? { probability } : {}) };
    }
  }
  return out;
}

export function chatDecisionModel(model: LanguageModel, modelId: string): DecisionModel {
  return {
    specificationVersion: "v4",
    provider: "custom",
    modelId,
    supportedQuestionTypes: ["choice", "score", "boolean"],
    async doDecide(options) {
      const ids = Object.keys(options.questions);
      const schema = z.object(Object.fromEntries(ids.map((id) => [id, schemaFor(options.questions[id]!)])));
      let raw: Record<string, unknown>;
      let usage: { inputTokens?: number; outputTokens?: number } = {};
      try {
        const result = await generateText({
          model,
          system:
            "You answer each question about the state below, briefly and honestly, as one JSON object keyed by the question ids. Judge only from what the state shows.",
          prompt: `State:\n${stateText(options.state)}\n\nQuestions:\n${ids.map((id) => described(id, options.questions[id]!)).join("\n\n")}`,
          output: Output.object({ schema }),
          abortSignal: options.abortSignal,
          maxRetries: 0,
        });
        raw = result.output as Record<string, unknown>;
        usage = { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens };
      } catch (error) {
        // A small model's JSON that misses the shape still says what it decided: read that leniently.
        if (!NoObjectGeneratedError.isInstance(error) || error.text === undefined) throw error;
        raw = lenient(error.text, options.questions);
        usage = { inputTokens: error.usage?.inputTokens, outputTokens: error.usage?.outputTokens };
      }
      const answers: Record<string, Answer> = {};
      for (const id of ids) {
        const question = options.questions[id]!;
        const value = raw[id];
        if (question.type === "choice") answers[id] = typeof value === "string" ? { type: "choice", choice: value } : { type: "refusal" };
        else if (question.type === "score") answers[id] = typeof value === "number" ? { type: "score", score: value } : { type: "refusal" };
        else {
          const verdict = value as { answer?: unknown; probability?: unknown } | undefined;
          const yes = verdict?.answer === true;
          // A percentage (95) is read as one, and anything else is kept within [0, 1].
          const stated = typeof verdict?.probability === "number" && Number.isFinite(verdict.probability) ? verdict.probability : null;
          const given = stated === null ? (yes ? 0.75 : 0.25) : Math.min(Math.max(stated > 1 ? stated / 100 : stated, 0), 1);
          // Small models often give their confidence in the answer instead (0.9 for a sure "no"): read an estimate
          // that contradicts the answer that way, so P(true) always agrees with what was answered.
          answers[id] = { type: "boolean", probability: yes === given >= 0.5 ? given : 1 - given };
        }
      }
      return { answers, usage, warnings: [] };
    },
  };
}
