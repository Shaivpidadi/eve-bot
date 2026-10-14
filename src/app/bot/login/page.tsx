import type { Metadata } from "next";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

import { LOGIN, LOGIN_CARD, SetupCheck } from "./setup-check";

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
      <main className={LOGIN}>
        <SetupCheck />
      </main>
    );
  }
  const message = typeof error === "string" ? MESSAGES[error] : undefined;

  return (
    <main className={LOGIN}>
      {/* Posts straight to the agent's ops channel, which sets the cookie and redirects back. */}
      <form className="w-[min(100%,340px)]" method="post" action="/bot/v1/session">
        <Card className={LOGIN_CARD}>
          <h1 className="m-0 text-[15px] font-semibold">Bot</h1>
          <p className="-mt-2 mb-0 text-muted-foreground">Enter the console token for your workspace.</p>
          {message ? <p className="m-0 text-xs text-destructive">{message}</p> : null}
          <Input
            className="h-9 rounded-[9px] border-transparent bg-secondary px-[11px] text-[13px] md:text-[13px] dark:bg-secondary"
            type="password"
            name="token"
            autoComplete="current-password"
            placeholder="Token"
            required
            autoFocus
          />
          <Button type="submit" className="h-9">
            Continue
          </Button>
        </Card>
      </form>
    </main>
  );
}
