"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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
  readonly auth: { readonly kind: ConnectorKeyKind; readonly header?: string };
  readonly check: { readonly ok: boolean; readonly at: string; readonly tools: readonly string[]; readonly error: string | null };
  /** What each tool does, as this workspace has it recorded. Missing means "treat as changing". */
  readonly policy?: Readonly<Record<string, "read" | "write">>;
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
  none: "never asks",
  writes: "asks before changes",
  all: "asks before first use",
};

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** What is being added: a catalog entry that needs a key, or a custom MCP server. */
type Adding = { kind: "catalog"; entry: CatalogEntry } | { kind: "custom" } | null;

/**
 * Connectors: services the team connects once and every Bot can use. Built-in
 * ones are added by name; anything else is an MCP server by address. A Bot
 * reaches for a connector before clicking through a website.
 */
export function ConnectorsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [connectors, setConnectors] = useState<readonly ConnectorRow[] | null>(null);
  const [catalog, setCatalog] = useState<readonly CatalogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState<Adding>(null);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [kind, setKind] = useState<ConnectorKeyKind>("none");
  const [header, setHeader] = useState("X-Api-Key");
  const [secret, setSecret] = useState("");
  const [description, setDescription] = useState("");
  const [gate, setGate] = useState<ConnectorGate>("writes");

  const load = useCallback(async () => {
    try {
      const response = await api("/bot/v1/connectors");
      const body: unknown = await response.json().catch(() => null);
      if (response.ok && isRecord(body) && Array.isArray(body.connectors)) {
        setConnectors(body.connectors as ConnectorRow[]);
        if (Array.isArray(body.catalog)) setCatalog(body.catalog as CatalogEntry[]);
      } else setError("Could not load connectors.");
    } catch (caught) {
      if (!(caught instanceof SignedOutError)) setError("Could not load connectors.");
    }
  }, []);

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) {
      setError(null);
      setAdding(null);
      element.showModal();
      void load();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open, load]);

  /** Runs one change, shows its error if any, and refreshes the list. */
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

  const reset = () => {
    setAdding(null);
    setLabel("");
    setUrl("");
    setSecret("");
    setDescription("");
    setKind("none");
    setGate("writes");
  };

  /** Adds a catalog entry: at once when it needs no key, else after asking for the key. */
  const addFromCatalog = (entry: CatalogEntry) => {
    if (entry.key.kind === "none") {
      void act(entry.id, () => api("/bot/v1/connectors", { method: "POST", body: JSON.stringify({ catalog: entry.id }) }), `Could not connect ${entry.label}.`);
      return;
    }
    setAdding({ kind: "catalog", entry });
    setSecret("");
    setGate(entry.gate);
  };

  const submit = async () => {
    const body =
      adding?.kind === "catalog"
        ? { catalog: adding.entry.id, key: { secret }, gate }
        : { label, url, description, gate, key: { kind, ...(kind === "header" ? { header } : {}), ...(kind === "none" ? {} : { secret }) } };
    const added = await act("add", () => api("/bot/v1/connectors", { method: "POST", body: JSON.stringify(body) }), "Could not connect it.");
    if (added) reset();
  };

  const available = catalog.filter((entry) => !connectors?.some((connector) => connector.catalog === entry.id));

  return (
    <dialog ref={dialog} onClose={onClose} className="connectors-dialog">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2>Connectors</h2>
        <p>Connect a service once and every Bot can use it. Bots use a connector before clicking through a website.</p>

        <section className="connectors-section">
          <h3>Connected</h3>
          {connectors === null ? (
            <p className="faint">Loading…</p>
          ) : connectors.length === 0 ? (
            <p className="faint">Nothing connected yet.</p>
          ) : (
            <ul className="connector-list">
              {connectors.map((connector) => (
                <li key={connector.id} className={connector.enabled ? undefined : "off"}>
                  <Icon name="plug" />
                  <div className="connector-main">
                    <b>{connector.label}</b>
                    <span>
                      {connector.catalog === null ? host(connector.url) : "built in"}
                      {connector.check.ok
                        ? ` · ${connector.check.tools.length} ${connector.check.tools.length === 1 ? "tool" : "tools"}`
                        : ` · ${connector.check.error ?? "not reachable"}`}
                      {connector.auth.kind === "none" ? "" : " · key saved"}
                    </span>
                  </div>
                  <select
                    className="connector-gate"
                    value={connector.gate}
                    disabled={busy === connector.id}
                    title="When a person is asked before a Bot uses it"
                    onChange={(event) => void patch(connector, { gate: event.target.value })}
                  >
                    {(Object.keys(GATE_LABEL) as ConnectorGate[]).map((value) => (
                      <option key={value} value={value}>
                        {GATE_LABEL[value]}
                      </option>
                    ))}
                  </select>
                  <label className="connector-toggle" title="Every Bot can use it">
                    <input
                      type="checkbox"
                      checked={connector.enabled}
                      disabled={busy === connector.id}
                      onChange={(event) => void patch(connector, { enabled: event.target.checked })}
                    />
                    On
                  </label>
                  {connector.check.ok && connector.check.tools.length > 0 ? (
                    <details className="connector-tools">
                      <summary>{connector.check.tools.length} tools</summary>
                      <ul>
                        {connector.check.tools.map((tool) => (
                          <li key={tool}>
                            <code>{tool}</code>
                            <select
                              value={connector.policy?.[tool] ?? "write"}
                              disabled={busy === connector.id}
                              title="Whether this tool changes something, which is what the gate above asks about"
                              onChange={(event) => void patch(connector, { policy: { [tool]: event.target.value } })}
                            >
                              <option value="read">reads</option>
                              <option value="write">changes</option>
                            </select>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  <button
                    type="button"
                    className="btn"
                    disabled={busy === connector.id}
                    onClick={() =>
                      void act(connector.id, () => api(`/bot/v1/connectors/${encodeURIComponent(connector.id)}/check`, { method: "POST" }), "Could not reach it.")
                    }
                  >
                    Check
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy === connector.id}
                    onClick={() =>
                      void act(connector.id, () => api(`/bot/v1/connectors/${encodeURIComponent(connector.id)}`, { method: "DELETE" }), "Could not remove it.")
                    }
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {available.length > 0 ? (
          <section className="connectors-section">
            <h3>Add</h3>
            <ul className="connector-list">
              {available.map((entry) => (
                <li key={entry.id}>
                  <Icon name="plug" />
                  <div className="connector-main">
                    <b>{entry.label}</b>
                    <span>{entry.detail}</span>
                  </div>
                  <button type="button" className="btn primary" disabled={busy === entry.id} onClick={() => addFromCatalog(entry)}>
                    {busy === entry.id ? "Connecting…" : "Add"}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {adding?.kind === "catalog" ? (
          <section className="connectors-section">
            <h3>Connect {adding.entry.label}</h3>
            {adding.entry.keyHelp === undefined ? null : (
              <p className="faint">
                {adding.entry.keyHelp}{" "}
                {adding.entry.keyUrl === undefined ? null : (
                  <a href={adding.entry.keyUrl} target="_blank" rel="noopener noreferrer">
                    Get one
                  </a>
                )}
              </p>
            )}
            <label>
              {adding.entry.label} key
              <input
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                required
                autoComplete="off"
                placeholder="Stored encrypted; Bots never see it"
              />
            </label>
            <GateField gate={gate} onGate={setGate} />
          </section>
        ) : adding?.kind === "custom" ? (
          <section className="connectors-section">
            <h3>Custom MCP server</h3>
            <label>
              Name
              <input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={60} required placeholder="Linear" />
            </label>
            <label>
              Server address
              <input value={url} onChange={(event) => setUrl(event.target.value)} required inputMode="url" placeholder="https://mcp.example.com/mcp" />
            </label>
            <label>
              Key
              <select value={kind} onChange={(event) => setKind(event.target.value as ConnectorKeyKind)}>
                <option value="none">No key</option>
                <option value="bearer">Bearer key (Authorization header)</option>
                <option value="header">Key in a custom header</option>
              </select>
            </label>
            {kind === "header" ? (
              <label>
                Header name
                <input value={header} onChange={(event) => setHeader(event.target.value)} required placeholder="X-Api-Key" />
              </label>
            ) : null}
            {kind === "none" ? null : (
              <label>
                Key value
                <input
                  type="password"
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                  required
                  autoComplete="off"
                  placeholder="Stored encrypted; Bots never see it"
                />
              </label>
            )}
            <label>
              What it is for (optional)
              <input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={400} placeholder="Issues and projects for the product team" />
            </label>
            <GateField gate={gate} onGate={setGate} />
          </section>
        ) : (
          <button type="button" className="btn connector-custom" onClick={() => setAdding({ kind: "custom" })}>
            + Custom MCP server
          </button>
        )}

        {error === null ? null : <p className="error-text">{error}</p>}
        <div className="actions">
          {adding === null ? (
            <button type="button" className="btn" onClick={onClose}>
              Done
            </button>
          ) : (
            <>
              <button type="button" className="btn" onClick={reset}>
                Cancel
              </button>
              <button type="submit" className="btn primary" disabled={busy === "add"}>
                {busy === "add" ? "Connecting…" : "Connect"}
              </button>
            </>
          )}
        </div>

        <section className="connectors-section">
          <h3>Built in</h3>
          <ul className="connector-list">
            {BUILT_IN.map((item) => (
              <li key={item.title}>
                <Icon name={item.icon} />
                <div className="connector-main">
                  <b>{item.title}</b>
                  <span>{item.detail}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </form>
    </dialog>
  );
}

function GateField({ gate, onGate }: { gate: ConnectorGate; onGate: (gate: ConnectorGate) => void }) {
  return (
    <label>
      Ask me
      <select value={gate} onChange={(event) => onGate(event.target.value as ConnectorGate)}>
        <option value="writes">before a Bot changes anything through it</option>
        <option value="all">before a Bot first uses each tool in a job</option>
        <option value="none">never</option>
      </select>
    </label>
  );
}
