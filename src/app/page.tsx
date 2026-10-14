import type { Metadata } from "next";
import type { ReactNode } from "react";

import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

import { DEPLOY_URL as DEPLOY, SITE } from "../site/content";
import { LANDING, SiteFooter } from "../site/page";

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
    <main className={LANDING}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(STRUCTURED_DATA) }} />
      <header className="flex flex-col items-start gap-3">
        <span className="text-[34px] leading-none" aria-hidden="true">
          🧭
        </span>
        <h1 className="m-0 text-[28px] font-[650] tracking-[-0.01em]">EVE BOT</h1>
        <p className="m-0 max-w-[620px] text-[15px] leading-normal text-muted-foreground">
          A team of always-on AI teammates. Each one has its own computer, works inside the apps you already use, and
          keeps going after you close the laptop, coming back only when something needs your approval.
        </p>
        <p className="mt-2 mb-0 text-[15px] leading-normal font-[550] text-foreground">Where do you want it to run?</p>
      </header>

      <section className="grid grid-cols-2 gap-4 max-[720px]:grid-cols-1">
        <PathCard>
          <h2 className="m-0 text-[17px] font-semibold">On Vercel</h2>
          <p className={LEDE}>One click. Vercel runs the computer, the models, the storage, and the schedules, and bills your account.</p>
          <ul className="m-0 flex list-disc flex-col gap-1 pl-[18px] text-[13px] leading-[1.55] text-muted-foreground">
            <li>Copies this repository to your GitHub, creates the project, and deploys it.</li>
            <li>
              Asks for one thing: a console password. <Code>openssl rand -base64 32</Code> makes a good one.
            </li>
            <li>
              Then, in the project&apos;s Storage tab, create a Blob store and connect it. It holds the roster, jobs, and
              memory. Redeploy once.
            </li>
            <li>The team&apos;s computer is a Vercel Sandbox; models go through AI Gateway.</li>
          </ul>
          <a className={buttonVariants({ size: "lg", className: CTA })} href={DEPLOY}>
            Deploy to Vercel
          </a>
          <p className={FINE}>
            Open <Code>/bot</Code> on your deployment and sign in with the password; the setup page there checks each
            step off. Hobby plans work; Pro runs the watchdog every minute.
          </p>
        </PathCard>

        <PathCard>
          <h2 className="m-0 text-[17px] font-semibold">On your own machine</h2>
          <p className={LEDE}>
            Nothing leaves your network unless you point it there. The computer runs in Docker, models come from Ollama,
            LM Studio, OpenRouter, or any OpenAI-compatible API, and storage is on disk.
          </p>
          <p className="m-0 text-[13px] font-medium">You need Node 24, Docker, and a model endpoint.</p>
          <Pre>{`git clone ${REPO}.git && cd eve-bot
npm install
npm run setup        # pick "Standalone", answer a few questions
npm run build && npm start
# open http://localhost:3000/bot`}</Pre>
          <p className={FINE}>Or as containers, with a SearXNG for web search and an optional Ollama alongside:</p>
          <Pre>{`npm run setup
docker compose up -d --build`}</Pre>
          <a className={buttonVariants({ variant: "secondary", size: "lg", className: CTA })} href={`${REPO}#standalone`}>
            Read the standalone guide
          </a>
        </PathCard>
      </section>

      <section>
        <h2 className="mt-0 mb-3.5 text-[15px] font-semibold">Either way, this is what you get</h2>
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 max-[720px]:grid-cols-1">
          <Feature title="HQ and a roster">
            Message HQ like a colleague. It writes a brief, picks the right Bot, and hands off the job.
          </Feature>
          <Feature title="A computer the team keeps">
            One real Chrome, a terminal, and files, shared by every Bot and backed up while they work.
          </Feature>
          <Feature title="Watch and take over">
            The screen sits in every thread. Sign-ins, codes, and CAPTCHAs are yours; passwords never touch chat.
          </Feature>
          <Feature title="Durable jobs">
            Work survives restarts and redeploys, waits for its start time without compute, and asks before anything irreversible.
          </Feature>
        </div>
      </section>

      <SiteFooter
        links={[
          { href: "/bot", label: "Already running here? Open the console" },
          { href: REPO, label: "Source on GitHub" },
          { href: "/about", label: "About" },
          { href: "/contact", label: "Contact" },
          { href: "/privacy", label: "Privacy" },
        ]}
        trailing="MIT"
      />
    </main>
  );
}

const LEDE = "m-0 text-[13.5px] leading-normal text-muted-foreground";
const FINE = "m-0 text-xs leading-normal text-faint";
const CTA = "mt-auto h-auto px-3.5 py-2.5 text-[13.5px]";

/** One of the two ways to run it. */
function PathCard({ children }: { children: ReactNode }) {
  return <Card className="min-w-0 gap-3 rounded-2xl p-[22px] ring-input">{children}</Card>;
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-foreground/15 px-[5px] py-px font-mono text-xs">{children}</code>;
}

function Pre({ children }: { children: string }) {
  return (
    <pre className="m-0 overflow-x-auto rounded-[10px] border border-border bg-foreground/[0.06] px-3 py-2.5 font-mono text-xs leading-[1.55]">
      <code>{children}</code>
    </pre>
  );
}

function Feature({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-[3px] text-[13px] leading-normal">
      <b className="font-semibold">{title}</b>
      <span className="text-muted-foreground">{children}</span>
    </div>
  );
}
