/**
 * Reads an HTTP Accept header the way content negotiation asks: each type
 * with its q-weight, Markdown winning ties against HTML since an asker that
 * names both wants the one it would otherwise never get. No request touched.
 */
export function prefersMarkdown(accept: string | null | undefined): boolean {
  if (!accept) return false;
  let markdown = -1;
  let html = -1;
  for (const entry of accept.split(",")) {
    const [rawType = "", ...params] = entry.trim().split(";");
    const type = rawType.trim().toLowerCase();
    const q = params
      .map((param) => param.trim())
      .find((param) => param.startsWith("q="))
      ?.slice(2);
    const weight = q === undefined ? 1 : Number.parseFloat(q);
    if (Number.isNaN(weight) || weight <= 0) continue;
    if (type === "text/markdown") markdown = Math.max(markdown, weight);
    else if (type === "text/html" || type === "application/xhtml+xml") html = Math.max(html, weight);
  }
  return markdown > 0 && markdown >= html;
}
