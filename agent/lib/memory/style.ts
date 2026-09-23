import { confidenceOf, FIELDS, type MemoryEntry, type MemoryFieldValue, readEntries, readFields, recallable } from "./store";

/**
 * How this person wants things written, as instructions.
 *
 * Recalled memory enters the model as user-provided data with a note that it
 * is not an instruction, which is right for facts and wrong for writing rules:
 * a habit as strong as em dashes does not yield to "the person dislikes em
 * dashes" filed among other facts. So the writing preferences are also
 * rendered here, per turn, as part of the instructions proper, for HQ and for
 * every Bot. The facts stay where they were.
 */

/** The profile fields that say how to write, and how each reads as a rule. */
const WRITING_FIELDS: readonly { readonly key: string; readonly rule: (value: string) => string }[] = [
  { key: "language", rule: (value) => `Write in ${value}.` },
  { key: "spelling", rule: (value) => `Use ${value} spelling throughout.` },
  { key: "dateFormat", rule: (value) => `Write dates the way this one is written: ${value}.` },
  { key: "timeFormat", rule: (value) => `Write times in ${value} form.` },
  { key: "tone", rule: (value) => `Tone: ${value}.` },
  { key: "length", rule: (value) => `Length: ${value}` },
  { key: "writing", rule: (value) => value.replace(/\.?$/, ".") },
];

const MIN_CONFIDENCE = 0.7;

/** The block, or null when nothing about writing is known yet. */
export function renderStyle(
  profile: Readonly<Record<string, MemoryFieldValue>>,
  team: Readonly<Record<string, MemoryFieldValue>>,
  preferences: readonly MemoryEntry[],
): string | null {
  const rules: string[] = [];
  for (const field of WRITING_FIELDS) {
    const value = profile[field.key]?.value.trim();
    if (value) rules.push(field.rule(value));
  }
  if (team.style?.value.trim()) rules.push(`House style for anything the team publishes: ${team.style.value.trim().replace(/\.?$/, ".")}`);
  for (const entry of preferences) {
    if (entry.kind !== "preference" || confidenceOf(entry) < MIN_CONFIDENCE) continue;
    rules.push(entry.text);
  }
  if (rules.length === 0) return null;
  return [
    "## How this person wants things written",
    "",
    "These come from what they told the team. Apply them to everything you write, chat replies included, without mentioning them. A \"never\" means never; a \"no\" means none, not fewer.",
    "",
    ...rules.map((rule) => `- ${rule}`),
  ].join("\n");
}

export async function styleInstructions(workspaceId: string): Promise<string | null> {
  const [profile, team, entries] = await Promise.all([readFields(workspaceId, "profile"), readFields(workspaceId, "team"), readEntries(workspaceId, "profile")]);
  return renderStyle(profile, team, recallable(entries));
}

/** For tests and callers that want to know which fields are writing rules. */
export const WRITING_FIELD_KEYS: readonly string[] = WRITING_FIELDS.map((field) => field.key);
// FIELDS is imported so the keys above can be checked against it in tests.
export const knownWritingFields = (): boolean => WRITING_FIELD_KEYS.every((key) => FIELDS.profile.some((field) => field.key === key));
