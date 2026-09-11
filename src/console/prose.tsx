import type { ReactNode } from "react";

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/;
const HEADING = /^#{1,6}\s+(.*)$/;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index;
    const [whole, code, bold, label, href] = match;
    if (index > last) out.push(text.slice(last, index));
    if (code !== undefined) out.push(<code key={index}>{code.slice(1, -1)}</code>);
    else if (bold !== undefined) out.push(<strong key={index}>{bold.slice(2, -2)}</strong>);
    else if (label !== undefined && href !== undefined) {
      out.push(
        <a key={index} href={href} target="_blank" rel="noopener noreferrer">
          {label}
        </a>,
      );
    }
    last = index + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * The few marks a teammate's message uses — lists, headings, bold, code, and
 * links — rendered as elements. Nothing from the model is ever set as HTML.
 */
export function Prose({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let items: ReactNode[] = [];
  const lines = text.split("\n");

  lines.forEach((line, index) => {
    const item = LIST_ITEM.exec(line);
    if (item) {
      items.push(<li key={index}>{inline(item[1] ?? "")}</li>);
      return;
    }
    if (items.length > 0) {
      blocks.push(<ul key={`list-${index}`}>{items}</ul>);
      items = [];
    }
    const heading = HEADING.exec(line);
    if (heading) blocks.push(<p key={index} className="h">{inline(heading[1] ?? "")}</p>);
    else if (line.trim() !== "") blocks.push(<p key={index}>{inline(line)}</p>);
  });
  if (items.length > 0) blocks.push(<ul key="list-end">{items}</ul>);

  return <>{blocks}</>;
}
