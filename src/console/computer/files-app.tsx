"use client";

import { useEffect, useRef, useState } from "react";

import { api, errorMessage, isRecord, redirectToLogin, SignedOutError } from "../api";
import { bytes, shortWhen } from "../format";
import { Icon } from "../icons";

interface Entry {
  readonly name: string;
  readonly path: string;
  readonly kind: "file" | "directory" | "link" | "other";
  readonly bytes: number;
  readonly modifiedAt: string;
}

interface Listing {
  readonly path: string;
  readonly entries: readonly Entry[];
  readonly truncated: boolean;
}

type Preview =
  | { readonly kind: "loading" }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image"; readonly url: string }
  | { readonly kind: "none"; readonly reason: string };

const ROOT = "/workspace";
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const TEXT = /\.(txt|md|csv|tsv|json|log|ya?ml|toml|xml|html|css|m?js|tsx?|py|sh|sql|ini)$/i;
const MAX_PREVIEW_BYTES = 512 * 1024;

const contentUrl = (path: string, download = false) =>
  `/bot/v1/computer/files/content?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;

const parentOf = (path: string) => (path === ROOT ? ROOT : path.slice(0, path.lastIndexOf("/")) || ROOT);

/**
 * The computer's files: everything under `/workspace` — what Bots made, what
 * they downloaded, and what the team shares.
 */
export function FilesApp() {
  const [path, setPath] = useState(ROOT);
  const [listing, setListing] = useState<Listing | null>(null);
  const [status, setStatus] = useState<string | null>("Loading…");
  const [selected, setSelected] = useState<Entry | null>(null);
  const [preview, setPreview] = useState<Preview>({ kind: "loading" });
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        const response = await api(`/bot/v1/computer/files?path=${encodeURIComponent(path)}`);
        if (cancelled) return;
        if (response.status === 202) {
          const body: unknown = await response.json();
          setStatus(isRecord(body) && typeof body.detail === "string" ? body.detail : "The computer is starting…");
          timer = window.setTimeout(() => void load(), 4_000);
          return;
        }
        if (!response.ok) {
          setStatus(await errorMessage(response, "Could not open this folder."));
          return;
        }
        setListing((await response.json()) as Listing);
        setStatus(null);
      } catch (caught) {
        if (!(caught instanceof SignedOutError) && !cancelled) setStatus("Could not reach the computer.");
      }
    };
    setSelected(null);
    void load();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [path, reload]);

  useEffect(() => {
    setConfirm("");
    if (selected === null) return;
    if (IMAGE.test(selected.name)) {
      setPreview({ kind: "image", url: contentUrl(selected.path) });
      return;
    }
    if (!TEXT.test(selected.name)) {
      setPreview({ kind: "none", reason: "No preview for this kind of file." });
      return;
    }
    if (selected.bytes > MAX_PREVIEW_BYTES) {
      setPreview({ kind: "none", reason: "Too large to preview. Download it instead." });
      return;
    }
    let cancelled = false;
    setPreview({ kind: "loading" });
    void (async () => {
      try {
        const response = await api(contentUrl(selected.path));
        const text = response.ok ? await response.text() : await errorMessage(response, "Could not open this file.");
        if (!cancelled) setPreview(response.ok ? { kind: "text", text } : { kind: "none", reason: text });
      } catch (caught) {
        if (!(caught instanceof SignedOutError) && !cancelled) setPreview({ kind: "none", reason: "Could not open this file." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const target = `${listing?.path ?? path}/${file.name}`;
      const response = await fetch(`/bot/v1/computer/files?path=${encodeURIComponent(target)}`, {
        method: "POST",
        body: file,
        credentials: "same-origin",
        headers: { "content-type": "application/octet-stream" },
      });
      if (response.status === 401) {
        redirectToLogin();
        return;
      }
      if (response.ok) setReload((count) => count + 1);
      else setStatus(await errorMessage(response, "Upload failed."));
    } catch {
      setStatus("Upload failed.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (entry: Entry) => {
    setBusy(true);
    try {
      const response = await api(`/bot/v1/computer/files?path=${encodeURIComponent(entry.path)}`, {
        method: "DELETE",
        body: JSON.stringify({ confirm }),
      });
      if (response.ok) setReload((count) => count + 1);
      else setStatus(await errorMessage(response, "Could not delete that."));
    } catch (caught) {
      if (!(caught instanceof SignedOutError)) setStatus("Could not delete that.");
    } finally {
      setBusy(false);
    }
  };

  const shown = listing?.path ?? path;
  const crumbs = shown
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment, index, all) => ({ label: segment, path: `/${all.slice(0, index + 1).join("/")}` }));

  return (
    <div className="files-app">
      <div className="files-bar">
        <button type="button" className="icon-btn" aria-label="Up one folder" disabled={shown === ROOT} onClick={() => setPath(parentOf(shown))}>
          <Icon name="left" />
        </button>
        <nav className="crumbs" aria-label="Folder">
          {crumbs.map((crumb, index) => (
            <span key={crumb.path}>
              {index === 0 ? null : <span className="sep">/</span>}
              <button type="button" disabled={crumb.path.length < ROOT.length} onClick={() => setPath(crumb.path)}>
                {crumb.label}
              </button>
            </span>
          ))}
        </nav>
        <span className="spacer" />
        <button type="button" className="btn" disabled={busy} onClick={() => picker.current?.click()}>
          <Icon name="up" size={14} /> Upload
        </button>
        <input
          ref={picker}
          type="file"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file !== undefined) void upload(file);
          }}
        />
      </div>

      <div className="files-main">
        <ul className="files-list">
          {(listing?.entries ?? []).map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                className={selected?.path === entry.path ? "selected" : undefined}
                onClick={() => (entry.kind === "directory" ? setPath(entry.path) : setSelected(entry))}
              >
                <Icon name={entry.kind === "directory" ? "folder" : "file"} size={15} />
                <span className="name">{entry.name}</span>
                <span className="meta">{entry.kind === "directory" ? "" : bytes(entry.bytes)}</span>
                <span className="meta">{shortWhen(entry.modifiedAt)}</span>
              </button>
            </li>
          ))}
          {listing !== null && listing.entries.length === 0 ? <li className="muted-row">This folder is empty.</li> : null}
          {listing?.truncated === true ? <li className="muted-row">Showing the first 1,000 items.</li> : null}
        </ul>

        {selected === null ? null : (
          <aside className="files-preview" aria-label="Preview">
            <div className="files-preview-head">
              <b>{selected.name}</b>
              <span>{`${bytes(selected.bytes)} · ${shortWhen(selected.modifiedAt)}`}</span>
            </div>
            <div className="files-preview-body">
              {preview.kind === "text" ? <pre>{preview.text}</pre> : null}
              {/* Served sandboxed from the computer; next/image cannot fetch it with the session. */}
              {preview.kind === "image" ? <img src={preview.url} alt={selected.name} /> : null}
              {preview.kind === "none" ? <p className="faint">{preview.reason}</p> : null}
              {preview.kind === "loading" ? <p className="faint">Loading…</p> : null}
            </div>
            <div className="files-actions">
              <a className="btn" href={contentUrl(selected.path, true)} download={selected.name}>
                Download
              </a>
              <input
                value={confirm}
                aria-label={`Type ${selected.name} to delete it`}
                placeholder={`Type ${selected.name} to delete`}
                onChange={(event) => setConfirm(event.target.value)}
              />
              <button
                type="button"
                className="btn danger"
                disabled={busy || confirm !== selected.name}
                onClick={() => void remove(selected)}
              >
                Delete
              </button>
            </div>
          </aside>
        )}
      </div>

      {status === null ? null : <div className="app-status">{status}</div>}
    </div>
  );
}
