"use client";

import { useEffect, useState, type ReactNode } from "react";

interface Setup {
  readonly platform: "vercel" | "local";
  readonly protected: boolean | null;
  readonly tokens: boolean;
  readonly storage: { readonly driver: string; readonly ready: boolean };
  readonly computer: { readonly backend: string; readonly ready: boolean };
}

const PROTECTION_SETTINGS =
  "https://vercel.com/d?to=%2F%5Bteam%5D%2F%5Bproject%5D%2Fsettings%2Fdeployment-protection&title=Deployment+Protection";
const ENV_SETTINGS =
  "https://vercel.com/d?to=%2F%5Bteam%5D%2F%5Bproject%5D%2Fsettings%2Fenvironment-variables&title=Environment+Variables";
const STORAGE_SETTINGS ="https://vercel.com/d?to=%2F%5Bteam%5D%2F%5Bproject%5D%2Fstores&title=Storage";

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

  return (
    <div className="login-card">
      <h1>Set up Bot</h1>
      <p>This copy of Bot runs in your own Vercel account. A few things are left before it opens.</p>
      {failed ? <p className="error-text">Could not check this deployment. Reload to try again.</p> : null}
      {setup === null && !failed ? <p className="faint">Checking this deployment…</p> : null}
      {setup === null ? null : (
        <ul className="setup-list">
          <Step
            done={setup.platform !== "vercel" || setup.protected === true || setup.tokens}
            title="Only you can open it"
          >
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
      )}
      <a className="btn primary" href="/bot">
        Check again
      </a>
    </div>
  );
}

function Step({ done, title, children }: { done: boolean; title: string; children: ReactNode }) {
  return (
    <li className={done ? "done" : undefined}>
      <b>{`${done ? "✓" : "○"} ${title}`}</b>
      {done ? null : <p className="faint">{children}</p>}
    </li>
  );
}
