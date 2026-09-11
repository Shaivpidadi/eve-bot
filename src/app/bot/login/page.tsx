import type { Metadata } from "next";

import { SetupCheck } from "./setup-check";

export const metadata: Metadata = {
  title: "Bot — sign in",
};

const MESSAGES: Readonly<Record<string, string>> = {
  invalid: "That token did not work.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { error } = await searchParams;
  if (error === "unconfigured") {
    return (
      <main className="login">
        <SetupCheck />
      </main>
    );
  }
  const message = typeof error === "string" ? MESSAGES[error] : undefined;

  return (
    <main className="login">
      {/* Posts straight to the agent's ops channel, which sets the cookie and redirects back. */}
      <form className="login-card" method="post" action="/bot/v1/session">
        <h1>Bot</h1>
        <p>Enter the console token for your workspace.</p>
        {message ? <p className="error-text">{message}</p> : null}
        <input
          type="password"
          name="token"
          autoComplete="current-password"
          placeholder="Token"
          required
          autoFocus
        />
        <button type="submit" className="btn primary">
          Continue
        </button>
      </form>
    </main>
  );
}
