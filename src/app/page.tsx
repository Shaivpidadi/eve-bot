import type { Metadata } from "next";

import { DEPLOY_URL as DEPLOY, SITE } from "../site/content";

const REPO = SITE.repo;
const DESCRIPTION =
  "Always-on AI teammates with a computer of their own. Deploy to your Vercel account in one click, or run the whole thing standalone.";

export const metadata: Metadata = {
  title: { absolute: `${SITE.name}: run it on Vercel or on your own machine` },
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: SITE.name,
    title: `${SITE.name}: run it on Vercel or on your own machine`,
    description: DESCRIPTION,
    images: ["/apple-icon.png"],
  },
  twitter: { card: "summary", title: SITE.name, description: DESCRIPTION, images: ["/apple-icon.png"] },
};

/**
 * Who this is, for machines: the software, and the project that publishes it.
 * The project has no office or phone, so it says so by giving only what exists.
 */
const STRUCTURED_DATA = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      "@id": `${SITE.origin}/#software`,
      name: SITE.name,
      alternateName: SITE.shortName,
      description: DESCRIPTION,
      url: SITE.origin,
      applicationCategory: "BusinessApplication",
      operatingSystem: "Vercel, Linux, macOS (Node 24 and Docker)",
      softwareVersion: "alpha",
      license: "https://opensource.org/licenses/MIT",
      isAccessibleForFree: true,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      installUrl: DEPLOY,
      downloadUrl: REPO,
      sameAs: [REPO],
      author: { "@id": `${SITE.origin}/#org` },
    },
    {
      "@type": "Organization",
      "@id": `${SITE.origin}/#org`,
      name: `${SITE.name} project`,
      url: SITE.origin,
      logo: `${SITE.origin}/apple-icon.png`,
      sameAs: [REPO],
      contactPoint: [{ "@type": "ContactPoint", contactType: "technical support", url: SITE.issues, availableLanguage: "English" }],
    },
    {
      "@type": "WebSite",
      "@id": `${SITE.origin}/#site`,
      name: SITE.name,
      url: SITE.origin,
      publisher: { "@id": `${SITE.origin}/#org` },
    },
  ],
};

/**
 * The front door. Two ways to run Bot, and which to pick: on Vercel, where a
 * button does the work, or on a machine you own, where a wizard does. Anyone
 * already running Bot here goes straight to the console.
 */
export default function Home() {
  return (
    <main className="landing">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(STRUCTURED_DATA) }} />
      <header className="landing-head">
        <span className="landing-mark" aria-hidden="true">
          🧭
        </span>
        <h1>EVE BOT</h1>
        <p>
          A team of always-on AI teammates. Each one has its own computer, works inside the apps you already use, and
          keeps going after you close the laptop, coming back only when something needs your approval.
        </p>
        <p className="landing-question">Where do you want it to run?</p>
      </header>

      <section className="landing-paths">
        <article className="landing-card">
          <h2>On Vercel</h2>
          <p className="landing-lede">One click. Vercel runs the computer, the models, the storage, and the schedules, and bills your account.</p>
          <ul>
            <li>Copies this repository to your GitHub and creates the project.</li>
            <li>Connects a private Blob store for the roster, jobs, and memory.</li>
            <li>Asks for one thing: a console password. <code>openssl rand -base64 32</code> makes a good one.</li>
            <li>The team&apos;s computer is a Vercel Sandbox; models go through AI Gateway, with Jev routing the small decisions.</li>
          </ul>
          <a className="btn primary landing-cta" href={DEPLOY}>
            Deploy to Vercel
          </a>
          <p className="landing-fine">
            Then open <code>/bot</code> on your deployment and sign in with the password. Hobby plans work; Pro runs the
            watchdog every minute.
          </p>
        </article>

        <article className="landing-card">
          <h2>On your own machine</h2>
          <p className="landing-lede">
            Nothing leaves your network unless you point it there. The computer runs in Docker, models come from Ollama,
            LM Studio, OpenRouter, or any OpenAI-compatible API, and storage is on disk.
          </p>
          <p className="landing-need">You need Node 24, Docker, and a model endpoint.</p>
          <pre>
            <code>{`git clone ${REPO}.git && cd eve-bot
npm install
npm run setup        # pick "Standalone", answer a few questions
npm run build && npm start
# open http://localhost:3000/bot`}</code>
          </pre>
          <p className="landing-fine">
            Or as containers, with a SearXNG for web search and an optional Ollama alongside:
          </p>
          <pre>
            <code>{`npm run setup
docker compose up -d --build`}</code>
          </pre>
          <a className="btn landing-cta" href={`${REPO}#standalone`}>
            Read the standalone guide
          </a>
        </article>
      </section>

      <section className="landing-how">
        <h2>Either way, this is what you get</h2>
        <div className="landing-grid">
          <div>
            <b>HQ and a roster</b>
            <span>Message HQ like a colleague. It writes a brief, picks the right Bot, and hands off the job.</span>
          </div>
          <div>
            <b>A computer the team keeps</b>
            <span>One real Chrome, a terminal, and files, shared by every Bot and backed up while they work.</span>
          </div>
          <div>
            <b>Watch and take over</b>
            <span>The screen sits in every thread. Sign-ins, codes, and CAPTCHAs are yours; passwords never touch chat.</span>
          </div>
          <div>
            <b>Durable jobs</b>
            <span>Work survives restarts and redeploys, waits for its start time without compute, and asks before anything irreversible.</span>
          </div>
        </div>
      </section>

      <footer className="landing-foot">
        <a href="/bot">Already running here? Open the console</a>
        <span aria-hidden="true">·</span>
        <a href={REPO}>Source on GitHub</a>
        <span aria-hidden="true">·</span>
        <a href="/about">About</a>
        <span aria-hidden="true">·</span>
        <a href="/contact">Contact</a>
        <span aria-hidden="true">·</span>
        <a href="/privacy">Privacy</a>
        <span aria-hidden="true">·</span>
        <span>MIT</span>
      </footer>
    </main>
  );
}
