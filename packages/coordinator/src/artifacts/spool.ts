import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

/**
 * The paste spool.
 *
 * Some things arrive with no file behind them — a screenshot straight off the clipboard, a note
 * too long to be a message. They become a real file here so the ordinary filing path can take
 * them, which means one set of rules about size, kind, dedupe and consent rather than a second
 * quieter one for pasted things (SPEC-015 D8).
 *
 * Nothing written here is a copy of record: fileArtifact copies it into the world in the same
 * breath, and the next start sweeps the lot.
 */

/**
 * A clipboard image is a few megabytes; a film is not pasted, it is dropped, and a dropped file
 * arrives as a path and never comes through here. So this cap is a guard against a mistake,
 * not a policy about size — the real size rule is LARGE_FILE_BYTES, applied at filing.
 */
export const SPOOL_LIMIT_BYTES = 128 * 1024 * 1024;

export function spoolDir(root: string): string {
  return join(root, ".spool");
}

/**
 * A name safe to write, from whatever the clipboard offered. Directory parts are dropped so a
 * name can never steer where the file lands, anything exotic becomes a dash, and a name with no
 * extension gets .bin — kindForFile reads the extension, and a silent "" would file a
 * screenshot as "other".
 */
export function spoolName(raw: string): string {
  const base = basename(raw.replace(/\\/g, "/")).trim();
  const cleaned = base
    .replace(/[^\w.-]+/g, "-")
    .replace(/^[-.]+/, "")
    .slice(0, 80);
  if (!cleaned) return "pasted.bin";
  return extname(cleaned) ? cleaned : `${cleaned}.bin`;
}

/**
 * Write the bytes where filing can reach them. The random directory — rather than a random
 * prefix on the name — is deliberate: the artifact keeps the name the user recognises (D7).
 */
export async function spoolBytes(
  root: string,
  name: string,
  bytes: Uint8Array,
): Promise<{ path: string } | { reason: string }> {
  if (bytes.byteLength === 0) return { reason: "there was nothing in it" };
  if (bytes.byteLength > SPOOL_LIMIT_BYTES) {
    const mb = Math.round(bytes.byteLength / (1024 * 1024));
    return { reason: `${mb} MB is too much to paste — attach it with the + button instead` };
  }
  const dir = join(spoolDir(root), randomUUID());
  await mkdir(dir, { recursive: true });
  const path = join(dir, spoolName(name));
  await writeFile(path, bytes);
  return { path };
}

/** Clear the couriers. Called at start, when nothing can still be waiting to be filed. */
export async function sweepSpool(root: string): Promise<void> {
  await rm(spoolDir(root), { recursive: true, force: true }).catch(() => {});
}
