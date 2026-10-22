"use client";

import { useEffect, useState, type ReactNode } from "react";

import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

import { LOGIN_CARD } from "./styles";

interface Setup {
  readonly platform: "vercel" | "local";
  readonly protected: boolean | null;
  readonly tokens: boolean;
  readonly storage: { readonly driver: string; readonly ready: boolean };
  readonly computer: { readonly backend: string; readonly ready: boolean };
  /** Whether the Bots can reach a model (absent from a server older than this page). */
  readonly models?: { readonly via: "gateway" | "endpoint"; readonly ready: boolean };
}

const PROTECTION_SETTINGS =
  "https://vercel.com/d?to=%2F%5Bteam%5D%2F%5Bproject%5D%2Fsettings%2Fdeployment-protection&title=Deployment+Protection";
const ENV_SETTINGS =
  "https://vercel.com/d?to=%2F%5Bteam%5D%2F%5Bproject%5D%2Fsettings%2Fenvironment-variables&title=Environment+Variables";
const STORAGE_SETTINGS = "https://vercel.com/d?to=%2F%5Bteam%5D%2F%5Bproject%5D%2Fstores&title=Storage";

/** The setup steps; their links and code stay legible in the faint text. */
const STEPS =
  "m-0 grid list-none gap-2.5 p-0 [&_a]:text-inherit [&_a]:underline [&_code]:rounded [&_code]:bg-foreground/15 [&_code]:px-1 [&_code]:font-mono [&_code]:text-[11px]";

/** What a new deployment still needs before the console opens. */
export function SetupCheck() {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/bot/v1/setup", { cache: "no-store" })
      .then((response) => (response.ok ? (response.json() as Promise<Setup>) : Promise.reject(new Error("setup"))))
      .then((value) => {
        if (!cancelled) setSetup(value);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const vercel = setup?.platform === "vercel";

  return (
    <Card className={cn(LOGIN_CARD, "w-[min(100%,340px)]")}>
      <h1 className="m-0 text-[15px] font-semibold">Set up Bot</h1>
      <p className="-mt-2 mb-0 text-muted-foreground">
        {setup === null || vercel
          ? "This copy of Bot runs in your own Vercel account. A few things are left before it opens."
          : "This copy of Bot runs on your own server. A few things are left before it opens."}
      </p>
      {failed ? <p className="m-0 text-xs text-destructive">Could not check this deployment. Reload to try again.</p> : null}
      {setup === null && !failed ? <p className="m-0 text-[11.5px] text-faint">Checking this deployment…</p> : null}
      {setup === null ? null : vercel ? <VercelSteps setup={setup} /> : <StandaloneSteps setup={setup} />}
      <a className={buttonVariants({ className: "h-9" })} href="/bot">
        Check again
      </a>
    </Card>
  );
}

function VercelSteps({ setup }: { setup: Setup }) {
  return (
    <ul className={STEPS}>
      <Step done={setup.protected === true || setup.tokens} title="Only you can open it">
        In your project&apos;s{" "}
        <a href={ENV_SETTINGS} target="_blank" rel="noopener noreferrer">
          Environment Variables
        </a>
        , set BOT_CONSOLE_TOKEN to a long random password, redeploy, and sign in with it. Or turn on Vercel
        Authentication for All Deployments in{" "}
        <a href={PROTECTION_SETTINGS} target="_blank" rel="noopener noreferrer">
          Deployment Protection
        </a>
        ; the default Standard Protection leaves the production address public.
      </Step>
      <Step done={setup.storage.ready} title="Storage">
        Connect a Blob store to the project in{" "}
        <a href={STORAGE_SETTINGS} target="_blank" rel="noopener noreferrer">
          Storage
        </a>
        , then redeploy.
      </Step>
      <Step done={setup.computer.ready} title="The team's computer">
        Vercel Sandbox signs in with the project&apos;s OIDC credentials. Redeploy on Vercel, or run{" "}
        <code>vercel link &amp;&amp; vercel env pull</code> to use it locally.
      </Step>
    </ul>
  );
}

function StandaloneSteps({ setup }: { setup: Setup }) {
  return (
    <ul className={STEPS}>
      <Step done={setup.tokens} title="Only you can open it">
        Run <code>npm run setup</code>, which writes <code>.env</code> with a console token, or set BOT_CONSOLE_TOKEN
        there yourself to a long random password (<code>openssl rand -base64 32</code> makes a good one). Then
        restart the server and sign in with it.
      </Step>
      <Step done={setup.storage.ready} title="Storage">
        The roster, jobs, and memory are kept on disk in <code>.data</code>. Keep that folder on storage that
        survives a restart.
      </Step>
      <Step done={setup.computer.ready} title="The team's computer">
        {setup.computer.backend === "vercel" ? (
          <>
            Set <code>BOT_COMPUTER=local</code> to run the team&apos;s computer in Docker on this machine, or run{" "}
            <code>vercel link &amp;&amp; vercel env pull</code> to use Vercel Sandbox.
          </>
        ) : (
          <>
            The computer runs in Docker, and Docker is not answering. Start Docker Desktop, OrbStack or Colima, or point{" "}
            <code>EVE_DOCKER_PATH</code> at your docker CLI, then reload this page.
          </>
        )}
      </Step>
      {setup.models === undefined ? null : (
        <Step done={setup.models.ready} title="Models">
          {setup.models.via === "gateway" ? (
            <>
              Put <code>AI_GATEWAY_API_KEY</code> in <code>.env</code> (vercel.com → AI Gateway → API Keys), or point{" "}
              <code>BOT_MODEL_BASE_URL</code> at your own OpenAI-compatible endpoint. <code>npm run setup</code> asks.
            </>
          ) : (
            <>
              Nothing answered at <code>BOT_MODEL_BASE_URL</code>. Start your model server (Ollama, LM Studio, …), or check the
              address and <code>BOT_MODEL_API_KEY</code> in <code>.env</code>, then reload this page.
            </>
          )}
        </Step>
      )}
    </ul>
  );
}

function Step({ done, title, children }: { done: boolean; title: string; children: ReactNode }) {
  return (
    <li className="grid gap-1">
      <b className={done ? "font-medium text-muted-foreground" : "font-semibold"}>{`${done ? "✓" : "○"} ${title}`}</b>
      {done ? null : <p className="m-0 text-[11.5px] leading-[1.45] text-faint">{children}</p>}
    </li>
  );
}
