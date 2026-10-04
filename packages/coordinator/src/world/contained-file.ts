import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

/** Authoritative private files still reject traversal and reparse points in imported worlds. */
export async function containedWorldFilePath(root: string, portable: string, createParents = false, context = "world", allowMissingFinal = false): Promise<string> {
  if (!portable || /[\\:]/.test(portable) || portable.includes("\0") || isAbsolute(portable)) throw new Error(`${context}-path-invalid`);
  const parts = portable.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || /[. ]$/.test(part))) throw new Error(`${context}-path-invalid`);
  const base = await realpath(root);
  let cursor = base;
  for (let index = 0; index < parts.length; index++) {
    cursor = join(cursor, parts[index]!);
    if (createParents && index < parts.length - 1) await mkdir(cursor).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error(`${context}-directory-unavailable`);
    });
    const info = await lstat(cursor).catch(error => {
      if ((createParents || allowMissingFinal) && index === parts.length - 1 && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (info?.isSymbolicLink() || (index < parts.length - 1 && !info?.isDirectory()) ||
      (index === parts.length - 1 && info && !info.isFile())) throw new Error(`${context}-path-invalid`);
    if (info) {
      const rel = relative(base, await realpath(cursor));
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${context}-path-invalid`);
    }
  }
  return cursor;
}
