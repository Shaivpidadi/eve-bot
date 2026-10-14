"use client";

import type { Element, ElementContent } from "hast";
import { useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CheckIcon, CopyIcon } from "lucide-react";
import type { PluggableList } from "unified";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { linkMentions, MENTION_HREF, MentionChip, useTeam } from "./mentions";

/**
 * A teammate's message, rendered from GitHub-flavoured Markdown: paragraphs,
 * lists, tables, fenced code, quotes, emphasis, and links. Nothing from the
 * model is ever set as HTML; raw HTML in a message is dropped, and only http(s)
 * and mailto links stay clickable.
 */

/** Some models bullet with "•" or number with "1)", which Markdown does not read as lists. */
const LOOSE_BULLET = /^(\s*)•\s+/gm;
const PAREN_NUMBER = /^(\s*)(\d+)\)\s+/gm;

const normalize = (text: string) => text.replace(LOOSE_BULLET, "$1- ").replace(PAREN_NUMBER, "$1$2. ");

const remarkPlugins: PluggableList = [[remarkGfm, { singleTilde: false }]];

const SAFE_PROTOCOLS = /^(https?:|mailto:|mention:)/i;

/** Relative and unknown-scheme links are shown as text, not opened. */
function safeUrl(url: string): string {
  return SAFE_PROTOCOLS.test(url) ? url : "";
}

/** The plain text inside a hast element, for copying a code block. */
function textOf(node: ElementContent | Element | undefined): string {
  if (node === undefined) return "";
  if (node.type === "text") return node.value;
  if (node.type === "element") return node.children.map(textOf).join("");
  return "";
}

/** How many columns a table has, from its header row. */
function columnCount(table: Element | undefined): number {
  const head = table?.children.find((child): child is Element => child.type === "element" && child.tagName === "thead");
  const row = head?.children.find((child): child is Element => child.type === "element" && child.tagName === "tr");
  return row?.children.filter((child) => child.type === "element").length ?? 0;
}

function CodeBlock({ node, children }: { node?: Element; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = textOf(node).replace(/\n$/, "");
  const language = /language-([\w-]+)/.exec(classOf(node))?.[1];

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard access can be refused; the text is still selectable.
    }
  }

  return (
    <div className="my-1.5 overflow-hidden rounded-lg border border-border bg-[rgba(127,127,127,0.08)]">
      <div className="flex items-center justify-between border-b border-border py-0.5 pr-1.5 pl-2.5 text-[11px] text-muted-foreground">
        <span>{language ?? "code"}</span>
        <Button variant="ghost" size="xs" className="h-5 text-[11px] text-muted-foreground" onClick={() => void copy()} aria-label="Copy code">
          {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="m-0 overflow-x-auto px-2.5 py-2 font-mono text-xs leading-normal [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[length:inherit] [&_code]:leading-[inherit]">
        {children}
      </pre>
    </div>
  );
}

/** The class list of the `<code>` inside a `<pre>`, where Markdown puts the language. */
function classOf(pre: Element | undefined): string {
  const code = pre?.children.find((child): child is Element => child.type === "element" && child.tagName === "code");
  const className = code?.properties?.className;
  return Array.isArray(className) ? className.join(" ") : typeof className === "string" ? className : "";
}

/** A two-column table reads as stacked label and body rows on a phone. */
const KV_ON_PHONE =
  "max-[760px]:block max-[760px]:[&_thead]:hidden max-[760px]:[&_tbody]:block max-[760px]:[&_tr]:block max-[760px]:[&_td]:block max-[760px]:[&_td]:w-full max-[760px]:[&_td]:border-b-0 max-[760px]:[&_td]:px-2.5 max-[760px]:[&_td]:py-0.5 max-[760px]:[&_td]:bg-transparent! max-[760px]:[&_td:first-child]:pt-2 max-[760px]:[&_td:first-child]:font-semibold max-[760px]:[&_td:last-child]:border-b max-[760px]:[&_td:last-child]:pb-2 max-[760px]:[&_tr:last-child>td:last-child]:border-b-0";

// Headings inside a chat bubble read as bold lead lines, not page titles.
const Lead = ({ children }: { children?: ReactNode }) => <p className="m-0 font-semibold">{children}</p>;

const components: Components = {
  h1: Lead,
  h2: Lead,
  h3: Lead,
  h4: Lead,
  h5: Lead,
  h6: Lead,
  p: ({ children }) => <p className="m-0">{children}</p>,
  ul: ({ children }) => <ul className="my-1 list-disc pl-[18px]">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 list-decimal pl-5">{children}</ol>,
  li: ({ children }) => <li className="[&+li]:mt-0.5 [&>p]:m-0">{children}</li>,
  blockquote: ({ children }) => <blockquote className="my-1 border-l-2 border-input py-0.5 pl-2.5 text-muted-foreground">{children}</blockquote>,
  hr: () => <hr className="my-2 border-0 border-t border-border" />,
  del: ({ children }) => <del className="text-muted-foreground">{children}</del>,
  code: ({ children, className }) => (
    <code className={cn("rounded bg-[rgba(127,127,127,0.16)] px-1 py-px font-mono text-xs", className)}>{children}</code>
  ),
  input: ({ type, checked }) =>
    type === "checkbox" ? (
      <input type="checkbox" checked={checked === true} readOnly className="pointer-events-none mr-1.5 align-[-1px]" />
    ) : null,
  a: ({ href, children }) =>
    href && MENTION_HREF.test(href) ? (
      <Mention id={decodeURIComponent(MENTION_HREF.exec(href)?.[1] ?? "")}>{children}</Mention>
    ) : href ? (
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-inherit underline underline-offset-2">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  pre: ({ node, children }) => <CodeBlock node={node}>{children}</CodeBlock>,
  table: ({ node, children }) => (
    <div className="my-1.5 overflow-x-auto rounded-lg border border-border">
      <table className={cn("w-full border-collapse text-[12.5px] leading-snug", columnCount(node) === 2 && KV_ON_PHONE)}>{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-border bg-[rgba(127,127,127,0.1)] px-2.5 py-1.5 text-left align-top font-semibold whitespace-nowrap [&>p]:m-0">{children}</th>
  ),
  td: ({ children }) => <td className="border-b border-border px-2.5 py-1.5 text-left align-top [&>p]:m-0">{children}</td>,
  tr: ({ children }) => <tr className="even:[&>td]:bg-[rgba(127,127,127,0.05)] [&:last-child>td]:border-b-0">{children}</tr>,
};

/** A tag in a reply: the teammate's chip, or the plain text if they have left. */
function Mention({ id, children }: { id: string; children: ReactNode }) {
  const member = useTeam().find((entry) => entry.id === id);
  return member === undefined ? <span>{children}</span> : <MentionChip member={member} />;
}

export function Prose({ text }: { text: string }) {
  const team = useTeam();
  return (
    <div className="[&>p+p]:mt-1.5">
      <Markdown remarkPlugins={remarkPlugins} components={components} urlTransform={safeUrl} skipHtml>
        {linkMentions(normalize(text), team)}
      </Markdown>
    </div>
  );
}
