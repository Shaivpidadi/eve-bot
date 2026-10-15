"use client";

import { ChevronLeftIcon, FileIcon, FolderIcon, UploadIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";


import { api, errorMessage, isRecord, redirectToLogin, SignedOutError } from "../api";
import { bytes, shortWhen } from "../format";

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
    <div className="absolute inset-0 flex flex-col bg-[#161618] text-[12.5px] text-[#e6e6e8]">
      <div className="flex h-10 flex-none items-center gap-1.5 border-b border-[#222] px-2.5">
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-[#aaa] hover:bg-[#222] hover:text-white"
          aria-label="Up one folder"
          disabled={shown === ROOT}
          onClick={() => setPath(parentOf(shown))}
        >
          <ChevronLeftIcon />
        </Button>
        <nav className="flex min-w-0 items-center overflow-hidden whitespace-nowrap" aria-label="Folder">
          {crumbs.map((crumb, index) => (
            <span key={crumb.path}>
              {index === 0 ? null : <span className="text-[#555]">/</span>}
              <button
                type="button"
                className="rounded-md px-1.5 py-[3px] text-[#b5b5bb] enabled:hover:bg-[#222] enabled:hover:text-white"
                disabled={crumb.path.length < ROOT.length}
                onClick={() => setPath(crumb.path)}
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </nav>
        <span className="flex-1" />
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => picker.current?.click()}>
          <UploadIcon data-icon="inline-start" /> Upload
        </Button>
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

      <div className="flex min-h-0 flex-1 flex-col">
        <ul className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-1.5">
          {(listing?.entries ?? []).map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                className={cn(
                  "grid w-full grid-cols-[18px_minmax(0,1fr)_64px] items-center gap-2.5 rounded-[7px] px-2 py-1.5 text-left hover:bg-[#1c1c1f]",
                  selected?.path === entry.path && "bg-[#26262a] hover:bg-[#26262a]",
                )}
                onClick={() => (entry.kind === "directory" ? setPath(entry.path) : setSelected(entry))}
              >
                {entry.kind === "directory" ? <FolderIcon className="size-[15px]" /> : <FileIcon className="size-[15px]" />}
                <span className="truncate">{entry.name}</span>
                <span className="text-right text-[11.5px] text-[#8a8a92]">{entry.kind === "directory" ? "" : bytes(entry.bytes)}</span>
              </button>
            </li>
          ))}
          {listing !== null && listing.entries.length === 0 ? <li className="p-2.5 text-[#77777e]">This folder is empty.</li> : null}
          {listing?.truncated === true ? <li className="p-2.5 text-[#77777e]">Showing the first 1,000 items.</li> : null}
        </ul>

        {selected === null ? null : (
          <aside className="flex max-h-[55%] min-h-0 flex-none flex-col border-t border-[#222]" aria-label="Preview">
            <div className="border-b border-[#222] px-3 py-2.5">
              <b className="block font-medium [overflow-wrap:anywhere]">{selected.name}</b>
              <span className="text-[11.5px] text-[#8a8a92]">{`${bytes(selected.bytes)} · ${shortWhen(selected.modifiedAt)}`}</span>
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-3 py-2.5">
              {preview.kind === "text" ? (
                <pre className="m-0 font-mono text-[11.5px] leading-normal [overflow-wrap:anywhere] whitespace-pre-wrap text-[#d6d6db]">{preview.text}</pre>
              ) : null}
              {/* Served sandboxed from the computer; next/image cannot fetch it with the session. */}
              {preview.kind === "image" ? <img className="max-w-full rounded-md" src={preview.url} alt={selected.name} /> : null}
              {preview.kind === "none" ? <p className="m-0 text-[11.5px] text-[#8a8a92]">{preview.reason}</p> : null}
              {preview.kind === "loading" ? <p className="m-0 text-[11.5px] text-[#8a8a92]">Loading…</p> : null}
            </div>
            <div className="flex flex-wrap items-center gap-1.5 border-t border-[#222] px-3 py-2.5">
              <a className={buttonVariants({ variant: "secondary", size: "sm" })} href={contentUrl(selected.path, true)} download={selected.name}>
                Download
              </a>
              <Input
                className="h-7 min-w-[120px] flex-1 rounded-[7px] border-[#2a2a2e] bg-[#1c1c1f] px-2 text-xs text-[#eee] md:text-xs"
                value={confirm}
                aria-label={`Type ${selected.name} to delete it`}
                placeholder={`Type ${selected.name} to delete`}
                onChange={(event) => setConfirm(event.target.value)}
              />
              <Button
                variant="destructive"
                size="sm"
                disabled={busy || confirm !== selected.name}
                onClick={() => void remove(selected)}
              >
                Delete
              </Button>
            </div>
          </aside>
        )}
      </div>

      {status === null ? null : (
        <div className="absolute top-1/2 left-1/2 flex max-w-[min(90%,460px)] -translate-1/2 items-center gap-[9px] rounded-[10px] border border-[#2a2a2e] bg-[rgba(20,20,22,0.9)] px-3.5 py-[9px] text-[12.5px] text-[#d6d6db]">
          {status}
        </div>
      )}
    </div>
  );
}
