import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import { KvConflictError, type Kv, type KvPutOptions } from "./kv";

const encode = (key: string) => key.split("/").map(encodeURIComponent).join(sep);
const decode = (path: string) => path.split(sep).map(decodeURIComponent).join("/");
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);

/**
 * Local-disk storage for `eve dev`, so a roster of bots and their job history
 * survive a restart without any cloud dependency.
 */
export function fileKv(root: string): Kv {
  const pathFor = (key: string) => join(root, encode(key));

  return {
    name: `fs(${root})`,
    async get(key) {
      try {
        const value = await readFile(pathFor(key), "utf8");
        return { value, version: hash(value) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async put(key, value, options: KvPutOptions = {}) {
      const path = pathFor(key);
      if (options.expectedVersion !== undefined) {
        const current = await this.get(key);
        const matches =
          options.expectedVersion === null
            ? current === null
            : current?.version === options.expectedVersion;
        if (!matches) throw new KvConflictError(key);
      }
      await mkdir(dirname(path), { recursive: true });
      const staging = `${path}.${process.pid}.${hash(value)}.tmp`;
      await writeFile(staging, value, "utf8");
      await rename(staging, path);
      return hash(value);
    },
    async delete(key) {
      await rm(pathFor(key), { force: true });
    },
    async putBytes(key, bytes) {
      const path = pathFor(key);
      await mkdir(dirname(path), { recursive: true });
      const staging = `${path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(staging, bytes);
      await rename(staging, path);
    },
    async getBytes(key) {
      try {
        return new Uint8Array(await readFile(pathFor(key)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async list(prefix) {
      // Walk only the directory the prefix names, not the whole store: the tick
      // lists the open-job index every minute and must not pay for history.
      const cut = prefix.lastIndexOf("/");
      const base = cut < 0 ? root : join(root, encode(prefix.slice(0, cut)));
      const keys: string[] = [];
      await walk(root, base, keys);
      return keys.filter((key) => key.startsWith(prefix)).sort();
    },
  };
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, path, out);
    } else if (!entry.name.endsWith(".tmp")) {
      out.push(decode(relative(root, path)));
    }
  }
}
