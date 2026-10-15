"use client";

import {
  ArrowLeftIcon,
  BrainIcon,
  ChevronDownIcon,
  ClockIcon,
  GlobeIcon,
  LogOutIcon,
  type LucideIcon,
  MailIcon,
  PencilIcon,
  PlugIcon,
  TerminalIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Item, ItemActions, ItemContent, ItemMedia } from "@/components/ui/item";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

import { BrandMark } from "./brands";

import { guessedReads, toolEffect, type CatalogEntry, type ConnectorGate, type ConnectorKeyKind } from "../../agent/lib/catalog";

import { api, errorMessage, isRecord, SignedOutError } from "./api";
import { Faint, PageBody, PageError, PageFrame, PageLoading, PageNote, PageSection } from "./usage-page";

interface ConnectorRow {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly catalog: string | null;
  readonly url: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly gate: ConnectorGate;
  readonly auth: { readonly kind: ConnectorKeyKind; readonly header?: string; readonly connected?: boolean; readonly connectedAt?: string | null; readonly issuer?: string };
  readonly check: { readonly ok: boolean; readonly at: string; readonly tools: readonly string[]; readonly error: string | null };
  readonly policy?: Readonly<Record<string, "read" | "write">>;
  /** Tools whose read/write a person set here; the rest are guesses from the name. */
  readonly reviewed?: readonly string[];
  readonly disabledTools?: readonly string[];
  readonly createdAt: string;
  readonly createdBy: string;
}

/** What every Bot has without connecting anything. */
const BUILT_IN: readonly { icon: LucideIcon; title: string; detail: string }[] = [
  { icon: GlobeIcon, title: "Browser", detail: "Signs in and works inside the web apps you use" },
  { icon: TerminalIcon, title: "Computer", detail: "A shell and files on its own machine" },
  { icon: MailIcon, title: "Email", detail: "Drafts freely, sends only after you approve" },
  { icon: BrainIcon, title: "Memory", detail: "Remembers how you and your team like things done" },
  { icon: ClockIcon, title: "Routines", detail: "Starts work on a schedule, without a prompt" },
];

const GATE_LABEL: Readonly<Record<ConnectorGate, string>> = {
  none: "Never",
  writes: "Before a Bot changes anything",
  all: "Before each tool's first use in a job",
};

const GATE_ITEMS = (Object.keys(GATE_LABEL) as ConnectorGate[]).map((value) => ({ value, label: GATE_LABEL[value] }));

