import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * The version a host reports is the product's (issue 1191): the desktop reads its own
 * package's, and the standalone host reads the repository's — the same number — falling back
 * to the coordinator package's own when it runs from somewhere the repository root is not,
 * and to a word only when neither can be read.
 */
export async function productVersion(here: string): Promise<string> {
  for (const candidate of [resolve(here, "../../../package.json"), resolve(here, "../package.json")]) {
    try {
      const parsed = JSON.parse(await readFile(candidate, "utf8")) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.length > 0) return parsed.version;
    } catch {
      /* the next candidate */
    }
  }
  return "standalone";
}
