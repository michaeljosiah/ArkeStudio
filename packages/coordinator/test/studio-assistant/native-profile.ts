import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** Entire disposable native profile, never personal/user storage. Finite evidence only;
 * positive detector coverage and filesystem/platform qualification live in the native suite. */
export async function assertNativeProfileExcludes(profile: string, markers: readonly string[]): Promise<void> {
  let bytes = 0, files = 0, entries = 0;
  const scan = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      assert(++entries <= 1024, "the entire synthetic profile must fit its entry budget");
      const file = join(path, entry.name);
      if (entry.isDirectory()) { await scan(file); continue; }
      assert(entry.isFile(), "no unexamined linked native profile entries");
      const size = (await stat(file)).size; bytes += size;
      assert(size <= 64 * 1024 ** 2 && bytes <= 128 * 1024 ** 2, "the entire synthetic profile must fit its byte budget");
      const content = await readFile(file); files++;
      for (const marker of markers) assert(!content.includes(Buffer.from(marker)), `private marker retained in owned native profile: ${entry.name}`);
    }
  };
  await scan(profile); assert(files > 0, "the native profile scan must examine real files");
}
