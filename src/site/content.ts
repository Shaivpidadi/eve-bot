/**
 * What the public pages say, once, as plain text. The HTML pages, the Markdown
 * served to agents that ask for it, `llms.txt`, and the structured data all
 * read from here, so the site says the same thing to a person and to a crawler.
 * Nothing in this module touches the console, the agent, or a request.
 */

export const SITE = {
  name: "EVE BOT",
  shortName: "eve-bot",
  tagline: "A team of always-on AI teammates with a computer of their own.",
  repo: "https://github.com/Shaivpidadi/eve-bot",
  issues: "https://github.com/Shaivpidadi/eve-bot/issues",
  license: "MIT",
  /** The public origin, for canonical URLs and the sitemap. Vercel provides its own. */
  origin:
    process.env.BOT_PUBLIC_URL?.trim() ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000"),
} as const;

export const DEPLOY_URL =
  "https://vercel.com/new/clone?" +
  new URLSearchParams({
    "repository-url": SITE.repo,
    "project-name": SITE.shortName,
    "repository-name": SITE.shortName,
    env: "BOT_CONSOLE_TOKEN",
    envDescription: "A long random password you sign in to the console with",
    envLink: `${SITE.repo}#vercel`,
  }).toString();

/** The public pages, for the sitemap and for the Markdown the proxy serves. */
export const PAGES = ["/", "/about", "/contact", "/privacy"] as const;
export type PublicPath = (typeof PAGES)[number];

export const HOME_MARKDOWN = `# ${SITE.name}

${SITE.tagline} Each teammate works inside the apps you already use, on a real browser, and keeps going after you close the laptop, coming back only when something needs your approval.

## Where do you want it to run?

### On Vercel

One click. Vercel runs the computer (Vercel Sandbox), the models (AI Gateway), the storage (Blob), and the schedules (Cron), and bills your account.

- Deploy: ${DEPLOY_URL}
- It asks for one value, BOT_CONSOLE_TOKEN, the password you sign in with.
- Then, in the project's Storage tab, create a Blob store and connect it; redeploy once.
- Open /bot on your deployment; its setup page checks each step off.

### On your own machine

Nothing leaves your network unless you point it there. The computer runs in Docker; models come from Ollama, LM Studio, OpenRouter, or any OpenAI-compatible API; storage is on disk.

Requirements: Node 24, Docker, a model endpoint.

\`\`\`
git clone ${SITE.repo}.git && cd eve-bot
npm install
npm run setup                 # pick Standalone
npm run build && npm start    # http://localhost:3000/bot
\`\`\`

Or as containers: \`npm run setup && docker compose up -d --build\`.

Guide: ${SITE.repo}#standalone

## Either way

- HQ and a roster: message HQ like a colleague; it writes a brief, picks the right Bot, and hands off the job.
- A computer the team keeps: one real Chrome, a terminal, and files, shared by every Bot and backed up while they work.
- Watch and take over: the screen sits in every thread; sign-ins, codes, and CAPTCHAs are yours, and passwords never touch chat.
- Durable jobs: work survives restarts, waits for its start time without compute, and asks before anything irreversible.

Source: ${SITE.repo} (${SITE.license}). Agents: see /llms.txt.
`;

export const ABOUT = {
  title: `About ${SITE.name}`,
  paragraphs: [
    `${SITE.name} is open-source software for running a small team of AI teammates that do real work inside the web apps a person already uses. You talk to HQ, the coordinator, the way you would message a colleague. HQ turns the request into a job with explicit success criteria, hands it to the Bot whose role fits, and reports back. The Bots share one persistent computer with a real Google Chrome, a terminal, and files, so what one of them signs in to is there for the next, and what they leave behind is there tomorrow.`,
    `It is built on eve, Vercel's agent framework, and Next.js. Jobs run as durable workflows, so they survive restarts and redeploys, wait for their start time without holding compute, and can park for a day waiting for a person's sign-off. Anything irreversible, such as sending email or retiring a Bot, stops for a person first. When a Bot meets a sign-in, a one-time code, or a CAPTCHA, it asks you to take over its live browser; you do the step and hand it back, and the password never passes through chat.`,
    `It runs in two places. On Vercel, one click deploys it to your own account, and Vercel provides the computer, the models, the storage, and the schedules. Standalone, it runs on a machine you own: the computer in Docker, models from Ollama, LM Studio, OpenRouter, or any OpenAI-compatible endpoint, storage on disk, nothing leaving your network unless you point it there. The code is the same; only the plumbing differs.`,
    `${SITE.name} is alpha software, released under the ${SITE.license} license. The source, the issue tracker, and the documentation live at ${SITE.repo}.`,
  ],
};

