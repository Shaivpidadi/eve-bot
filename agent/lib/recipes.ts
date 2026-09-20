import { newId } from "./ids";
import { deleteDoc, listDocs, readDoc, updateDoc, writeDoc } from "./store";

/**
 * Work that turned out well, written down so it can be asked for again.
 *
 * The same request comes back — the weekly competitor check, the invoice
 * download, the Monday summary — and today it is briefed from scratch every
 * time, so it comes out a little different and fails in a new way. A recipe
 * is the brief that worked, with what "done" meant and what to watch out for.
 *
 * It is deliberately a description, not a recording. Replaying saved clicks
 * breaks the first time a page moves a button; a brief that says what to
 * achieve is re-read against the page as it is today. The bot still does the
 * work, and still has to verify it.
 */

export interface Recipe {
  readonly id: string;
  readonly workspaceId: string;
  /** What the operator would call it: "weekly competitor prices". */
  readonly name: string;
  /** When to reach for it, in the words HQ will read. */
  readonly when: string;
  /** The brief that worked, for a bot that has never seen the conversation. */
  readonly brief: string;
  readonly successCriteria: readonly string[];
  /** What went wrong before, and what to check. */
  readonly notes: readonly string[];
  /** The job it was learned from, and the bot that did it. */
  readonly fromJobId: string | null;
  readonly botId: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
  /** How many jobs have been briefed from it. */
  readonly uses: number;
}

const NAME_MAX = 60;
const BRIEF_MAX = 6_000;
const WHEN_MAX = 200;
const NOTE_MAX = 300;
const NOTES_MAX = 8;
const CRITERIA_MAX = 8;
const RECIPES_MAX = 40;

const key = (workspaceId: string, id: string) => `recipes/${workspaceId}/${id}.json`;

export async function listRecipes(workspaceId: string): Promise<Recipe[]> {
  const recipes = await listDocs<Recipe>(`recipes/${workspaceId}/`);
  return recipes.sort((left, right) => right.uses - left.uses || left.name.localeCompare(right.name));
}

export async function getRecipe(workspaceId: string, id: string): Promise<Recipe | null> {
  return (await readDoc<Recipe>(key(workspaceId, id)))?.value ?? null;
}

/** Finds a recipe by id or by name, since HQ will have read the name. */
export async function findRecipe(workspaceId: string, idOrName: string): Promise<Recipe | null> {
  const wanted = idOrName.trim().toLowerCase();
  if (wanted === "") return null;
  const byId = await getRecipe(workspaceId, idOrName.trim());
  if (byId !== null) return byId;
  return (await listRecipes(workspaceId)).find((recipe) => recipe.name.toLowerCase() === wanted) ?? null;
}

export async function saveRecipe(input: {
  workspaceId: string;
  createdBy: string;
  name: string;
  when: string;
  brief: string;
  successCriteria?: readonly string[];
  notes?: readonly string[];
  fromJobId?: string | null;
  botId?: string | null;
}): Promise<{ ok: true; recipe: Recipe } | { ok: false; error: string }> {
  const name = input.name.trim().slice(0, NAME_MAX);
  const brief = input.brief.trim().slice(0, BRIEF_MAX);
  if (name === "" || brief === "") return { ok: false, error: "A recipe needs a name and the brief that worked." };

  const existing = await listRecipes(input.workspaceId);
  const clash = existing.find((recipe) => recipe.name.toLowerCase() === name.toLowerCase());
  if (clash === undefined && existing.length >= RECIPES_MAX) {
    return { ok: false, error: `There are already ${RECIPES_MAX} recipes. Remove one before saving another.` };
  }

  const recipe: Recipe = {
    id: clash?.id ?? newId("recipe"),
    workspaceId: input.workspaceId,
    name,
    when: input.when.trim().slice(0, WHEN_MAX),
    brief,
    successCriteria: (input.successCriteria ?? []).slice(0, CRITERIA_MAX).map((line) => line.trim().slice(0, NOTE_MAX)),
    notes: (input.notes ?? []).slice(0, NOTES_MAX).map((line) => line.trim().slice(0, NOTE_MAX)),
    fromJobId: input.fromJobId ?? null,
    botId: input.botId ?? null,
    createdAt: clash?.createdAt ?? new Date().toISOString(),
    createdBy: input.createdBy,
    // Rewriting a recipe keeps its history: it is the same piece of work.
    uses: clash?.uses ?? 0,
  };
  await writeDoc(key(input.workspaceId, recipe.id), recipe);
  return { ok: true, recipe };
}

/** Counts a use, so the list puts what the team actually repeats at the top. */
export async function noteRecipeUsed(workspaceId: string, id: string): Promise<void> {
  await updateDoc<Recipe>(key(workspaceId, id), (current) =>
    current === null ? null : { ...current, uses: current.uses + 1 },
  ).catch(() => null);
}

export async function removeRecipe(workspaceId: string, id: string): Promise<boolean> {
  if ((await getRecipe(workspaceId, id)) === null) return false;
  await deleteDoc(key(workspaceId, id));
  return true;
}

/**
 * The brief a job gets from a recipe.
 *
 * What the operator asked for this time comes first and wins: a recipe is how
 * the work is done, not what was wanted today.
 */
export function briefFromRecipe(recipe: Recipe, request: string | undefined): string {
  const asked = request?.trim() ?? "";
  return [
    asked === "" ? "" : `This time: ${asked}`,
    asked === "" ? "" : "",
    `How this went last time (recipe "${recipe.name}"):`,
    recipe.brief,
    recipe.notes.length === 0 ? "" : `\nWatch out for:\n${recipe.notes.map((note) => `- ${note}`).join("\n")}`,
    "\nThe page may have moved since. Find the things this describes as they are today; do not assume the same buttons in the same places.",
  ]
    .filter((part) => part !== "")
    .join("\n");
}
