import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { Download } from "patchright";

const limit = 8 * 1024 * 1024;
export type BrowserDownload = {
  id: string;
  name: string;
  size: number;
  createdAt: number;
};
/** Worker-private files. Only an authenticated, encrypted human stream reads bytes. */
export class BrowserDownloads {
  constructor(private directory: string) {}
  async list(): Promise<BrowserDownload[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const records: BrowserDownload[] = [];
    for (const file of await readdir(this.directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
      try {
        const item: BrowserDownload = JSON.parse(
          await readFile(join(this.directory, file), "utf8"),
        );
        if (
          file === `${item.id}.json` &&
          item.size <= limit &&
          (await stat(join(this.directory, item.id))).size === item.size
        )
          records.push(item);
      } catch {}
    }
    return records.sort((a, b) => a.createdAt - b.createdAt);
  }
  private receiving = 0;
  async receive(download: Download) {
    const entries = await this.list();
    if (entries.length + this.receiving >= 4) {
      await download.cancel();
      return;
    }
    this.receiving++;
    const id = randomUUID();
    const path = join(this.directory, id);
    const timer = setTimeout(() => {
      void download.cancel();
    }, 60000);
    try {
      await download.saveAs(path);
      await chmod(path, 0o600);
      const size = (await stat(path)).size;
      if (size > limit)
        throw new Error("Download exceeds the 8 MiB retained-file limit.");
      const name =
        download
          .suggestedFilename()
          .replace(/[^a-zA-Z0-9._ -]/g, "_")
          .slice(0, 160) || "download";
      await writeFile(
        `${path}.json`,
        JSON.stringify({ id, name, size, createdAt: Date.now() }),
        { mode: 0o600 },
      );
    } catch {
      await download.cancel().catch(() => {});
      await rm(path, { force: true });
    } finally {
      clearTimeout(timer);
      this.receiving--;
    }
  }
  async chunk(id: string, offset: number) {
    if (
      !/^[a-f0-9-]{36}$/.test(id) ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw new Error("Invalid download request.");
    const item = (await this.list()).find((item) => item.id === id);
    if (!item || offset > item.size)
      throw new Error("Download is unavailable.");
    const file = await open(join(this.directory, id), "r");
    try {
      const bytes = Buffer.alloc(Math.min(65536, item.size - offset));
      await file.read(bytes, 0, bytes.length, offset);
      return {
        ...item,
        offset,
        bytes: bytes.toString("base64"),
        done: offset + bytes.length === item.size,
      };
    } finally {
      await file.close();
    }
  }
}