export const CONTACT = {
  title: "Contact",
  paragraphs: [
    `${SITE.name} is an open-source project maintained on GitHub. The best way to reach the people behind it is the repository itself: open an issue for a bug, a question, or a request at ${SITE.issues}, or start a discussion on the repository. Issues are read by the maintainers, and a good issue includes what you ran, what you expected, and what happened, with the relevant lines from the server log.`,
    `If you found a security problem, please do not open a public issue. Use GitHub's private vulnerability reporting on the repository, which reaches the maintainers without disclosing the details, and give us a reasonable time to fix it before you publish.`,
    `For anything about a particular deployment of ${SITE.name}, such as a company's own instance, contact whoever operates that deployment. This project provides the software; each deployment is run by its own operator, who holds its data and its credentials. The project itself does not operate a hosted service and has no access to anyone's deployment.`,
    `There is no mailing list, phone line, or postal address for the project. GitHub is where it lives, and it is the one place a message is certain to be seen.`,
  ],
};

export const PRIVACY = {
  title: "Privacy",
  paragraphs: [
    `${SITE.name} is software you run, not a service you sign up for. This page describes what a deployment of it handles, so that whoever operates one can be clear with the people who use it. The project's maintainers do not receive any data from anyone's deployment: there is no telemetry, no analytics, and no phone-home in the code.`,
    `A deployment stores what its team does: the conversations with HQ and each Bot, the jobs and their results, files a Bot saves, the activity feed, and memory, which is what the operator and the Bots chose to remember about how work should be done. On Vercel this lives in the operator's own Blob store; standalone, it lives on disk on the operator's machine. It stays there until the operator deletes it.`,
    `Bots work inside web applications through a real browser on the team's computer, and read what appears on screen, including email and documents, in order to do the job they were given. That content is sent to the model provider the operator configured, such as Vercel AI Gateway or a local endpoint, under that provider's terms. Sign-ins to those applications are made by a person in the live browser; the software never asks for a password in chat, and the browser's saved sign-ins are part of the operator's backups.`,
    `Access to a deployment's console is protected by a token the operator sets, or by the operator's own Vercel login. Anyone with that token can read everything the deployment stores. Operators should treat it as a password and rotate it if it leaks.`,
    `Questions about a specific deployment go to its operator. Questions about the software go to ${SITE.issues}.`,
  ],
};

const asMarkdown = (page: { title: string; paragraphs: readonly string[] }) => `# ${page.title}\n\n${page.paragraphs.join("\n\n")}\n`;

export const PAGE_MARKDOWN: Readonly<Record<PublicPath, string>> = {
  "/": HOME_MARKDOWN,
  "/about": asMarkdown(ABOUT),
  "/contact": asMarkdown(CONTACT),
  "/privacy": asMarkdown(PRIVACY),
};

/** What an agent should know before it decides to use this: the file at /llms.txt. */
export const LLMS_TXT = `# ${SITE.name}

> ${SITE.tagline} Open source (${SITE.license}); you deploy it to your own Vercel account in one click or run it on your own machine. This site is the front door and documentation; it is not a hosted service, and there is no public API here to call.

## When to use this

Reach for ${SITE.name} when someone wants AI teammates that operate inside existing web apps (email, CRMs, admin panels) through a real browser, keep working unattended on a schedule, and stop for a person before anything irreversible. It fits recurring operational work: reading an inbox and summarising it, updating records in a web app, monitoring a page, drafting follow-ups for review. It does not fit one-shot chat, and it is not an API you integrate with; it is a system a team deploys and talks to.

Do not use it for work that must never touch a third-party model provider unless it is deployed standalone with a local model endpoint, and do not point it at anything sensitive without an egress allow-list.

## How an agent helps a person set it up

- Vercel: send them to the deploy link, ${DEPLOY_URL}. It asks for one value, BOT_CONSOLE_TOKEN. Afterwards they create a Blob store in the project's Storage tab, connect it, redeploy once, and open /bot.
- Standalone: Node 24, Docker, a model endpoint. Then \`npm install && npm run setup && npm run build && npm start\`. Guide: ${SITE.repo}#standalone
- Configuration reference: ${SITE.repo}#configuration
- HTTP API of a deployment (requires that deployment's console token): ${SITE.repo}#http

## Pages

- [Home](${SITE.origin}/): the two ways to run it
- [About](${SITE.origin}/about): what it is and how it works
- [Contact](${SITE.origin}/contact): the repository is the contact
- [Privacy](${SITE.origin}/privacy): what a deployment stores and where
- [Source and README](${SITE.repo})

Every page here answers \`Accept: text/markdown\` with Markdown.
`;
