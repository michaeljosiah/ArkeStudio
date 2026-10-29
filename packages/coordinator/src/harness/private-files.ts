import { lstat, open, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { SessionFile } from "@arke-studio/contracts";
import { toExtendedLength } from "../world/paths.js";

/** Retire only the exact small control/config files written by this private preparation.
 * Unknown files, changed bytes, links and nonempty directories remain. No recursive delete. */
export function privateFileRetirement(directory: string, files: readonly SessionFile[], current: () => boolean,
  remove: typeof unlink = unlink): () => Promise<boolean> {
  if (files.length > 16 || files.reduce((bytes, file) => bytes + Buffer.byteLength(file.contents), 0) > 1024 ** 2) throw new Error("Private session control files exceed their bound.");
  const known = files.map(file => {
    const parts = file.name.split(/[\\/]/);
    if (!parts.length || parts.some(part => !part || part === "." || part === ".." || part.includes("\0") || part.includes(":")) || file.name.length > 512 || Buffer.byteLength(file.contents) > 256 * 1024) throw new Error("Private control files must use bounded relative names.");
    return { parts, expected: Buffer.from(file.contents) };
  });
  return async () => {
    if (!current()) return false;
    let confirmed = true;
    const directories = new Set<string>();
    for (const file of known) {
      try {
        let parent = directory, safe = true;
        for (let i = 0; i < file.parts.length; i++) {
          const stat = await lstat(toExtendedLength(parent));
          if (!stat.isDirectory() || stat.isSymbolicLink() || !current()) { safe = false; break; }
          if (parent !== directory) directories.add(parent);
          if (i < file.parts.length - 1) parent = join(parent, file.parts[i]!);
        }
        if (!safe) continue;
        const path = toExtendedLength(join(directory, ...file.parts)), stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.expected.length) continue;
        const handle = await open(path, "r"), bytes = Buffer.alloc(file.expected.length + 1);
        let length = 0;
        try { while (length < bytes.length) { const read = await handle.read(bytes, length, bytes.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; } }
        finally { await handle.close(); }
        if (current() && length === file.expected.length && bytes.subarray(0, length).equals(file.expected)) await remove(path);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") confirmed = false; }
    }
    for (const path of [...directories].sort((a, b) => b.length - a.length)) if (current()) await rmdir(toExtendedLength(path)).catch(() => {});
    return confirmed && current();
  };
}
