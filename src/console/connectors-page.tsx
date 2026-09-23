"use client";

import { useCallback, useEffect, useState } from "react";

import type { CatalogEntry, ConnectorGate, ConnectorKeyKind } from "../../agent/lib/catalog";

import { api, errorMessage, isRecord, SignedOutError } from "./api";
import { Icon, type IconName } from "./icons";

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
  readonly disabledTools?: readonly string[];
  readonly createdAt: string;
  readonly createdBy: string;
}

/** What every Bot has without connecting anything. */
const BUILT_IN: readonly { icon: IconName; title: string; detail: string }[] = [
  { icon: "globe", title: "Browser", detail: "Signs in and works inside the web apps you use" },
  { icon: "terminal", title: "Computer", detail: "A shell and files on its own machine" },
  { icon: "mail", title: "Email", detail: "Drafts freely, sends only after you approve" },
  { icon: "brain", title: "Memory", detail: "Remembers how you and your team like things done" },
  { icon: "clock", title: "Routines", detail: "Starts work on a schedule, without a prompt" },
];

const GATE_LABEL: Readonly<Record<ConnectorGate, string>> = {
  none: "Never",
  writes: "Before a Bot changes anything",
  all: "Before each tool's first use in a job",
};

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

/** A brand-coloured monogram, since connectors bring no icon of their own. */
function Mark({ label, size = 44 }: { label: string; size?: number }) {
  return (
    <span className="cpage-mark" style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden="true">
      {label.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

function Switch({ checked, disabled, onChange, label }: { checked: boolean; disabled?: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <label className={`switch${checked ? " on" : ""}${disabled ? " disabled" : ""}`} title={label}>
      <input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <i />
    </label>
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
    <div className="usage-page cpage" role="region" aria-label="Connectors">
      <header className="usage-head cpage-head">
        <button type="button" className="icon-btn" aria-label={selected === null ? "Back to the console" : "Back to connectors"} title="Back" onClick={() => (selected === null ? onClose() : onSelect(null))}>
          <Icon name="left" size={18} />
        </button>
        <h1>{selected === null ? "Connectors" : selected.label}</h1>
        <span className="spacer" />
        <button type="button" className="icon-btn" aria-label="Close" title="Close" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </header>

      {error !== null ? <p className="error-text usage-error">{error}</p> : null}

      {connectors === null ? (
        <p className="faint usage-loading">Loading…</p>
      ) : selected !== null ? (
        <ConnectorDetail
          connector={selected}
          catalog={catalog.find((entry) => entry.id === selected.catalog) ?? null}
          busy={busy === selected.id}
          onPatch={(body) => patch(selected, body)}
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
        <div className="usage-body cpage-body">
          <p className="usage-note memory-intro">
            Connect a service once and every Bot can use it. A Bot reaches for a connector before clicking through a website; HQ can answer from the ones that
            only read. Keys are stored encrypted and never shown to a Bot.
          </p>

          <section className="usage-section">
            <h2>Connected</h2>
            {connectors.length === 0 ? (
              <p className="faint">Nothing connected yet. Add one below.</p>
            ) : (
              <div className="cpage-grid">
                {connectors.map((connector) => {
                  const status = statusOf(connector);
                  const on = connector.check.tools.length - (connector.disabledTools?.length ?? 0);
                  return (
                    <button key={connector.id} type="button" className={`cpage-card${connector.enabled ? "" : " off"}`} onClick={() => onSelect(connector.id)}>
                      <Mark label={connector.label} />
                      <span className="cpage-card-main">
                        <b>{connector.label}</b>
                        <span>{connector.catalog === null ? host(connector.url) : catalog.find((entry) => entry.id === connector.catalog)?.detail ?? "Built in"}</span>
                        <small>
                          {needsConnect(connector) ? "Sign in to finish setting it up" : connector.check.ok ? `${on} of ${connector.check.tools.length} tools on` : connector.check.error ?? "Not reachable"}
                          {" · asks "}
                          {GATE_LABEL[connector.gate].toLowerCase()}
                        </small>
                      </span>
                      <span className={`cpage-status ${status.tone}`}>{status.text}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {available.length > 0 || adding === null ? (
            <section className="usage-section">
              <h2>Available</h2>
              <div className="cpage-grid">
                {available.map((entry) => (
                  <div key={entry.id} className="cpage-card static">
                    <Mark label={entry.label} />
                    <span className="cpage-card-main">
                      <b>{entry.label}</b>
                      <span>{entry.detail}</span>
                      <small>{entry.key.kind === "none" ? "No key needed" : entry.key.kind === "oauth" ? "Sign in with your account" : "Needs a key"}</small>
                    </span>
                    <button
                      type="button"
                      className="btn primary"
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
                    </button>
                  </div>
                ))}
                <div className="cpage-card static">
                  <span className="cpage-mark plain">
                    <Icon name="plug" size={20} />
                  </span>
                  <span className="cpage-card-main">
                    <b>Custom MCP server</b>
                    <span>Any server that speaks MCP over https</span>
                    <small>Address, optional key, and what it is for</small>
                  </span>
                  <button type="button" className="btn" onClick={() => setAdding({ kind: "custom" })}>
                    Add
                  </button>
                </div>
              </div>
            </section>
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

          <section className="usage-section">
            <h2>Built in</h2>
            <div className="cpage-list">
              {BUILT_IN.map((item) => (
                <div key={item.title} className="cpage-row">
                  <Icon name={item.icon} size={16} />
                  <span className="cpage-row-main">
                    <b>{item.title}</b>
                    <span>{item.detail}</span>
                  </span>
                  <span className="cpage-status ok">Always on</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function ConnectorDetail({
  connector,
  catalog,
  busy,
  onPatch,
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
  const status = statusOf(connector);
  const disabled = new Set(connector.disabledTools ?? []);
  const tools = [...connector.check.tools].sort((left, right) => humanTool(left).localeCompare(humanTool(right)));
  const on = tools.length - disabled.size;
  const source = catalog?.keyUrl ?? connector.url;

  return (
    <div className="usage-body cpage-body">
      <div className="cpage-hero">
        <Mark label={connector.label} size={56} />
        <div className="cpage-hero-main">
          <h2>{connector.label}</h2>
          <a href={source} target="_blank" rel="noopener noreferrer">
            {catalog === null ? host(connector.url) : "View source"} ↗
          </a>
        </div>
        <div className="cpage-hero-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => void onCheck()}>
            {busy ? "Checking…" : "Check"}
          </button>
          {confirmRemove ? (
            <>
              <button type="button" className="btn danger-fill" disabled={busy} onClick={() => void onRemove()}>
                Really uninstall
              </button>
              <button type="button" className="btn" onClick={() => setConfirmRemove(false)}>
                Keep
              </button>
            </>
          ) : (
            <button type="button" className="btn" disabled={busy} onClick={() => setConfirmRemove(true)}>
              Uninstall
            </button>
          )}
        </div>
      </div>
      <p className="cpage-description">{catalog?.detail ?? connector.description}</p>

      <section className="usage-section">
        <h2>Account</h2>
        <div className="cpage-list">
          <div className="cpage-row">
            <span className="cpage-row-main">
              <b>
                {connector.auth.kind === "oauth"
                  ? connector.auth.connected
                    ? `Signed in${connector.auth.connectedAt ? ` ${when(connector.auth.connectedAt)}` : ""}`
                    : "Not signed in yet"
                  : connector.auth.kind === "none"
                    ? "No key needed"
                    : `${KEY_LABEL[connector.auth.kind]}${connector.auth.header ? ` · ${connector.auth.header}` : ""}`}
              </b>
              <span>
                {connector.auth.kind === "oauth" && !connector.auth.connected
                  ? `Signing in happens on ${connector.auth.issuer ? host(connector.auth.issuer) : "the server"}; no key to paste.`
                  : connector.check.ok
                    ? `Reached ${when(connector.check.at)}`
                    : connector.check.error ?? "Could not be reached"}
              </span>
            </span>
            {connector.auth.kind === "oauth" ? (
              <button type="button" className="btn primary" disabled={busy} onClick={() => void onSignIn()}>
                {connector.auth.connected ? "Sign in again" : "Connect"}
              </button>
            ) : null}
            <span className={`cpage-status ${status.tone}`}>{status.text}</span>
          </div>
          {connector.auth.kind === "oauth" && connector.auth.connected ? (
            <button type="button" className="cpage-row cpage-row-btn" disabled={busy} onClick={() => void onDisconnect()}>
              <Icon name="signout" size={14} />
              <span className="cpage-row-main">
                <span>Disconnect this account. The connector stays; sign in again any time.</span>
              </span>
            </button>
          ) : null}
          {connector.auth.kind === "none" || connector.auth.kind === "oauth" ? null : replacing ? (
            <form
              className="cpage-row cpage-form"
              onSubmit={async (event) => {
                event.preventDefault();
                const ok = await onKey({ secret });
                if (ok) {
                  setReplacing(false);
                  setSecret("");
                }
              }}
            >
              <input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder="Paste the new key" autoComplete="off" autoFocus required />
              <button type="submit" className="btn primary" disabled={busy || secret.trim() === ""}>
                {busy ? "Checking…" : "Replace"}
              </button>
              <button type="button" className="btn" onClick={() => setReplacing(false)}>
                Cancel
              </button>
            </form>
          ) : (
            <button type="button" className="cpage-row cpage-row-btn" onClick={() => setReplacing(true)}>
              <Icon name="edit" size={14} />
              <span className="cpage-row-main">
                <span>Replace the key</span>
              </span>
              {catalog?.keyUrl ? (
                <a href={catalog.keyUrl} target="_blank" rel="noopener noreferrer" onClick={(event) => event.stopPropagation()}>
                  Get one ↗
                </a>
              ) : null}
            </button>
          )}
        </div>
      </section>

      <section className="usage-section">
        <h2>Tools</h2>
        <div className="cpage-list">
          <button type="button" className="cpage-row cpage-row-btn" aria-expanded={toolsOpen} onClick={() => setToolsOpen((value) => !value)}>
            <span className="cpage-row-main">
              <b>
                {tools.length === 0 ? "No tools listed" : `${on} of ${tools.length} enabled`}
              </b>
              <span>Switch off what Bots should never touch. "Changes" marks what the gate asks about.</span>
            </span>
            <Icon name="chev" size={16} className={toolsOpen ? "cpage-chev open" : "cpage-chev"} />
          </button>
          {toolsOpen
            ? tools.map((tool) => {
                const effect = connector.policy?.[tool] ?? "write";
                const enabled = !disabled.has(tool);
                return (
                  <div key={tool} className={`cpage-row cpage-tool${enabled ? "" : " off"}`}>
                    <span className="cpage-row-main">
                      <b>{humanTool(tool)}</b>
                      <span>
                        <code>{tool}</code>
                      </span>
                    </span>
                    <button
                      type="button"
                      className={`cpage-tag ${effect}`}
                      title={effect === "write" ? "Counted as a change: the gate may ask first. Click if it only reads." : "Counted as a read: never asks. Click if it changes something."}
                      disabled={busy}
                      onClick={() => void onPatch({ policy: { [tool]: effect === "write" ? "read" : "write" } })}
                    >
                      {effect === "write" ? "changes" : "reads"}
                    </button>
                    <Switch checked={enabled} disabled={busy} label={`${humanTool(tool)} enabled`} onChange={(next) => void onPatch({ tools: { [tool]: next } })} />
                  </div>
                );
              })
            : null}
        </div>
      </section>

      <section className="usage-section">
        <h2>Access</h2>
        <div className="cpage-list">
          <div className="cpage-row">
            <span className="cpage-row-main">
              <b>On for every Bot</b>
              <span>Off keeps the key and the settings, but no Bot can use it.</span>
            </span>
            <Switch checked={connector.enabled} disabled={busy} label="Enabled for Bots" onChange={(next) => void onPatch({ enabled: next })} />
          </div>
          <div className="cpage-row">
            <span className="cpage-row-main">
              <b>Ask me first</b>
              <span>When a person is asked before a Bot uses it. HQ only ever reads.</span>
            </span>
            <select className="cpage-select" value={connector.gate} disabled={busy} onChange={(event) => void onPatch({ gate: event.target.value })}>
              {(Object.keys(GATE_LABEL) as ConnectorGate[]).map((value) => (
                <option key={value} value={value}>
                  {GATE_LABEL[value]}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      <section className="usage-section">
        <h2>Information</h2>
        <div className="cpage-list cpage-facts">
          <div className="cpage-row">
            <span>Address</span>
            <b>{host(connector.url)}</b>
          </div>
          <div className="cpage-row">
            <span>Source</span>
            <b>{connector.catalog === null ? "Custom MCP server" : "Built in"}</b>
          </div>
          <div className="cpage-row">
            <span>Called as</span>
            <b>
              <code>{connector.name}__…</code>
            </b>
          </div>
          <div className="cpage-row">
            <span>Added</span>
            <b>
              {when(connector.createdAt)} by {connector.createdBy}
            </b>
          </div>
          <div className="cpage-row">
            <span>Last checked</span>
            <b>{when(connector.check.at)}</b>
          </div>
        </div>
      </section>
    </div>
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

  return (
    <form
      className="cpage-add"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit(
          adding.kind === "catalog"
            ? { catalog: adding.entry.id, key: { secret }, gate }
            : { label, url, description, gate, key: { kind, ...(kind === "header" ? { header } : {}), ...(kind === "none" ? {} : { secret }) } },
        );
      }}
    >
      <h3>{adding.kind === "catalog" ? `Connect ${adding.entry.label}` : "Custom MCP server"}</h3>
      {adding.kind === "catalog" ? (
        <>
          {adding.entry.keyHelp === undefined ? null : (
            <p className="faint">
              {adding.entry.keyHelp}{" "}
              {adding.entry.keyUrl === undefined ? null : (
                <a href={adding.entry.keyUrl} target="_blank" rel="noopener noreferrer">
                  Get one ↗
                </a>
              )}
            </p>
          )}
          <label>
            {adding.entry.label} key
            <input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} required autoComplete="off" placeholder="Stored encrypted; Bots never see it" autoFocus />
          </label>
        </>
      ) : (
        <>
          <label>
            Name
            <input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={60} required placeholder="Linear" autoFocus />
          </label>
          <label>
            Server address
            <input value={url} onChange={(event) => setUrl(event.target.value)} required inputMode="url" placeholder="https://mcp.example.com/mcp" />
          </label>
          <label>
            Key
            <select value={kind} onChange={(event) => setKind(event.target.value as ConnectorKeyKind)}>
              <option value="none">No key, or let the server sign me in</option>
              <option value="bearer">Bearer key (Authorization header)</option>
              <option value="header">Key in a custom header</option>
            </select>
          </label>
          {kind === "none" ? <p className="faint">A server that runs its own sign-in is detected when it is added; you then connect from its page.</p> : null}
          {kind === "header" ? (
            <label>
              Header name
              <input value={header} onChange={(event) => setHeader(event.target.value)} required placeholder="X-Api-Key" />
            </label>
          ) : null}
          {kind === "none" ? null : (
            <label>
              Key value
              <input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} required autoComplete="off" placeholder="Stored encrypted; Bots never see it" />
            </label>
          )}
          <label>
            What it is for (optional)
            <input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={400} placeholder="Issues and projects for the product team" />
          </label>
        </>
      )}
      <label>
        Ask me first
        <select value={gate} onChange={(event) => setGate(event.target.value as ConnectorGate)}>
          {(Object.keys(GATE_LABEL) as ConnectorGate[]).map((value) => (
            <option key={value} value={value}>
              {GATE_LABEL[value]}
            </option>
          ))}
        </select>
      </label>
      <div className="actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? "Connecting…" : "Connect"}
        </button>
      </div>
    </form>
  );
}
