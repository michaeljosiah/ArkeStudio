import { lstat, mkdir, mkdtemp, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserMediaFilesSchema, type BrowserMediaFile } from "@arke-studio/contracts";

/** One bounded batch per host. Authored filing still belongs to the existing world service. */
export class BrowserMediaImports {
  private busy = false;

  async run<T>(files: readonly BrowserMediaFile[], abandoned: () => boolean, consume: (paths: string[]) => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("Another browser import is running. Wait for it to finish.");
    this.busy = true;
    let directory: string | undefined;
    let identity: Awaited<ReturnType<typeof lstat>> | undefined;
    const paths: string[] = [], children: string[] = [];
    try {
      const checked = BrowserMediaFilesSchema.parse(files);
      if (abandoned()) throw new Error("The world closed during import.");
      const base = await realpath(tmpdir());
      directory = await mkdtemp(join(base, "arke-browser-import-"));
      identity = await lstat(directory);
      for (const [index, file] of checked.entries()) {
        if (abandoned()) throw new Error("The world closed during import.");
        const child = join(directory, String(index));
        await mkdir(child); children.push(child);
        const path = join(child, file.name);
        const bytes = Buffer.from(file.data, "base64");
        if (bytes.toString("base64") !== file.data) throw new Error(`${file.name}: invalid file bytes.`);
        paths.push(path); await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
      }
      if (abandoned()) throw new Error("The world closed during import.");
      return await consume(paths);
    } finally {
      try {
        if (directory && identity) {
          const current = await lstat(directory);
          // Never follow an externally replaced directory during cleanup. Remove only our files.
          if (!current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino && await realpath(directory) === directory) {
            for (const child of children) if (!(await lstat(child)).isSymbolicLink() && await realpath(child) === child) {
              for (const path of paths) if (path.startsWith(child + (process.platform === "win32" ? "\\" : "/"))) await unlink(path).catch(error => { if (error.code !== "ENOENT") throw error; });
              await rmdir(child);
            }
            await rmdir(directory);
          }
        }
      } catch { /* An externally replaced or inaccessible spool is no longer safe to remove. */ }
      finally { this.busy = false; }
    }
  }
}
