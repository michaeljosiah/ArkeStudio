import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { ImportFileLease, ImportFileSpace } from "../storage/import-files.js";
import { containedWorldFilePath } from "../world/contained-file.js";
import { toExtendedLength } from "../world/paths.js";

/** What a world export leaves behind (SPEC-013 D12), never its history or creative records. */
export const WORLD_EXPORT_EXCLUDED = [
  ".index", ".commit", ".proposals", ".conversations", ".sessions", ".staging", ".cache", "world.lock",
];
const METADATA_BYTES = 64 * 1024;
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const inside = (root: string, path: string) => { const rel = relative(root, path); return !rel || !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`); };

/** A measured finite copy through the existing export reservation owner (SPEC-062 R-8/R-9).
 * The caller owns world lifetime. Failed copies remain inspectable; neither the source nor
 * another export is deleted or overwritten. This is not an atomic snapshot of outside edits. */
export async function exportWorld(worldDir: string, targetDir: string, options: { fileSpace?: ImportFileSpace; signal?: AbortSignal } = {}): Promise<void> {
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const source = await realpath(toExtendedLength(worldDir));
  // Resolve the existing ancestor before creating any directories: an export inside its
  // source would otherwise add the export to the very tree being measured and copied.
  let ancestor = resolve(targetDir);
  const suffix: string[] = [];
  for (;;) {
    try { ancestor = await realpath(toExtendedLength(ancestor)); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(ancestor) === ancestor) throw error;
      suffix.unshift(basename(ancestor)); ancestor = dirname(ancestor);
    }
  }
  if (inside(source, join(ancestor, ...suffix))) throw new Error("Choose an export destination outside the source world.");
  signal.throwIfAborted();
  await mkdir(toExtendedLength(dirname(targetDir)), { recursive: true });
  const target = join(await realpath(toExtendedLength(dirname(targetDir))), basename(targetDir));
  if (inside(source, target)) throw new Error("Choose an export destination outside the source world.");
  const files: Array<{ path: string; info: Stats }> = [], directories: string[] = [];
  const pending = [""], buffer = Buffer.alloc(1024 * 1024);
  let payload = 0, sliceEntries = 0, sliceStarted = performance.now();
  while (pending.length) {
    signal.throwIfAborted();
    const portable = pending.pop()!, path = join(source, portable);
    if ((await lstat(toExtendedLength(path))).isSymbolicLink() || !inside(source, await realpath(toExtendedLength(path)))) throw new Error("World export cannot follow linked directories.");
    const directory = await opendir(toExtendedLength(path));
    for await (const entry of directory) {
      signal.throwIfAborted();
      if (++sliceEntries >= 1000 || performance.now() - sliceStarted >= 50) {
        await setImmediate(); signal.throwIfAborted(); sliceEntries = 0; sliceStarted = performance.now();
      }
      const child = portable ? `${portable}/${entry.name}` : entry.name;
      if (!portable && WORLD_EXPORT_EXCLUDED.includes(entry.name) || /\.tmp-[0-9A-Z]+$/i.test(child)) continue;
      const info = await lstat(toExtendedLength(join(source, child)));
      if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) throw new Error("World export requires regular files and directories; linked or special files were retained in the source.");
      if (info.isDirectory()) { directories.push(child); pending.push(child); }
      else { files.push({ path: child, info }); payload += info.size; }
      if (!Number.isSafeInteger(payload + (files.length + directories.length + 1) * METADATA_BYTES)) throw new Error("World export size could not be measured safely.");
    }
  }
  signal.throwIfAborted();
  // Exclusive creation also protects an earlier partial export with the same name.
  await mkdir(toExtendedLength(target)).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("An export already exists at this destination. It was kept; start a new export.");
    throw error;
  });
  let lease: ImportFileLease | undefined, handlesClosed = true;
  try {
    lease = await options.fileSpace?.reserve(target, payload + (files.length + directories.length) * METADATA_BYTES, signal, "exports");
    signal.throwIfAborted();
    for (const path of directories) {
      signal.throwIfAborted();
      await mkdir(toExtendedLength(join(target, path)), { recursive: true });
    }
    for (const file of files) {
      signal.throwIfAborted();
      const sourcePath = await containedWorldFilePath(source, file.path, false, "world-export");
      const targetPath = await containedWorldFilePath(target, file.path, true, "world-export", true);
      let input: FileHandle | undefined, output: FileHandle | undefined, reported = 0;
      let failure: { error: unknown } | undefined;
      try {
        input = await open(toExtendedLength(sourcePath), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        if (!sameFile(file.info, await input.stat())) throw new Error("The source world changed after export planning. The source and copied files were kept.");
        signal.throwIfAborted();
        output = await open(toExtendedLength(targetPath), "wx", file.info.mode & 0o777);
        let copied = 0;
        while (copied < file.info.size) {
          signal.throwIfAborted();
          const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, file.info.size - copied), null);
          if (!bytesRead) throw new Error("A world export source ended before its measured size.");
          let written = 0;
          while (written < bytesRead) {
            signal.throwIfAborted();
            const result = await output.write(buffer, written, bytesRead - written, null);
            if (!result.bytesWritten) throw new Error("World export copy made no progress.");
            written += result.bytesWritten;
          }
          copied += bytesRead;
          if (copied - reported >= 32 * 1024 * 1024) { await lease?.consumed(copied - reported); reported = copied; }
        }
        if (!sameFile(file.info, await input.stat())) throw new Error("A source file changed while exporting. The source and copied files were kept.");
        await output.sync();
      } catch (error) { failure = { error }; }
      finally {
        const closed = await Promise.allSettled([input?.close(), output?.close()]);
        if (closed.some(result => result.status === "rejected")) {
          handlesClosed = false; failure = { error: new Error("An export file could not close. Storage remains reserved; the copied files were kept.") };
        }
      }
      if (failure) throw failure.error;
      await lease?.consumed(file.info.size - reported);
    }
    signal.throwIfAborted();
  } catch (error) { lease?.writeFailed(); throw error; }
  finally { if (handlesClosed) await lease?.settle(); }
}
