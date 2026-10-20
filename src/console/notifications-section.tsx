"use client";

import { BellIcon, BellOffIcon, SendIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

import { api, errorMessage, isRecord, SignedOutError } from "./api";
import { shortWhen } from "./format";
import { Faint, PageBody, PageNote } from "./usage-page";

/**
 * Settings → Notifications (docs/plan/notifications.md, N2): turn push
 * notifications on for this device, see the others, and send a test. The
 * server keeps one subscription per device and person (agent/lib/push.ts).
 */

interface Device {
  readonly id: string;
  readonly device: string;
  readonly at: string;
}

type Support = "yes" | "install-first" | "no";

function support(): Support {
  if (typeof window === "undefined") return "no";
  const pushable = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (pushable) return "yes";
  // Safari on iPhone and iPad offers push only to the console installed to the Home Screen.
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return ios ? "install-first" : "no";
}

/** The server's id for a subscription: the first 24 hex digits of its endpoint's SHA-256 (see `subscriptionId`). */
async function idOf(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

/** A VAPID public key, as `pushManager.subscribe` takes it. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

/** The console's service worker, waiting a little for it rather than for ever. */
async function worker(): Promise<ServiceWorkerRegistration | null> {
  const registration = await navigator.serviceWorker.getRegistration("/bot");
  if (registration?.active) return registration;
  return Promise.race([navigator.serviceWorker.ready, new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000))]);
}

export function NotificationsSection() {
  const [supported] = useState<Support>(support);
  const [devices, setDevices] = useState<readonly Device[] | null>(null);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [thisDevice, setThisDevice] = useState<string | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | "unknown">(() => (typeof Notification === "undefined" ? "unknown" : Notification.permission));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await api("/bot/v1/push");
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok || !isRecord(body) || !Array.isArray(body.devices)) {
        setError(await errorMessage(response, "Could not load notifications."));
        return;
      }
      setDevices(body.devices as Device[]);
      setPublicKey(typeof body.publicKey === "string" ? body.publicKey : null);
      if (supported === "yes") {
        const subscription = await (await worker())?.pushManager.getSubscription();
        setThisDevice(subscription ? await idOf(subscription.endpoint) : null);
      }
    } catch (caught) {
      if (!(caught instanceof SignedOutError)) setError("Could not load notifications.");
    }
  }, [supported]);

  useEffect(() => {
    void load();
  }, [load]);

  const turnOn = async () => {
    if (publicKey === null) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const granted = await Notification.requestPermission();
      setPermission(granted);
      if (granted !== "granted") {
        setError(granted === "denied" ? "Notifications are blocked for this site. Allow them in the browser's settings, then try again." : "Notifications were not allowed.");
        return;
      }
      const registration = await worker();
      if (registration === null) {
        setError("The app's service worker is not running. Reload the page and try again.");
        return;
      }
      const subscription = (await registration.pushManager.getSubscription()) ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
      const response = await api("/bot/v1/push/devices", { method: "POST", body: JSON.stringify({ subscription: subscription.toJSON() }) });
      if (!response.ok) {
        setError(await errorMessage(response, "Could not turn notifications on."));
        return;
      }
      setNote("Notifications are on for this device.");
      await load();
    } catch (caught) {
      if (!(caught instanceof SignedOutError)) setError(caught instanceof Error ? `Could not turn notifications on: ${caught.message}` : "Could not turn notifications on.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      if (id === thisDevice) await (await (await worker())?.pushManager.getSubscription())?.unsubscribe();
      await api(`/bot/v1/push/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
      await load();
    } catch (caught) {
      if (!(caught instanceof SignedOutError)) setError("Could not remove that device.");
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const response = await api("/bot/v1/push/test", { method: "POST" });
      const body = (await response.json().catch(() => null)) as { sent?: number; queued?: number; refused?: number; gone?: number } | null;
      if (!response.ok || body === null) setError(await errorMessage(response, "Could not send a test."));
      else if ((body.sent ?? 0) > 0) setNote(`Sent to ${body.sent} device${body.sent === 1 ? "" : "s"}. It should arrive in a few seconds.`);
      else if ((body.queued ?? 0) > 0) setNote("The push service is busy; it will be tried again in a minute.");
      else setError("No device took it. Turn notifications on again on this device.");
      if ((body?.gone ?? 0) > 0) await load();
    } catch (caught) {
      if (!(caught instanceof SignedOutError)) setError("Could not send a test.");
    } finally {
      setBusy(false);
    }
  };

  const on = thisDevice !== null && (devices ?? []).some((device) => device.id === thisDevice);

  return (
    <PageBody className="max-w-[760px]">
      <PageNote>
        A Bot reaches you here when it needs you: an approval, a question, a job that finished or failed. Pressing one opens what it is about; nothing is
        approved from a notification.
      </PageNote>
      {supported === "install-first" ? (
        <PageNote>On iPhone and iPad, install the app first: Share, then Add to Home Screen. Then open it from the Home Screen and turn notifications on here.</PageNote>
      ) : supported === "no" ? (
        <PageNote>This browser cannot receive push notifications.</PageNote>
      ) : null}
      {error === null ? null : <p className="m-0 text-xs text-destructive">{error}</p>}
      {note === null ? null : <p className="m-0 text-xs text-brand">{note}</p>}

      <div className="flex flex-col divide-y divide-border overflow-hidden rounded-[14px] border border-input bg-card text-[13px]">
        <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <b className="font-medium">This device</b>
            <span className="text-xs text-muted-foreground">
              {on ? "Notifications are on." : permission === "denied" ? "Blocked in this browser's settings." : "Notifications are off."}
            </span>
          </div>
          <div className="flex flex-none items-center gap-2">
            {on ? (
              <>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void test()}>
                  <SendIcon /> Send a test
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove(thisDevice!)}>
                  <BellOffIcon /> Turn off
                </Button>
              </>
            ) : (
              <Button size="sm" disabled={busy || supported !== "yes" || publicKey === null || permission === "denied"} onClick={() => void turnOn()}>
                <BellIcon /> Turn on
              </Button>
            )}
          </div>
        </div>
        {(devices ?? [])
          .filter((device) => device.id !== thisDevice)
          .map((device) => (
            <div key={device.id} className="flex items-center gap-4 px-4 py-3">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <b className="font-medium">{device.device}</b>
                <span className="text-xs text-muted-foreground">On since {shortWhen(device.at)}</span>
              </div>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove(device.id)}>
                Remove
              </Button>
            </div>
          ))}
      </div>
      <Faint>Each device is turned on from itself. Removing one here stops notifications to it.</Faint>
    </PageBody>
  );
}