const KEY_LABEL: Readonly<Record<ConnectorKeyKind, string>> = {
  none: "No key needed",
  bearer: "Bearer key",
  header: "Key in a header",
  oauth: "Signed in",
};

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const when = (at: string) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** `create_pull_request` reads as "Create pull request". */
const humanTool = (tool: string) => {
  const bare = tool.split("__").pop() ?? tool;
  const words = bare.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The connector's app icon: its brand, its site's icon, or its initial (see `brands.tsx`). */
function Mark({ label, brand, url, size = 44 }: { label: string; brand?: string | null; url?: string | null; size?: number }) {
  return <BrandMark brand={brand} label={label} url={url} size={size} />;
}

function Toggle({ checked, disabled, onChange, label }: { checked: boolean; disabled?: boolean; onChange: (next: boolean) => void; label: string }) {
  return <Switch checked={checked} disabled={disabled} aria-label={label} title={label} onCheckedChange={(next) => onChange(next)} />;
}

/** "Ask me first": when a person is asked before a Bot uses the connector. */
function GateSelect({ value, disabled, onChange, className }: { value: ConnectorGate; disabled?: boolean; onChange: (next: ConnectorGate) => void; className?: string }) {
  return (
    <Select items={GATE_ITEMS} value={value} disabled={disabled} onValueChange={(next) => next !== null && onChange(next as ConnectorGate)}>
      <SelectTrigger size="sm" className={cn("min-w-0 bg-secondary text-[12.5px] dark:bg-secondary", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {GATE_ITEMS.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** A connector's state, as a pill. */
function Status({ tone, children }: { tone: "ok" | "bad" | "off"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "flex-none rounded-full px-2.5 py-0.5 text-xs font-medium",
        tone === "ok" ? "bg-success/12 text-success" : tone === "bad" ? "bg-destructive/12 text-destructive" : "bg-secondary text-faint",
      )}
    >
      {children}
    </span>
  );
}

/** A boxed list of settings rows. */
function List({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("flex flex-col divide-y divide-border overflow-hidden rounded-[14px] border border-input bg-card", className)}>{children}</div>;
}

const rowCls = "flex min-h-12 w-full items-center gap-3 px-4 py-3 text-left text-[13px]";
const rowBtnCls = cn(rowCls, "cursor-pointer text-foreground hover:bg-accent disabled:cursor-default disabled:opacity-60");

function Row({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn(rowCls, className)}>{children}</div>;
}

/** A row's words: a title line and a quieter line under it. */
function RowMain({ title, children }: { title?: ReactNode; children?: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      {title === undefined ? null : <b className="font-medium">{title}</b>}
      {children === undefined ? null : <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{children}</span>}
    </span>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="font-mono text-[11.5px] text-faint">{children}</code>;
}

const linkCls = "text-xs text-muted-foreground no-underline hover:text-foreground";

/** A connector as a card: its icon, name, a line about it, a quiet detail, and what to do. */
function ConnectorCard({
  mark,
  title,
  line,
  detail,
  aside,
  onClick,
  off,
}: {
  mark: ReactNode;
  title: string;
  line: ReactNode;
  detail: ReactNode;
  aside: ReactNode;
  onClick?: () => void;
  off?: boolean;
}) {
  const body = (
    <>
      <ItemMedia>{mark}</ItemMedia>
      <ItemContent className="min-w-0 gap-px">
        <b className="text-[13.5px] font-semibold">{title}</b>
        <span className="truncate text-xs text-muted-foreground">{line}</span>
        <small className="text-[11.5px] text-faint">{detail}</small>
      </ItemContent>
      <ItemActions className="flex-none">{aside}</ItemActions>
    </>
  );
  const look = cn("min-w-0 flex-nowrap gap-3 rounded-[14px] border-input bg-card px-3.5 py-3 text-left", off && "opacity-60");
  return onClick === undefined ? (
    <Item variant="outline" className={look}>
      {body}
    </Item>
  ) : (
    <Item variant="outline" className={cn(look, "cursor-pointer hover:border-brand")} render={<button type="button" onClick={onClick} />}>
      {body}
    </Item>
  );
}

const needsConnect = (connector: ConnectorRow) => connector.auth.kind === "oauth" && connector.auth.connected !== true;

function statusOf(connector: ConnectorRow): { readonly text: string; readonly tone: "ok" | "bad" | "off" } {
  if (!connector.enabled) return { text: "Off", tone: "off" };
  if (needsConnect(connector)) return { text: "Needs sign-in", tone: "bad" };
  if (!connector.check.ok) return { text: "Not reachable", tone: "bad" };
  return { text: "Connected", tone: "ok" };
}

/** Starts the server's own sign-in and sends the browser there; the server sends it back to the connector's page. */
async function signIn(connectorId: string): Promise<string | null> {
  const response = await api(`/bot/v1/connectors/${encodeURIComponent(connectorId)}/oauth/start`, { method: "POST" });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(body) || typeof body.url !== "string") return await errorMessage(response, "Could not start the sign-in.");
  window.location.assign(body.url);
  return null;
}

/** What is being added: a catalog entry that needs a key, or a custom MCP server. */
type Adding = { kind: "catalog"; entry: CatalogEntry } | { kind: "custom" } | null;

/**
 * Connectors, as a page: what is connected, what can be, and one screen per
 * connector with its account, its tools one by one, when a person is asked,
 * and the facts about it. Connect a service once and every Bot can use it.
 */
export function ConnectorsPage({ selectedId, onSelect, onClose }: { selectedId: string | null; onSelect: (id: string | null) => void; onClose: () => void }) {
  const [connectors, setConnectors] = useState<readonly ConnectorRow[] | null>(null);
  const [catalog, setCatalog] = useState<readonly CatalogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState<Adding>(null);

  const load = useCallback(async () => {
    try {
      const response = await api("/bot/v1/connectors");
      const body: unknown = await response.json().catch(() => null);
      if (response.ok && isRecord(body) && Array.isArray(body.connectors)) {
        setConnectors(body.connectors as ConnectorRow[]);
        if (Array.isArray(body.catalog)) setCatalog(body.catalog as CatalogEntry[]);
        setError(null);
      } else setError("Could not load connectors.");
    } catch (caught) {
      if (!(caught instanceof SignedOutError)) setError("Could not load connectors.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (selectedId !== null) onSelect(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onSelect, selectedId]);

  /** Runs one change, shows its error if any, and refreshes. */
  const act = async (id: string, request: () => Promise<Response>, fallback: string): Promise<boolean> => {
    setBusy(id);
    setError(null);
    try {
      const response = await request();
      if (!response.ok) {
        setError(await errorMessage(response, fallback));
        return false;
      }
      await load();
      return true;
    } catch (caught) {
      if (!(caught instanceof SignedOutError)) setError(fallback);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const patch = (connector: ConnectorRow, body: Record<string, unknown>) =>
    act(connector.id, () => api(`/bot/v1/connectors/${encodeURIComponent(connector.id)}`, { method: "PATCH", body: JSON.stringify(body) }), "Could not change the connector.");

  const selected = connectors?.find((connector) => connector.id === selectedId) ?? null;
  const available = catalog.filter((entry) => !connectors?.some((connector) => connector.catalog === entry.id));

  return (
    <PageFrame
      title={selected === null ? "Connectors" : selected.label}
      label="Connectors"
      onBack={() => (selected === null ? onClose() : onSelect(null))}
      backLabel={selected === null ? "Back to the console" : "Back to connectors"}
      actions={
        <>
          <span className="flex-1" />
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Close" title="Close" onClick={onClose}>
            <XIcon />
          </Button>
        </>
      }
    >
      {error !== null ? <PageError>{error}</PageError> : null}

      {connectors === null ? (
        <PageLoading />
      ) : selected !== null ? (
        <ConnectorDetail
          connector={selected}
          catalog={catalog.find((entry) => entry.id === selected.catalog) ?? null}
          busy={busy === selected.id}
          onPatch={(body) => patch(selected, body)}
          onConfirmReads={(tools) =>
            act(
              selected.id,
              () => api(`/bot/v1/connectors/${encodeURIComponent(selected.id)}/reviewed-reads`, { method: "POST", body: JSON.stringify({ tools }) }),
              "Could not confirm those reads.",
            )
          }
          onCheck={() => act(selected.id, () => api(`/bot/v1/connectors/${encodeURIComponent(selected.id)}/check`, { method: "POST" }), "Could not reach it.")}
          onKey={(body) => act(selected.id, () => api(`/bot/v1/connectors/${encodeURIComponent(selected.id)}/key`, { method: "POST", body: JSON.stringify(body) }), "The server did not accept that key.")}
          onSignIn={async () => {
            setBusy(selected.id);
            const failed = await signIn(selected.id).catch(() => "Could not start the sign-in.");
            if (failed !== null) {
              setError(failed);
              setBusy(null);
            }
          }}
          onDisconnect={() => act(selected.id, () => api(`/bot/v1/connectors/${encodeURIComponent(selected.id)}/oauth/disconnect`, { method: "POST" }), "Could not disconnect it.")}
          onRemove={async () => {
            const removed = await act(selected.id, () => api(`/bot/v1/connectors/${encodeURIComponent(selected.id)}`, { method: "DELETE" }), "Could not remove it.");
            if (removed) onSelect(null);
          }}
        />
      ) : (
        <PageBody>
          <PageNote>
            Connect a service once and every Bot can use it. A Bot reaches for a connector before clicking through a website; HQ can answer from the ones that
            only read. Keys are stored encrypted and never shown to a Bot.
          </PageNote>

          <PageSection title="Connected">
            {connectors.length === 0 ? (
              <Faint>Nothing connected yet. Add one below.</Faint>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))] gap-2.5">
                {connectors.map((connector) => {
                  const status = statusOf(connector);
                  const on = connector.check.tools.length - (connector.disabledTools?.length ?? 0);
                  return (
                    <ConnectorCard
                      key={connector.id}
                      off={!connector.enabled}
                      onClick={() => onSelect(connector.id)}
                      mark={<Mark label={connector.label} brand={connector.catalog} url={connector.catalog === null ? connector.url : null} />}
                      title={connector.label}
                      line={connector.catalog === null ? host(connector.url) : catalog.find((entry) => entry.id === connector.catalog)?.detail ?? "Built in"}
                      detail={
                        <>
                          {needsConnect(connector) ? "Sign in to finish setting it up" : connector.check.ok ? `${on} of ${connector.check.tools.length} tools on` : connector.check.error ?? "Not reachable"}
                          {" · asks "}
                          {GATE_LABEL[connector.gate].toLowerCase()}
                          {guessedReads(connector).length > 0 ? ` · ${guessedReads(connector).length} to confirm for HQ` : ""}
                        </>
                      }
                      aside={<Status tone={status.tone}>{status.text}</Status>}
                    />
                  );
                })}
              </div>
            )}
          </PageSection>

          {available.length > 0 || adding === null ? (
            <PageSection title="Available">
              <div className="grid grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))] gap-2.5">
                {available.map((entry) => (
                  <ConnectorCard
                    key={entry.id}
                    mark={<Mark label={entry.label} brand={entry.id} />}
                    title={entry.label}
                    line={entry.detail}
                    detail={entry.key.kind === "none" ? "No key needed" : entry.key.kind === "oauth" ? "Sign in with your account" : "Needs a key"}
                    aside={
                      <Button
                        size="sm"
                        disabled={busy === entry.id}
                        onClick={async () => {
                          if (entry.key.kind === "none") {
                            void act(entry.id, () => api("/bot/v1/connectors", { method: "POST", body: JSON.stringify({ catalog: entry.id }) }), `Could not connect ${entry.label}.`);
                          } else if (entry.key.kind === "oauth") {
                            setBusy(entry.id);
                            setError(null);
                            try {
                              const response = await api("/bot/v1/connectors", { method: "POST", body: JSON.stringify({ catalog: entry.id }) });
                              const body: unknown = await response.json().catch(() => null);
                              const id = response.ok && isRecord(body) && isRecord(body.connector) && typeof body.connector.id === "string" ? body.connector.id : null;
                              if (id === null) {
                                setError(await errorMessage(response, `Could not add ${entry.label}.`));
                                return;
                              }
                              const failed = await signIn(id);
                              if (failed !== null) {
                                setError(failed);
                                await load();
                              }
                            } catch (caught) {
                              if (!(caught instanceof SignedOutError)) setError(`Could not connect ${entry.label}.`);
                            } finally {
                              setBusy(null);
                            }
                          } else setAdding({ kind: "catalog", entry });
                        }}
                      >
                        {busy === entry.id ? "Connecting…" : entry.key.kind === "oauth" ? "Connect" : "Add"}
                      </Button>
                    }
                  />
                ))}
                <ConnectorCard
                  mark={
                    <span className="flex size-11 items-center justify-center rounded-full bg-secondary text-muted-foreground">
                      <PlugIcon className="size-5" />
                    </span>
                  }
                  title="Custom MCP server"
                  line="Any server that speaks MCP over https"
                  detail="Address, optional key, and what it is for"
                  aside={
                    <Button size="sm" variant="secondary" onClick={() => setAdding({ kind: "custom" })}>
                      Add
                    </Button>
                  }
                />
              </div>
            </PageSection>
          ) : null}

          {adding === null ? null : (
            <AddForm
              adding={adding}
              busy={busy === "add"}
              onCancel={() => setAdding(null)}
              onSubmit={async (body) => {
                const added = await act("add", () => api("/bot/v1/connectors", { method: "POST", body: JSON.stringify(body) }), "Could not connect it.");
                if (added) setAdding(null);
              }}
            />
          )}

          <PageSection title="Built in">
            <List>
              {BUILT_IN.map((item) => (
                <Row key={item.title}>
                  <item.icon className="size-4 flex-none text-muted-foreground" />
                  <RowMain title={item.title}>{item.detail}</RowMain>
                  <Status tone="ok">Always on</Status>
                </Row>
              ))}
            </List>
          </PageSection>
        </PageBody>
      )}
    </PageFrame>
  );
}

function ConnectorDetail({
  connector,
  catalog,
  busy,
  onPatch,
  onConfirmReads,
  onCheck,
  onKey,
  onSignIn,
  onDisconnect,
  onRemove,
}: {
  connector: ConnectorRow;
  catalog: CatalogEntry | null;
  busy: boolean;
  onPatch: (body: Record<string, unknown>) => Promise<boolean>;
  /** Marks the chosen guessed reads reviewed, in one operator action. */
  onConfirmReads: (tools: readonly string[]) => Promise<boolean>;
  onCheck: () => Promise<boolean>;
  onKey: (body: Record<string, unknown>) => Promise<boolean>;
  onSignIn: () => Promise<void>;
  onDisconnect: () => Promise<boolean>;
  onRemove: () => Promise<void>;
}) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [secret, setSecret] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  /** The guessed reads ticked for confirmation while the review is open; null when it is closed. */
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);
  const guessed = guessedReads(connector).sort((left, right) => humanTool(left).localeCompare(humanTool(right)));
  const status = statusOf(connector);
  const disabled = new Set(connector.disabledTools ?? []);
  const tools = [...connector.check.tools].sort((left, right) => humanTool(left).localeCompare(humanTool(right)));
  const on = tools.length - disabled.size;
  const source = catalog?.keyUrl ?? connector.url;

  return (
    <PageBody>
      <div className="flex flex-wrap items-center gap-4">
        <Mark label={connector.label} brand={connector.catalog} url={connector.catalog === null ? connector.url : null} size={56} />
        <div className="flex min-w-40 flex-1 flex-col gap-0.5">
          <h2 className="m-0 text-lg font-semibold">{connector.label}</h2>
          <a className={cn(linkCls, "text-[12.5px]")} href={source} target="_blank" rel="noopener noreferrer">
            {catalog === null ? host(connector.url) : "View source"} ↗
          </a>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" className="rounded-full px-3.5" disabled={busy} onClick={() => void onCheck()}>
            {busy ? "Checking…" : "Check"}
          </Button>
          {confirmRemove ? (
            <>
              <Button variant="destructive" size="sm" className="rounded-full px-3.5" disabled={busy} onClick={() => void onRemove()}>
                Really uninstall
              </Button>
              <Button variant="secondary" size="sm" className="rounded-full px-3.5" onClick={() => setConfirmRemove(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button variant="secondary" size="sm" className="rounded-full px-3.5" disabled={busy} onClick={() => setConfirmRemove(true)}>
              Uninstall
            </Button>
          )}
        </div>
      </div>
      <p className="m-0 -mt-3 text-[13.5px] text-muted-foreground">{catalog?.detail ?? connector.description}</p>

      <PageSection title="Account">
        <List>
          <Row>
            <RowMain
              title={
                connector.auth.kind === "oauth"
                  ? connector.auth.connected
                    ? `Signed in${connector.auth.connectedAt ? ` ${when(connector.auth.connectedAt)}` : ""}`
                    : "Not signed in yet"
                  : connector.auth.kind === "none"
                    ? "No key needed"
                    : `${KEY_LABEL[connector.auth.kind]}${connector.auth.header ? ` · ${connector.auth.header}` : ""}`
              }
            >
              {connector.auth.kind === "oauth" && !connector.auth.connected
                ? `Signing in happens on ${connector.auth.issuer ? host(connector.auth.issuer) : "the server"}; no key to paste.`
                : connector.check.ok
                  ? `Reached ${when(connector.check.at)}`
                  : connector.check.error ?? "Could not be reached"}
            </RowMain>
            {connector.auth.kind === "oauth" ? (
              <Button size="sm" disabled={busy} onClick={() => void onSignIn()}>
                {connector.auth.connected ? "Sign in again" : "Connect"}
              </Button>
            ) : null}
            <Status tone={status.tone}>{status.text}</Status>
          </Row>
          {connector.auth.kind === "oauth" && connector.auth.connected ? (
            <button type="button" className={rowBtnCls} disabled={busy} onClick={() => void onDisconnect()}>
              <LogOutIcon className="size-3.5 flex-none text-muted-foreground" />
              <RowMain>Disconnect this account. The connector stays; sign in again any time.</RowMain>
            </button>
          ) : null}
          {connector.auth.kind === "none" || connector.auth.kind === "oauth" ? null : replacing ? (
            <form
              className={cn(rowCls, "gap-2")}
              onSubmit={async (event) => {
                event.preventDefault();
                const ok = await onKey({ secret });
                if (ok) {
                  setReplacing(false);
                  setSecret("");
                }
              }}
            >
              <Input className="min-w-0 flex-1" type="password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder="Paste the new key" autoComplete="off" autoFocus required />
              <Button type="submit" size="sm" disabled={busy || secret.trim() === ""}>
                {busy ? "Checking…" : "Replace"}
              </Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => setReplacing(false)}>
                Cancel
              </Button>
            </form>
          ) : (
            <button type="button" className={rowBtnCls} onClick={() => setReplacing(true)}>
              <PencilIcon className="size-3.5 flex-none text-muted-foreground" />
              <RowMain>Replace the key</RowMain>
              {catalog?.keyUrl ? (
                <a className={linkCls} href={catalog.keyUrl} target="_blank" rel="noopener noreferrer" onClick={(event) => event.stopPropagation()}>
                  Get one ↗
                </a>
              ) : null}
            </button>
          )}
        </List>
      </PageSection>

      {guessed.length > 0 ? (
        <PageSection title="Reads to confirm">
          <List className="border-[color-mix(in_srgb,var(--warning)_40%,var(--input))]">
            <Row>
              <TriangleAlertIcon className="size-3.5 flex-none text-warning" />
              <RowMain
                title={
                  <>
                    {guessed.length === 1 ? "1 tool guessed as a read needs" : `${guessed.length} tools guessed as reads need`} your confirmation before HQ can use
                    {guessed.length === 1 ? " it" : " them"}
                  </>
                }
              >
                HQ never asks before it acts, so it only uses reads a person stands behind. Bots keep using them meanwhile. Confirm only what you know does
                nothing but look; anything that changes something stays a change.
              </RowMain>
              {picked === null ? (
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => setPicked(new Set(guessed))}>
                  Review
                </Button>
              ) : null}
            </Row>
            {picked !== null ? (
              <>
                {guessed.map((tool) => (
                  <label key={tool} className={cn(rowCls, "cursor-pointer")}>
                    <Checkbox
                      checked={picked.has(tool)}
                      disabled={busy}
                      onCheckedChange={(checked) => {
                        const next = new Set(picked);
                        if (checked) next.add(tool);
                        else next.delete(tool);
                        setPicked(next);
                      }}
                    />
                    <RowMain title={humanTool(tool)}>
                      <Code>{tool}</Code>
                    </RowMain>
                  </label>
                ))}
                <Row className="flex-wrap gap-2">
                  <RowMain>
                    {picked.size} of {guessed.length} selected
                  </RowMain>
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => setPicked(picked.size === guessed.length ? new Set() : new Set(guessed))}>
                    {picked.size === guessed.length ? "Select none" : "Select all"}
                  </Button>
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => setPicked(null)}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy || picked.size === 0}
                    onClick={async () => {
                      if (await onConfirmReads(guessed.filter((tool) => picked.has(tool)))) setPicked(null);
                    }}
                  >
                    {busy ? "Confirming…" : `Confirm ${picked.size} as reads`}
                  </Button>
                </Row>
              </>
            ) : null}
          </List>
        </PageSection>
      ) : null}

      <PageSection title="Tools">
        <List>
          <button type="button" className={rowBtnCls} aria-expanded={toolsOpen} onClick={() => setToolsOpen((value) => !value)}>
            <RowMain title={tools.length === 0 ? "No tools listed" : `${on} of ${tools.length} enabled`}>
              Switch off what Bots should never touch. &quot;Changes&quot; marks what the gate asks about.
            </RowMain>
            <ChevronDownIcon className={cn("size-4 flex-none text-muted-foreground transition-transform", toolsOpen && "rotate-180")} />
          </button>
          {toolsOpen
            ? tools.map((tool) => {
                const { effect, reviewed } = toolEffect(connector, tool);
                const enabled = !disabled.has(tool);
                return (
                  <Row key={tool}>
                    <span className={cn("flex min-w-0 flex-1", !enabled && "opacity-50")}>
                      <RowMain title={humanTool(tool)}>
                        <Code>{tool}</Code>
                      </RowMain>
                    </span>
                    <button
                      type="button"
                      className={cn(
                        "flex-none cursor-pointer rounded-full border px-2 py-0.5 text-[11px] hover:bg-accent disabled:cursor-default disabled:opacity-60",
                        effect === "write" ? "border-warning/40 text-warning" : "border-input text-muted-foreground",
                      )}
                      title={
                        effect === "write"
                          ? "Counted as a change: the gate may ask first. Click if it only reads."
                          : reviewed
                            ? "Counted as a read: never asks, and HQ may use it. Click if it changes something."
                            : "Guessed to read from its name: Bots use it without asking, HQ does not until you confirm. Click to confirm it only reads."
                      }
                      disabled={busy}
                      // Confirming a guessed read records it as reviewed; otherwise the click flips it.
                      onClick={() => void onPatch({ policy: { [tool]: effect === "write" || !reviewed ? "read" : "write" } })}
                    >
                      {effect === "write" ? "changes" : reviewed ? "reads" : "reads?"}
                    </button>
                    <Toggle checked={enabled} disabled={busy} label={`${humanTool(tool)} enabled`} onChange={(next) => void onPatch({ tools: { [tool]: next } })} />
                  </Row>
                );
              })
            : null}
        </List>
      </PageSection>

      <PageSection title="Access">
        <List>
          <Row>
            <RowMain title="On for every Bot">Off keeps the key and the settings, but no Bot can use it.</RowMain>
            <Toggle checked={connector.enabled} disabled={busy} label="Enabled for Bots" onChange={(next) => void onPatch({ enabled: next })} />
          </Row>
          <Row>
            <RowMain title="Ask me first">When a person is asked before a Bot uses it. HQ only ever reads.</RowMain>
            <GateSelect className="max-w-[46%]" value={connector.gate} disabled={busy} onChange={(gate) => void onPatch({ gate })} />
          </Row>
        </List>
      </PageSection>

      <PageSection title="Information">
        <List>
          {(
            [
              ["Address", host(connector.url)],
              ["Source", connector.catalog === null ? "Custom MCP server" : "Built in"],
              ["Called as", <code key="code" className="font-mono text-xs">{connector.name}__…</code>],
              ["Added", `${when(connector.createdAt)} by ${connector.createdBy}`],
              ["Last checked", when(connector.check.at)],
            ] as const
          ).map(([name, value]) => (
            <Row key={name} className="justify-between">
              <span className="text-muted-foreground">{name}</span>
              <b className="text-right font-medium [overflow-wrap:anywhere]">{value}</b>
            </Row>
          ))}
        </List>
      </PageSection>
    </PageBody>
  );
}

function AddForm({ adding, busy, onCancel, onSubmit }: { adding: NonNullable<Adding>; busy: boolean; onCancel: () => void; onSubmit: (body: Record<string, unknown>) => Promise<void> }) {
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [kind, setKind] = useState<ConnectorKeyKind>("none");
  const [header, setHeader] = useState("X-Api-Key");
  const [secret, setSecret] = useState("");
  const [description, setDescription] = useState("");
  const [gate, setGate] = useState<ConnectorGate>(adding.kind === "catalog" ? adding.entry.gate : "writes");

  const id = useId();
  const field = (name: string) => `${id}-${name}`;
  return (
    <form
      className="flex flex-col gap-2.5 rounded-[14px] border border-brand bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit(
          adding.kind === "catalog"
            ? { catalog: adding.entry.id, key: { secret }, gate }
            : { label, url, description, gate, key: { kind, ...(kind === "header" ? { header } : {}), ...(kind === "none" ? {} : { secret }) } },
        );
      }}
    >
      <h3 className="m-0 text-sm font-semibold">{adding.kind === "catalog" ? `Connect ${adding.entry.label}` : "Custom MCP server"}</h3>
      {adding.kind === "catalog" ? (
        <>
          {adding.entry.keyHelp === undefined ? null : (
            <Faint>
              {adding.entry.keyHelp}{" "}
              {adding.entry.keyUrl === undefined ? null : (
                <a className={cn(linkCls, "text-[11.5px] underline")} href={adding.entry.keyUrl} target="_blank" rel="noopener noreferrer">
                  Get one ↗
                </a>
              )}
            </Faint>
          )}
          <FormField label={`${adding.entry.label} key`} id={field("secret")}>
            <Input id={field("secret")} type="password" value={secret} onChange={(event) => setSecret(event.target.value)} required autoComplete="off" placeholder="Stored encrypted; Bots never see it" autoFocus />
          </FormField>
        </>
      ) : (
        <>
          <FormField label="Name" id={field("label")}>
            <Input id={field("label")} value={label} onChange={(event) => setLabel(event.target.value)} maxLength={60} required placeholder="Linear" autoFocus />
          </FormField>
          <FormField label="Server address" id={field("url")}>
            <Input id={field("url")} value={url} onChange={(event) => setUrl(event.target.value)} required inputMode="url" placeholder="https://mcp.example.com/mcp" />
          </FormField>
          <FormField label="Key" id={field("kind")}>
            <Select
              items={KIND_ITEMS}
              value={kind}
              onValueChange={(next) => next !== null && setKind(next as ConnectorKeyKind)}
            >
              <SelectTrigger id={field("kind")} className="w-full bg-secondary dark:bg-secondary">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KIND_ITEMS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          {kind === "none" ? <Faint>A server that runs its own sign-in is detected when it is added; you then connect from its page.</Faint> : null}
          {kind === "header" ? (
            <FormField label="Header name" id={field("header")}>
              <Input id={field("header")} value={header} onChange={(event) => setHeader(event.target.value)} required placeholder="X-Api-Key" />
            </FormField>
          ) : null}
          {kind === "none" ? null : (
            <FormField label="Key value" id={field("value")}>
              <Input id={field("value")} type="password" value={secret} onChange={(event) => setSecret(event.target.value)} required autoComplete="off" placeholder="Stored encrypted; Bots never see it" />
            </FormField>
          )}
          <FormField label="What it is for (optional)" id={field("about")}>
            <Input id={field("about")} value={description} onChange={(event) => setDescription(event.target.value)} maxLength={400} placeholder="Issues and projects for the product team" />
          </FormField>
        </>
      )}
      <FormField label="Ask me first" id={field("gate")}>
        <GateSelect className="w-full" value={gate} onChange={setGate} />
      </FormField>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "Connecting…" : "Connect"}
        </Button>
      </div>
    </form>
  );
}

const KIND_ITEMS: readonly { value: ConnectorKeyKind; label: string }[] = [
  { value: "none", label: "No key, or let the server sign me in" },
  { value: "bearer", label: "Bearer key (Authorization header)" },
  { value: "header", label: "Key in a custom header" },
];

function FormField({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return (
    <Field className="gap-1.5">
      <FieldLabel htmlFor={id} className="text-xs font-normal text-muted-foreground">
        {label}
      </FieldLabel>
      {children}
    </Field>
  );
}
