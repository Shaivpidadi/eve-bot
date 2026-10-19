/**
 * Settings saved in the console that `eve build` fixes (cost and token caps,
 * where the computer runs; see agent/lib/settings/store.ts), for the build and
 * start scripts: `savedSettings("plan")` gives the values to lay over the
 * environment and whether they differ from the last build, and
 * `savedSettings("record")` notes what a finished build used.
 *
 * The store is TypeScript, so the work runs in a child under tsx. Anything that
 * goes wrong (no store yet, no tsx in this install) answers null: the build
 * then uses the environment alone, as before Settings existed.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function savedSettings(command, env = process.env) {
  const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
  if (!existsSync(tsx)) return null;
  const result = spawnSync(tsx, [fileURLToPath(import.meta.url), command], { env, encoding: "utf8", timeout: 60_000 });
  const line = result.stdout?.trim().split("\n").pop() ?? "";
  try {
    if (result.status === 0) return JSON.parse(line);
  } catch {
    // Reported below.
  }
  console.warn(`[bot] Could not read the saved settings (${(result.stderr || line || "no answer").trim().split("\n").pop()}); building from the environment alone.`);
  return null;
}

/** Lays saved values over `process.env`, noting what each variable held before for the Settings page. */
export function overlaySettings(overlay) {
  const was = {};
  for (const [name, value] of Object.entries(overlay ?? {})) {
    was[name] = process.env[name] ?? null;
    process.env[name] = value;
  }
  if (Object.keys(was).length > 0) {
    process.env.BOT_SETTINGS_OVERLAY = JSON.stringify(was);
    console.log(`[bot] Using ${Object.keys(was).join(", ")} from Settings.`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { rebuildPlan, recordBuilt } = await import("../agent/lib/settings/store.ts");
  const command = process.argv[2];
  if (command === "plan") console.log(JSON.stringify(await rebuildPlan()));
  else if (command === "record") {
    await recordBuilt();
    console.log("{}");
  } else {
    console.error("Usage: tsx scripts/settings.mjs plan|record");
    process.exit(2);
  }
}
