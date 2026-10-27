import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const unchanged = (left: BigIntStats, right: BigIntStats) => left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
  left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
const canonical = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);

/** Host-only byte qualification, not a loader-image or adversarial filesystem fence.
 * Pending native reads retain this original task/descriptor until they actually settle. */
export interface FileContentEvidence { current(signal: AbortSignal): Promise<boolean> }
export async function verifiedFileContent(path: string, pin: { readonly bytes: number; readonly sha256: string }, signal: AbortSignal, current: () => boolean,
  maxBytes = 512 * 1024 ** 2): Promise<FileContentEvidence | null> {
  const { bytes: expectedBytes, sha256 } = pin;
  const valid = () => { signal.throwIfAborted(); const value = current(); signal.throwIfAborted(); return value; };
  if (!isAbsolute(path) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 ** 3 || !Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > maxBytes || !/^[a-f0-9]{64}$/.test(sha256)) return null;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!valid()) return null;
    const selected = await lstat(path, { bigint: true });
    if (!selected.isFile() || selected.isSymbolicLink() || selected.size !== BigInt(expectedBytes) || canonical(await realpath(path)) !== canonical(path) || !valid()) return null;
    file = await open(path, "r");
    const before = await file.stat({ bigint: true }); if (!unchanged(selected, before) || !valid()) return null;
    const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024); let bytes = 0;
    while (valid()) {
      const read = await file.read(buffer, 0, Math.min(buffer.length, expectedBytes + 1 - bytes), null);
      if (!valid()) return null;
      if (!read.bytesRead) break;
      bytes += read.bytesRead; if (bytes > expectedBytes) return null;
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    if (!valid() || bytes !== expectedBytes || hash.digest("hex") !== sha256) return null;
    const after = await file.stat({ bigint: true }), destination = await lstat(path, { bigint: true });
    if (!valid() || !destination.isFile() || destination.isSymbolicLink() || !unchanged(before, after) || !unchanged(after, destination) || canonical(await realpath(path)) !== canonical(path) || !valid()) return null;
    return Object.freeze({ current: async (nextSignal: AbortSignal) => {
      try {
        nextSignal.throwIfAborted(); const info = await lstat(path, { bigint: true });
        return !nextSignal.aborted && info.isFile() && !info.isSymbolicLink() && unchanged(after, info) && canonical(await realpath(path)) === canonical(path) && !nextSignal.aborted;
      } catch { return false; }
    } });
  } catch { return null; }
  finally { await file?.close(); }
}
export async function executableContentMatches(path: string, pin: { readonly bytes: number; readonly sha256: string }, signal: AbortSignal, current: () => boolean): Promise<boolean> {
  return await verifiedFileContent(path, pin, signal, current) !== null;
}
