import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { ArtifactKind } from "@arke-studio/contracts";
import { toExtendedLength } from "../world/paths.js";
import { slugify } from "../world/slug.js";
import { kindForFile, LARGE_FILE_BYTES } from "./filing.js";

/**
 * Attachments made before the world exists.
 *
 * A genesis conversation has nowhere to file: there is no world, no commit journal, no
 * artifacts directory. So what is handed over waits in `attachments/` inside the sandbox —
 * which is also the world-author agent's working directory, so handing it a series bible means
 * the agent can actually read it — and moves into the world at Begin (SPEC-015 D8: still
 * copied in, never referenced).
 *
 * Abandon the conversation and the sandbox is removed with everything in it. That is the right
 * outcome: nothing was filed, so nothing is left behind.
 */

export const GENESIS_ATTACHMENTS_DIR = "attachments";

export type SandboxOutcome = { name: string; kind: ArtifactKind } | { reason: string };

/** Copy one file into the sandbox, keeping a name the user will recognise among any clashes. */
export async function attachToSandbox(sandboxDir: string, sourcePath: string): Promise<SandboxOutcome> {
  let size: number;
  try {
    size = (await stat(toExtendedLength(sourcePath))).size;
  } catch {
    return { reason: `${basename(sourcePath)} is not readable` };
  }
  // No consent flow before a world exists — there is no ledger, no disk report and no screen
  // to carry the question. Say so plainly instead, and let it be attached once the world is real.
  if (size > LARGE_FILE_BYTES) {
    return {
      reason: `${basename(sourcePath)} is ${(size / (1024 * 1024)).toFixed(0)} MB — attach it once the world exists, where its size can be weighed`,
    };
  }

  const dir = join(sandboxDir, GENESIS_ATTACHMENTS_DIR);
  await mkdir(toExtendedLength(dir), { recursive: true });

  const original = basename(sourcePath);
  const ext = extname(original).toLowerCase();
  const stem = slugify(original.slice(0, original.length - ext.length)) || "attachment";
  const taken = new Set(await readdir(toExtendedLength(dir)).catch(() => [] as string[]));
  let name = `${stem}${ext}`;
  for (let i = 2; taken.has(name); i++) name = `${stem}-${i}${ext}`;

  try {
    await copyFile(toExtendedLength(sourcePath), toExtendedLength(join(dir, name)));
  } catch (err) {
    return { reason: err instanceof Error ? err.message : String(err) };
  }
  return { name, kind: kindForFile(name) };
}

/** Everything waiting in a sandbox, as absolute paths, oldest name first for a stable order. */
export async function sandboxAttachments(sandboxDir: string): Promise<string[]> {
  const dir = join(sandboxDir, GENESIS_ATTACHMENTS_DIR);
  const names = await readdir(toExtendedLength(dir)).catch(() => [] as string[]);
  return names.sort().map((n) => join(dir, n));
}
