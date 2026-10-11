import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as connectTcp, type AddressInfo } from "node:net";

import { Agent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { vi } from "vitest";

/**
 * An in-process stand-in for the Vercel Blob service, spoken to over real HTTP
 * by the real @vercel/blob 2.8.0 SDK.
 *
 * The SDK sends API calls (put, head, list, delete) to `https://vercel.com/api/blob`
 * and reads a private blob's bytes straight from
 * `https://<storeId>.private.blob.vercel-storage.com/<pathname>`, both through
 * undici's `fetch`. Neither host can be pointed elsewhere by configuration
 * (`VERCEL_BLOB_API_URL` moves only the first), so the fake installs an undici
 * global dispatcher whose connector opens a plain TCP socket to a local HTTP
 * server for every origin, and the server routes on the `Host` header. Nothing
 * leaves the machine, and an unknown host is answered 502 and logged, so a test
 * that would have reached the network fails instead.
 *
 * What it reproduces, from the SDK's own request building and error mapping
 * (`node_modules/@vercel/blob/dist/chunk-YYMLUMXS.js`, `index.js`):
 *
 * - `PUT /api/blob/?pathname=` with `x-allow-overwrite` (absent = no overwrite,
 *   the v2 default) and `x-if-match`. A stale or missing `x-if-match` is 412
 *   `precondition_failed` (the SDK throws BlobPreconditionFailedError); a
 *   create-only write to an existing pathname is 400 `bad_request`, "This blob
 *   already exists" (a plain BlobError).
 * - ETags: strong and quoted, new on every write. A read of a body larger than
 *   `weakEtagOverBytes` comes back weak (`W/"…"`), as the service does for a
 *   compressed response; `x-if-match` only accepts the strong form.
 * - `GET /api/blob/?url=` (head), `GET /api/blob/?prefix=&limit=&cursor=` (list,
 *   sorted, paged at `min(limit, pageSize)`), `POST /api/blob/delete`.
 * - Blob reads with the CDN in the way: a read without `?cache=0` is served
 *   from a per-pathname cache filled on first read and never invalidated, so a
 *   driver that forgets `useCache: false` sees stale data and stale ETags.
 *
 * Faults, consumed in order by the first request they match:
 *
 * - `lose-response`: the write is applied, then the socket is destroyed before
 *   any response. undici reports `fetch failed`, the SDK retries (it retries
 *   network errors and 5xx, `VERCEL_BLOB_RETRIES`, default 10) and the retry
 *   meets the state the lost write left behind.
 * - `fail-before`: 503 `service_unavailable` without applying (retried).
 * - `fail-after`: applied, then 500 `internal_server_error` (also retried).
 *
 * The SDK's backoff starts at about a second, so every retried fault costs a
 * test one to two seconds.
 */

export interface BlobObject {
  readonly body: Buffer;
  readonly etag: string;
  readonly contentType: string;
  readonly cacheControlMaxAge: number;
  readonly uploadedAt: string;
}

export type FaultKind = "lose-response" | "fail-before" | "fail-after";

export interface Fault {
  readonly kind: FaultKind;
  /** Which API operation: put, head, list, delete; or `read` for blob bytes. */
  readonly op: "put" | "head" | "list" | "delete" | "read";
  /** Only requests for this pathname (or, for list, this prefix); any when absent. */
  readonly pathname?: string;
  /** Only requests for pathnames under this prefix. */
  readonly prefix?: string;
  /** How many matching requests it applies to. Default 1. */
  times?: number;
}

export interface LoggedRequest {
  readonly op: string;
  readonly pathname: string | null;
  readonly host: string;
  readonly attempt: number | null;
  readonly status: number | "dropped";
  readonly headers: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
}

export const STORE_ID = "fakestore";
export const TOKEN = `vercel_blob_rw_${STORE_ID}_notarealsecret`;

/** An unexpired JWT-shaped token, so @vercel/oidc never tries to refresh one from a linked project. */
export const FAKE_OIDC_TOKEN = [
  Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
  Buffer.from(JSON.stringify({ exp: 4_102_444_800 })).toString("base64url"),
  "sig",
].join(".");

/** Points the store and the SDK at the fake: forced Blob backend, a read-write token, no OIDC refresh. */
export function useFakeBlobEnv(prefix = "t"): void {
  vi.stubEnv("BOT_STORE", "blob");
  vi.stubEnv("BOT_STORE_PREFIX", prefix);
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", TOKEN);
  vi.stubEnv("BLOB_STORE_ID", "");
  vi.stubEnv("VERCEL_OIDC_TOKEN", FAKE_OIDC_TOKEN);
  vi.stubEnv("VERCEL_BLOB_API_URL", "");
  vi.stubEnv("NEXT_PUBLIC_VERCEL_BLOB_API_URL", "");
  vi.stubEnv("VERCEL_BLOB_RETRIES", "");
}

export class FakeBlobService {
  readonly objects = new Map<string, BlobObject>();
  readonly log: LoggedRequest[] = [];
  readonly faults: Fault[] = [];
  /** Hosts that were asked for and are not the Blob service. */
  readonly strayHosts: string[] = [];
  pageSize = 1000;
  weakEtagOverBytes = 1024;
  private readonly cdn = new Map<string, BlobObject>();
  private sequence = 0;
  private server: Server | null = null;
  private previous: Dispatcher | null = null;
  private agent: Agent | null = null;

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        if (!res.headersSent) this.json(res, 500, { error: { code: "internal_server_error", message: String(error) } });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.server = server;
    const { port } = server.address() as AddressInfo;
    this.agent = new Agent({
      connect: (_options, callback) => {
        const socket = connectTcp(port, "127.0.0.1");
        socket.once("connect", () => callback(null, socket));
        socket.once("error", (error) => callback(error, null));
        return socket;
      },
    });
    this.previous = getGlobalDispatcher();
    setGlobalDispatcher(this.agent);
  }

  async stop(): Promise<void> {
    if (this.previous !== null) setGlobalDispatcher(this.previous);
    await this.agent?.close().catch(() => undefined);
    await new Promise<void>((resolve) => {
      if (this.server === null) return resolve();
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }

  reset(): void {
    this.objects.clear();
    this.cdn.clear();
    this.log.length = 0;
    this.faults.length = 0;
    this.strayHosts.length = 0;
    this.pageSize = 1000;
  }

  inject(fault: Fault): void {
    this.faults.push({ ...fault, times: fault.times ?? 1 });
  }

  /** Requests of one operation, optionally for one pathname. */
  requests(op: string, pathname?: string): LoggedRequest[] {
    return this.log.filter((entry) => entry.op === op && (pathname === undefined || entry.pathname === pathname));
  }

  text(pathname: string): string | null {
    return this.objects.get(pathname)?.body.toString("utf8") ?? null;
  }

  // -------------------------------------------------------------------------

  private takeFault(op: Fault["op"], pathname: string | null): Fault | null {
    const index = this.faults.findIndex(
      (fault) =>
        fault.op === op &&
        (fault.pathname === undefined || fault.pathname === pathname) &&
        (fault.prefix === undefined || (pathname ?? "").startsWith(fault.prefix)) &&
        (fault.times ?? 1) > 0,
    );
    if (index === -1) return null;
    const fault = this.faults[index]!;
    fault.times = (fault.times ?? 1) - 1;
    if (fault.times <= 0) this.faults.splice(index, 1);
    return fault;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = (req.headers.host ?? "").split(":")[0] ?? "";
    const url = new URL(req.url ?? "/", "http://fake");
    const body = await readBody(req);
    const headers = Object.fromEntries(Object.entries(req.headers).map(([name, value]) => [name, String(value)]));
    const query = Object.fromEntries(url.searchParams.entries());
    const attempt = headers["x-api-blob-request-attempt"] === undefined ? null : Number(headers["x-api-blob-request-attempt"]);
    const entry = (op: string, pathname: string | null, status: number | "dropped") =>
      this.log.push({ op, pathname, host, attempt, status, headers, query });

    if (host === "vercel.com" && url.pathname.startsWith("/api/blob")) {
      if (headers.authorization !== `Bearer ${TOKEN}`) {
        entry("auth", null, 403);
        return this.json(res, 403, { error: { code: "forbidden", message: "Forbidden" } });
      }
      const route = url.pathname.slice("/api/blob".length);
      if (req.method === "PUT" && (route === "" || route === "/")) return this.put(url, headers, body, res, entry);
      if (req.method === "GET" && url.searchParams.has("url")) return this.head(url, res, entry);
      if (req.method === "GET") return this.list(url, res, entry);
      if (req.method === "POST" && route === "/delete") return this.delete(body, res, entry);
      entry("unknown", null, 400);
      return this.json(res, 400, { error: { code: "bad_request", message: `Unsupported ${req.method} ${route}` } });
    }

    const storage = `${STORE_ID}.private.blob.vercel-storage.com`;
    if (host === storage && req.method === "GET") return this.read(url, headers, res, entry);

    this.strayHosts.push(host);
    entry("stray", null, 502);
    res.writeHead(502).end();
  }

  private put(
    url: URL,
    headers: Record<string, string>,
    body: Buffer,
    res: ServerResponse,
    entry: (op: string, pathname: string | null, status: number | "dropped") => void,
  ): void {
    const pathname = url.searchParams.get("pathname") ?? "";
    const fault = this.takeFault("put", pathname);
    if (fault?.kind === "fail-before") {
      entry("put", pathname, 503);
      return this.json(res, 503, { error: { code: "service_unavailable", message: "Service unavailable" } });
    }
    const existing = this.objects.get(pathname);
    const ifMatch = headers["x-if-match"];
    if (ifMatch !== undefined && (existing === undefined || existing.etag !== ifMatch)) {
      entry("put", pathname, 412);
      return this.json(res, 412, { error: { code: "precondition_failed", message: "Precondition failed: ETag mismatch." } });
    }
    if (existing !== undefined && headers["x-allow-overwrite"] !== "1") {
      entry("put", pathname, 400);
      return this.json(res, 400, {
        error: {
          code: "bad_request",
          message: "This blob already exists, use `allowOverwrite: true` if you want to overwrite it. Or `addRandomSuffix: true` to generate a unique filename.",
        },
      });
    }
    this.sequence += 1;
    const etag = `"${createHash("sha1").update(`${this.sequence}:`).update(body).digest("hex")}"`;
    const object: BlobObject = {
      body,
      etag,
      contentType: headers["x-content-type"] ?? "application/octet-stream",
      cacheControlMaxAge: Number(headers["x-cache-control-max-age"] ?? 2_592_000),
      uploadedAt: new Date().toISOString(),
    };
    this.objects.set(pathname, object);

    if (fault?.kind === "lose-response") {
      entry("put", pathname, "dropped");
      res.socket?.destroy();
      return;
    }
    if (fault?.kind === "fail-after") {
      entry("put", pathname, 500);
      return this.json(res, 500, { error: { code: "internal_server_error", message: "Internal error" } });
    }
    entry("put", pathname, 200);
    this.json(res, 200, {
      url: blobUrl(pathname),
      downloadUrl: `${blobUrl(pathname)}?download=1`,
      pathname,
      contentType: object.contentType,
      contentDisposition: `attachment; filename="${pathname.split("/").pop() ?? ""}"`,
      etag,
    });
  }

  private head(url: URL, res: ServerResponse, entry: (op: string, pathname: string | null, status: number | "dropped") => void): void {
    const target = url.searchParams.get("url") ?? "";
    const pathname = pathnameOf(target);
    if (this.failed("head", pathname, res, entry)) return;
    const object = this.objects.get(pathname);
    if (object === undefined) {
      entry("head", pathname, 404);
      return this.json(res, 404, { error: { code: "not_found", message: "The requested blob does not exist" } });
    }
    entry("head", pathname, 200);
    this.json(res, 200, {
      url: blobUrl(pathname),
      downloadUrl: `${blobUrl(pathname)}?download=1`,
      pathname,
      size: object.body.byteLength,
      contentType: object.contentType,
      contentDisposition: "attachment",
      cacheControl: `public, max-age=${object.cacheControlMaxAge}`,
      uploadedAt: object.uploadedAt,
      etag: object.etag,
    });
  }

  private list(url: URL, res: ServerResponse, entry: (op: string, pathname: string | null, status: number | "dropped") => void): void {
    const prefix = url.searchParams.get("prefix") ?? "";
    if (this.failed("list", prefix, res, entry)) return;
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 1000), this.pageSize);
    const offset = Number(url.searchParams.get("cursor") ?? 0);
    const matching = [...this.objects.keys()].filter((pathname) => pathname.startsWith(prefix)).sort();
    const page = matching.slice(offset, offset + limit);
    const hasMore = offset + limit < matching.length;
    entry("list", prefix, 200);
    this.json(res, 200, {
      blobs: page.map((pathname) => {
        const object = this.objects.get(pathname)!;
        return {
          url: blobUrl(pathname),
          downloadUrl: `${blobUrl(pathname)}?download=1`,
          pathname,
          size: object.body.byteLength,
          uploadedAt: object.uploadedAt,
          etag: object.etag,
        };
      }),
      hasMore,
      ...(hasMore ? { cursor: String(offset + limit) } : {}),
    });
  }

  private delete(body: Buffer, res: ServerResponse, entry: (op: string, pathname: string | null, status: number | "dropped") => void): void {
    const { urls } = JSON.parse(body.toString("utf8")) as { urls: string[] };
    const pathnames = urls.map(pathnameOf);
    const fault = this.takeFault("delete", pathnames[0] ?? null);
    if (fault?.kind === "fail-before") {
      entry("delete", pathnames[0] ?? null, 503);
      return this.json(res, 503, { error: { code: "service_unavailable", message: "Service unavailable" } });
    }
    for (const pathname of pathnames) {
      this.objects.delete(pathname);
      this.cdn.delete(pathname);
    }
    if (fault?.kind === "lose-response") {
      entry("delete", pathnames[0] ?? null, "dropped");
      res.socket?.destroy();
      return;
    }
    entry("delete", pathnames[0] ?? null, 200);
    this.json(res, 200, {});
  }

  private read(
    url: URL,
    headers: Record<string, string>,
    res: ServerResponse,
    entry: (op: string, pathname: string | null, status: number | "dropped") => void,
  ): void {
    const pathname = decodeURIComponent(url.pathname.slice(1));
    if (headers.authorization !== `Bearer ${TOKEN}`) {
      entry("read", pathname, 403);
      return void res.writeHead(403).end();
    }
    if (this.failed("read", pathname, res, entry)) return;
    const bypass = url.searchParams.get("cache") === "0";
    let object = this.objects.get(pathname);
    if (!bypass) {
      const cached = this.cdn.get(pathname);
      if (cached !== undefined) object = cached;
      else if (object !== undefined) this.cdn.set(pathname, object);
    }
    if (object === undefined) {
      entry("read", pathname, 404);
      return void res.writeHead(404).end();
    }
    entry("read", pathname, 200);
    const etag = object.body.byteLength > this.weakEtagOverBytes ? `W/${object.etag}` : object.etag;
    res.writeHead(200, {
      "content-type": object.contentType,
      "content-length": String(object.body.byteLength),
      "last-modified": new Date(object.uploadedAt).toUTCString(),
      "cache-control": bypass ? "no-store" : `private, max-age=${object.cacheControlMaxAge}`,
      etag,
    });
    res.end(object.body);
  }

  /** A read-only operation's fault: 503 before answering, or the socket dropped. */
  private failed(
    op: Fault["op"],
    pathname: string,
    res: ServerResponse,
    entry: (op: string, pathname: string | null, status: number | "dropped") => void,
  ): boolean {
    const fault = this.takeFault(op, pathname);
    if (fault === null) return false;
    if (fault.kind === "lose-response") {
      entry(op, pathname, "dropped");
      res.socket?.destroy();
    } else {
      entry(op, pathname, 503);
      this.json(res, 503, { error: { code: "service_unavailable", message: "Service unavailable" } });
    }
    return true;
  }

  private json(res: ServerResponse, status: number, value: unknown): void {
    const text = JSON.stringify(value);
    res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) });
    res.end(text);
  }
}

const blobUrl = (pathname: string) => `https://${STORE_ID}.private.blob.vercel-storage.com/${pathname}`;

function pathnameOf(urlOrPathname: string): string {
  try {
    return decodeURIComponent(new URL(urlOrPathname).pathname.slice(1));
  } catch {
    return urlOrPathname;
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
