"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { api, errorMessage, isRecord, SignedOutError } from "./api";
import { Icon, type IconName } from "./icons";

type KeyKind = "none" | "bearer" | "header";

interface PluginRow {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly url: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly askFirst: boolean;
  readonly auth: { readonly kind: KeyKind; readonly header?: string };
  readonly check: { readonly ok: boolean; readonly at: string; readonly tools: readonly string[]; readonly error: string | null };
}

/** What every Bot has without connecting anything. */
const BUILT_IN: readonly { icon: IconName; title: string; detail: string }[] = [
  { icon: "globe", title: "Browser", detail: "Signs in and works inside the web apps you use" },
  { icon: "terminal", title: "Computer", detail: "A shell and files on its own machine" },
  { icon: "mail", title: "Email", detail: "Drafts freely, sends only after you approve" },
  { icon: "brain", title: "Memory", detail: "Remembers how you and your team like things done" },
  { icon: "clock", title: "Routines", detail: "Starts work on a schedule, without a prompt" },
];

/** MCP servers that connect without a key, for trying plugins in one click. */
const SUGGESTED: readonly { label: string; url: string; description: string }[] = [
  {
    label: "DeepWiki",
    url: "https://mcp.deepwiki.com/mcp",
    description: "Answers questions about public GitHub repositories from their generated documentation.",
  },
];

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * Plugins, as in Grok Bot: MCP servers the team connects once and every Bot can
 * use. A Bot reaches for a plugin before clicking through a website.
 */
export function PluginsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [plugins, setPlugins] = useState<readonly PluginRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [kind, setKind] = useState<KeyKind>("none");
  const [header, setHeader] = useState("X-Api-Key");
  const [secret, setSecret] = useState("");
  const [description, setDescription] = useState("");
  const [askFirst, setAskFirst] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await api("/bot/v1/plugins");
      const body: unknown = await response.json().catch(() => null);
      if (response.ok && isRecord(body) && Array.isArray(body.plugins)) setPlugins(body.plugins as PluginRow[]);
      else setError("Could not load plugins.");
    } catch (caught) {
      if (!(caught instanceof SignedOutError)) setError("Could not load plugins.");
    }
  }, []);

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) {
      setError(null);
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

  const patch = (plugin: PluginRow, body: Record<string, unknown>) =>
    act(plugin.id, () => api(`/bot/v1/plugins/${encodeURIComponent(plugin.id)}`, { method: "PATCH", body: JSON.stringify(body) }), "Could not change the plugin.");

  return (
    <dialog ref={dialog} onClose={onClose} className="plugins-dialog">
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const added = await act(
            "add",
            () =>
              api("/bot/v1/plugins", {
                method: "POST",
                body: JSON.stringify({
                  label,
                  url,
                  description,
                  askFirst,
                  key: { kind, ...(kind === "header" ? { header } : {}), ...(kind === "none" ? {} : { secret }) },
                }),
              }),
            "Could not connect the plugin.",
          );
          if (added) {
            setLabel("");
            setUrl("");
            setSecret("");
            setDescription("");
            setKind("none");
            setAskFirst(false);
          }
        }}
      >
        <h2>Plugins</h2>
        <p>Connect a service once and every Bot can use it. Bots use a plugin before clicking through a website.</p>

        <section className="plugins-section">
          <h3>Connected</h3>
          {plugins === null ? (
            <p className="faint">Loading…</p>
          ) : plugins.length === 0 ? (
            <p className="faint">Nothing connected yet. Add an MCP server below.</p>
          ) : (
            <ul className="plugin-list">
              {plugins.map((plugin) => (
                <li key={plugin.id} className={plugin.enabled ? undefined : "off"}>
                  <Icon name="plug" />
                  <div className="plugin-main">
                    <b>{plugin.label}</b>
                    <span>
                      {host(plugin.url)}
                      {plugin.check.ok
                        ? ` · ${plugin.check.tools.length} ${plugin.check.tools.length === 1 ? "tool" : "tools"}`
                        : ` · ${plugin.check.error ?? "not reachable"}`}
                      {plugin.auth.kind === "none" ? "" : " · key saved"}
                    </span>
                  </div>
                  <label className="plugin-toggle" title="Every Bot can use it">
                    <input
                      type="checkbox"
                      checked={plugin.enabled}
                      disabled={busy === plugin.id}
                      onChange={(event) => void patch(plugin, { enabled: event.target.checked })}
                    />
                    On
                  </label>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy === plugin.id}
                    onClick={() =>
                      void act(plugin.id, () => api(`/bot/v1/plugins/${encodeURIComponent(plugin.id)}/check`, { method: "POST" }), "Could not reach the plugin.")
                    }
                  >
                    Check
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy === plugin.id}
                    onClick={() =>
                      void act(plugin.id, () => api(`/bot/v1/plugins/${encodeURIComponent(plugin.id)}`, { method: "DELETE" }), "Could not remove the plugin.")
                    }
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="plugins-section">
          <h3>Add an MCP server</h3>
          <div className="plugin-suggestions">
            {SUGGESTED.filter((item) => !plugins?.some((plugin) => plugin.url === item.url)).map((item) => (
              <button
                key={item.url}
                type="button"
                className="btn"
                onClick={() => {
                  setLabel(item.label);
                  setUrl(item.url);
                  setDescription(item.description);
                  setKind("none");
                }}
              >
                {`+ ${item.label}`}
              </button>
            ))}
          </div>
          <label>
            Name
            <input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={60} required placeholder="Linear" />
          </label>
          <label>
            Server address
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              required
              inputMode="url"
              placeholder="https://mcp.example.com/mcp"
            />
          </label>
          <label>
            Key
            <select value={kind} onChange={(event) => setKind(event.target.value as KeyKind)}>
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
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={400}
              placeholder="Issues and projects for the product team"
            />
          </label>
          <label className="plugin-check">
            <input type="checkbox" checked={askFirst} onChange={(event) => setAskFirst(event.target.checked)} />
            Ask me before a Bot first uses it in a job
          </label>
        </section>

        {error === null ? null : <p className="error-text">{error}</p>}
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
          <button type="submit" className="btn primary" disabled={busy === "add"}>
            {busy === "add" ? "Connecting…" : "Connect"}
          </button>
        </div>

        <section className="plugins-section">
          <h3>Built in</h3>
          <ul className="plugin-list">
            {BUILT_IN.map((item) => (
              <li key={item.title}>
                <Icon name={item.icon} />
                <div className="plugin-main">
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
