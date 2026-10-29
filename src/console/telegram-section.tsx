"use client";

import { LinkIcon, SendIcon, Unlink2Icon } from "lucide-react";
import QRCode from "qrcode";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { api, errorMessage, isRecord, SignedOutError } from "./api";
import { shortWhen } from "./format";
import { Faint, PageBody, PageNote } from "./usage-page";

/**
 * Settings → Telegram (docs/plan/telegram.md): paste a token from @BotFather,
 * open the pairing link on the phone, and HQ answers there. The server picks a
 * webhook or polling by itself (agent/lib/telegram.ts).
 */

type Status =
  | { readonly connected: false }
  | {
      readonly connected: true;
      readonly username: string;
      readonly name: string;
      readonly mode: "webhook" | "polling";
      readonly webhookUrl: string | null;
      readonly chat: { readonly name: string; readonly at: string } | null;
      readonly pairLink: string | null;
    };

const asStatus = (body: unknown): Status | null => (isRecord(body) && typeof body.connected === "boolean" ? (body as unknown as Status) : null);

export function TelegramSection() {
  const [status, setStatus] = useState<Status | null>(null);
  const [token, setToken] = useState("");
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const call = useCallback(async (path: string, method: string, body?: unknown, fallback = "Could not reach the server.") => {
    setBusy(true);
    setError(null);
    try {
      const response = await api(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const answer: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setError(isRecord(answer) && typeof answer.error === "string" ? answer.error : await errorMessage(response, fallback));
        return null;
      }
      return answer;
    } catch (caught) {
      if (!(caught instanceof SignedOutError)) setError(fallback);
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const load = useCallback(async () => {
    const next = asStatus(await call("/bot/v1/telegram", "GET", undefined, "Could not load Telegram."));
    if (next !== null) setStatus(next);
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  // Waiting to be paired: look again every few seconds, so the page moves on when the phone opens the link.
  const waiting = status?.connected === true && status.chat === null;
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => void api("/bot/v1/telegram").then(async (response) => {
      const next = asStatus(await response.json().catch(() => null));
      if (next !== null && next.connected && next.chat !== null) setStatus(next);
    }).catch(() => undefined), 3_000);
    return () => window.clearInterval(timer);
  }, [waiting]);

  const pairLink = status?.connected === true ? status.pairLink : null;
  useEffect(() => {
    if (pairLink === null) return setQr(null);
    let live = true;
    void QRCode.toString(pairLink, { type: "svg", margin: 1, width: 168 }).then((svg) => live && setQr(svg)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [pairLink]);

  const connect = async () => {
    setNote(null);
    const next = asStatus(await call("/bot/v1/telegram", "POST", { token }, "Could not connect the bot."));
    if (next === null) return;
    setToken("");
    setStatus(next);
  };

  const pairAgain = async () => {
    setNote(null);
    const next = asStatus(await call("/bot/v1/telegram/pair", "POST"));
    if (next !== null) setStatus(next);
  };

  const test = async () => {
    setNote(null);
    if ((await call("/bot/v1/telegram/test", "POST", undefined, "Could not send a test.")) !== null) setNote("Sent. It should be in the chat now.");
  };

  const disconnect = async () => {
    setNote(null);
    const next = asStatus(await call("/bot/v1/telegram", "DELETE"));
    if (next !== null) setStatus(next);
  };

  return (
    <PageBody className="max-w-[760px]">
      <PageNote>Text HQ from your phone. It answers as it does here, starts jobs, and sends you approvals and alerts as they happen.</PageNote>
      {error === null ? null : <p className="m-0 text-xs text-destructive">{error}</p>}
      {note === null ? null : <p className="m-0 text-xs text-brand">{note}</p>}

      {status === null ? null : !status.connected ? (
        <div className="flex flex-col gap-3 rounded-[14px] border border-input bg-card px-4 py-3 text-[13px]">
          <ol className="m-0 flex list-decimal flex-col gap-1 pl-5 text-muted-foreground">
            <li>
              In Telegram, open{" "}
              <a className="text-foreground underline" href="https://t.me/BotFather" target="_blank" rel="noreferrer">
                @BotFather
              </a>{" "}
              and send <code>/newbot</code>. Pick any name.
            </li>
            <li>It answers with a token. Paste it here.</li>
          </ol>
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              void connect();
            }}
          >
            <Input value={token} onChange={(event) => setToken(event.target.value)} placeholder="123456789:AA…" autoComplete="off" spellCheck={false} aria-label="Bot token" className="font-mono text-[12.5px]" />
            <Button type="submit" size="sm" disabled={busy || token.trim().length < 20}>
              <LinkIcon /> Connect
            </Button>
          </form>
        </div>
      ) : (
        <>
          <div className="flex flex-col divide-y divide-border overflow-hidden rounded-[14px] border border-input bg-card text-[13px]">
            <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <b className="font-medium">
                  {status.name} ·{" "}
                  <a className="underline" href={`https://t.me/${status.username}`} target="_blank" rel="noreferrer">
                    @{status.username}
                  </a>
                </b>
                <span className="text-xs text-muted-foreground">
                  {status.mode === "webhook" ? "Telegram sends messages to this deployment." : "This server asks Telegram for messages, so it needs no public address. It answers while the server runs."}
                </span>
              </div>
              <div className="flex flex-none items-center gap-2">
                {status.chat === null ? null : (
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => void test()}>
                    <SendIcon /> Send a test
                  </Button>
                )}
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void disconnect()}>
                  <Unlink2Icon /> Disconnect
                </Button>
              </div>
            </div>
            {status.chat === null ? (
              <div className="flex flex-col items-start gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-5">
                {qr === null ? null : <div className="flex-none overflow-hidden rounded-md bg-white p-1" aria-label="Pairing QR code" dangerouslySetInnerHTML={{ __html: qr }} />}
                <div className="flex min-w-0 flex-col gap-1">
                  <b className="font-medium">Pair your phone</b>
                  <span className="text-xs text-muted-foreground">Scan the code with your phone&apos;s camera, or open the link, then press Start in Telegram. Only that chat can talk to HQ.</span>
                  <a className="break-all text-xs underline" href={status.pairLink ?? "#"} target="_blank" rel="noreferrer">
                    {status.pairLink}
                  </a>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-4 px-4 py-3">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <b className="font-medium">Paired with {status.chat.name}</b>
                  <span className="text-xs text-muted-foreground">Since {shortWhen(status.chat.at)}. Other chats are refused.</span>
                </div>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void pairAgain()}>
                  Pair another chat
                </Button>
              </div>
            )}
          </div>
          <Faint>Alerts follow your choices under Notifications. The chat is its own conversation with HQ; jobs and the feed are shared with the console.</Faint>
        </>
      )}
    </PageBody>
  );
}
