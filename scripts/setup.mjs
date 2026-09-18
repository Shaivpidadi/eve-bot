#!/usr/bin/env node
/**
 * `npm run setup`: choose where Bot runs and write its environment file.
 *
 * Two deployments, one code base. A standalone server keeps everything on a
 * machine you own: the team's computer in Docker, models from any
 * OpenAI-compatible API, storage on disk. A Vercel deployment uses Vercel
 * Sandbox, AI Gateway, and Blob. This asks which, then the few things that
 * choice needs, and writes `.env` (standalone) or `.env.local` (Vercel
 * development) so `npm run build && npm start` or `npm run dev` just works.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY === true });
const say = (line = "") => stdout.write(`${line}\n`);

// Answers can arrive before they are asked for (a pipe, a paste), so lines are
// queued rather than read on demand. Once input ends, every answer is blank
// and the defaults apply.
const queued = [];
let waiting = null;
let ended = false;
rl.on("line", (line) => {
  if (waiting !== null) {
    const resolve = waiting;
    waiting = null;
    resolve(line);
  } else queued.push(line);
});
rl.on("close", () => {
  ended = true;
  if (waiting !== null) waiting("");
});
const readLine = () =>
  queued.length > 0 ? Promise.resolve(queued.shift()) : ended ? Promise.resolve("") : new Promise((resolve) => (waiting = resolve));

async function ask(question, fallback) {
  const suffix = fallback === undefined || fallback === "" ? "" : ` [${fallback}]`;
  stdout.write(`${question}${suffix} `);
  const answer = (await readLine()).trim();
  if (!stdin.isTTY) stdout.write(`${answer}\n`);
  return answer === "" ? (fallback ?? "") : answer;
}

async function choose(question, options, fallback = 1) {
  say(question);
  options.forEach((option, index) => say(`  ${index + 1}) ${option}`));
  for (;;) {
    const answer = await ask("Choice", String(fallback));
    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= options.length) return index;
    say(`Type a number from 1 to ${options.length}.`);
  }
}

async function yes(question, fallback = true) {
  const answer = (await ask(`${question} ${fallback ? "[Y/n]" : "[y/N]"}`, "")).toLowerCase();
  return answer === "" ? fallback : answer.startsWith("y");
}

/** Ollama and LM Studio list what they serve; a name from the list beats a typo. */
async function listModels(baseURL) {
  try {
    const response = await fetch(`${baseURL}/models`, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return null;
    const body = await response.json();
    const ids = (body.data ?? []).map((model) => model.id).filter((id) => typeof id === "string");
    return ids.length > 0 ? ids : null;
  } catch {
    return null;
  }
}

function dockerRunning() {
  const result = spawnSync(process.env.EVE_DOCKER_PATH?.trim() || "docker", ["info", "--format", "{{.ServerVersion}}"], {
    encoding: "utf8",
  });
  return result.status === 0;
}

const token = () => randomBytes(32).toString("base64url");

say("Bot setup");
say("=========");
say();

const platform = (await choose("Where will this copy of Bot run?", [
  "Standalone: on this machine or a server of mine, with nothing on Vercel",
  "Vercel: deployed to my Vercel account (this sets up local development for it)",
])) === 1 ? "standalone" : "vercel";

/** @type {Array<[string, string] | string>} lines of the env file: [name, value] or a comment */
const lines = [];
const note = (text) => lines.push(`# ${text}`);
const set = (name, value) => lines.push([name, value]);

say();
if (platform === "standalone") {
  note("Standalone Bot: the team's computer in Docker, storage on disk, models from your own endpoint.");
  set("BOT_COMPUTER", "local");
  set("BOT_STORE", "fs");
  if (!dockerRunning()) {
    say("Docker does not seem to be running. The team's computer needs it before a Bot starts a job;");
    say("install Docker Desktop, OrbStack, or Colima, or point EVE_DOCKER_PATH at your docker CLI.");
    say();
  }
}

// ── Models ─────────────────────────────────────────────────────────────────
const modelChoices = [
  "Ollama on this machine (http://localhost:11434/v1)",
  "LM Studio on this machine (http://localhost:1234/v1)",
  "OpenRouter (https://openrouter.ai/api/v1, with an API key)",
  "Another OpenAI-compatible API (vLLM, a company proxy, ...)",
];
if (platform === "vercel") modelChoices.push("Vercel AI Gateway (the default on Vercel)");
const modelChoice = await choose("Where do the models come from?", modelChoices, platform === "vercel" ? 5 : 1);

let customEndpoint = null;
if (modelChoice === 5) {
  const key = await ask("AI_GATEWAY_API_KEY (blank if the project is linked and uses OIDC):", "");
  note("Models through Vercel AI Gateway.");
  if (key !== "") set("AI_GATEWAY_API_KEY", key);
} else {
  const baseURL =
    modelChoice === 1
      ? "http://localhost:11434/v1"
      : modelChoice === 2
        ? "http://localhost:1234/v1"
        : modelChoice === 3
          ? "https://openrouter.ai/api/v1"
          : await ask("Base URL of the API (ending in /v1):");
  const apiKey = modelChoice === 3 || modelChoice === 4 ? await ask("API key (blank if none):", "") : "";
  const served = await listModels(baseURL);
  if (served !== null && served.length <= 30) say(`Models served there: ${served.join(", ")}`);
  else if (served === null && (modelChoice === 1 || modelChoice === 2)) say(`Nothing answered at ${baseURL} yet; start it before the Bots need it.`);
  const suggested = served?.[0] ?? (modelChoice === 3 ? "anthropic/claude-sonnet-4.5" : "qwen3:8b");
  const model = await ask("Model to use everywhere (pick one that handles tool calls well):", suggested);
  const context = await ask("Its context window, in tokens:", modelChoice === 3 ? "200000" : "32000");
  note("Models from your own OpenAI-compatible endpoint.");
  set("BOT_MODEL_BASE_URL", baseURL);
  if (apiKey !== "") set("BOT_MODEL_API_KEY", apiKey);
  set("BOT_MODEL", model);
  set("BOT_MODEL_CONTEXT_TOKENS", context);
  if (modelChoice !== 3) {
    const price = await ask("What it costs, as input/output USD per million tokens (0/0 for your own hardware):", "0/0");
    set("BOT_MODEL_PRICES", `${model}=${price}`);
  }
  customEndpoint = baseURL;
}

// ── Web search ─────────────────────────────────────────────────────────────
if (customEndpoint !== null) {
  say();
  const searchChoice = await choose("Web search for the Bots (eve's own search needs AI Gateway)?", [
    "None: Bots research in their browser",
    "SearXNG I run myself (docker-compose.yml starts one)",
    "Brave Search API",
    "Tavily",
    "Exa",
  ]);
  if (searchChoice === 2) {
    set("BOT_SEARCH_PROVIDER", "searxng");
    set("BOT_SEARCH_URL", await ask("SearXNG URL:", "http://localhost:8888"));
  } else if (searchChoice > 2) {
    set("BOT_SEARCH_PROVIDER", ["brave", "tavily", "exa"][searchChoice - 3]);
    set("BOT_SEARCH_API_KEY", await ask("API key:"));
  }
}

// ── Console access ─────────────────────────────────────────────────────────
say();
const typed = await ask("Console token to sign in with (blank to generate one):", "");
const consoleToken = typed === "" ? token() : typed;
note("The password you sign in to the console with.");
set("BOT_CONSOLE_TOKEN", consoleToken);

// ── Write ──────────────────────────────────────────────────────────────────
const file = platform === "standalone" ? ".env" : ".env.local";
const path = join(process.cwd(), file);
if (existsSync(path)) {
  say();
  if (!(await yes(`${file} exists. Replace it (the old one is kept as ${file}.bak)?`, false))) {
    say("Nothing written.");
    rl.close();
    process.exit(0);
  }
  renameSync(path, `${path}.bak`);
}
const rendered = lines.map((line) => (typeof line === "string" ? line : `${line[0]}=${line[1]}`)).join("\n");
writeFileSync(path, `${rendered}\n`);
rl.close();

say();
say(`Wrote ${file}.`);
say();
if (platform === "standalone") {
  say("Next:");
  say("  npm run build && npm start      # then open http://localhost:3000/bot");
  say(`  sign in with: ${consoleToken}`);
  say("  keep .data/, .eve/ and the bot-computer Docker volume on storage that survives restarts");
  say("  npm run dev                     # for hacking on Bot itself, with the same .env");
} else {
  say("Next:");
  say("  npx vercel link && npx vercel env pull   # Vercel Sandbox and AI Gateway credentials for development");
  say("  npm run dev                              # then open http://localhost:3000/bot");
  say("To deploy, use the Deploy button in the README, or:");
  say("  npx vercel blob create-store bot-store --access private --yes");
  say(`  npx vercel env add BOT_CONSOLE_TOKEN production   # ${consoleToken}`);
  say("  npx vercel deploy --prod");
}
