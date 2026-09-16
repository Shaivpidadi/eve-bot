"use client";

import type { Element, ElementContent } from "hast";
import { useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PluggableList } from "unified";

import { Icon } from "./icons";

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

const SAFE_PROTOCOLS = /^(https?:|mailto:)/i;

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
    <div className="codeblock">
      <div className="codeblock-bar">
        <span>{language ?? "code"}</span>
        <button type="button" onClick={() => void copy()} aria-label="Copy code">
          <Icon name={copied ? "check" : "copy"} size={12} />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

/** The class list of the `<code>` inside a `<pre>`, where Markdown puts the language. */
function classOf(pre: Element | undefined): string {
  const code = pre?.children.find((child): child is Element => child.type === "element" && child.tagName === "code");
  const className = code?.properties?.className;
  return Array.isArray(className) ? className.join(" ") : typeof className === "string" ? className : "";
}

const components: Components = {
  // Headings inside a chat bubble read as bold lead lines, not page titles.
  h1: ({ children }) => <p className="h">{children}</p>,
  h2: ({ children }) => <p className="h">{children}</p>,
  h3: ({ children }) => <p className="h">{children}</p>,
  h4: ({ children }) => <p className="h">{children}</p>,
  h5: ({ children }) => <p className="h">{children}</p>,
  h6: ({ children }) => <p className="h">{children}</p>,
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  pre: ({ node, children }) => <CodeBlock node={node}>{children}</CodeBlock>,
  table: ({ node, children }) => (
    <div className="table-wrap">
      <table className={columnCount(node) === 2 ? "kv" : undefined}>{children}</table>
    </div>
  ),
};

export function Prose({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={remarkPlugins} components={components} urlTransform={safeUrl} skipHtml>
      {normalize(text)}
    </Markdown>
  );
}
