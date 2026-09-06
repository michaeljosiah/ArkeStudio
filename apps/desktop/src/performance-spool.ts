import { randomUUID } from "node:crypto";
import { mkdir, lstat, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const LIMIT = 128 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Process-owned opaque claims: neither renderer paths nor a prior process's ids are accepted. */
export function createPerformanceSpool(appRoot: string) {
  const spoolDir = resolve(appRoot, ".spool");
  const root = resolve(spoolDir, "performance");
  const entries = new Map<string, { absolutePath: string; contentType: string; sizeBytes: number; claimed: boolean }>();
  const remove = async (id: string) => {
    if (!UUID.test(id)) return;
    const target = resolve(root, id), rel = relative(root, target);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Unsafe spool path.");
    const info = await lstat(target).catch(() => null);
    if (info?.isSymbolicLink() || (info && !info.isDirectory())) throw new Error("Unsafe spool entry.");
    if (info) await rm(target, { recursive: true, force: true });
  };
  const ready = (async () => {
    await mkdir(root, { recursive: true });
    /*
     * Neither directory the spool makes may lead somewhere else.
     *
     * This compared `realpath(root)` against the string `root` was built from, which refuses
     * every app root the filesystem spells back differently than the caller spelled it — a
     * Windows temp directory reached through its 8.3 alias, a profile behind folder
     * redirection — and the spool then declined recordings that were in exactly the right
     * place. What has to be refused is a spool directory that redirects writes out of the app
     * root, so that is asked of the two directories this creates rather than of a string
     * equality the filesystem never promised.
     */
    for (const dir of [spoolDir, root]) {
      if ((await lstat(dir)).isSymbolicLink()) throw new Error("Unsafe performance spool.");
    }
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory() && UUID.test(entry.name)) await remove(entry.name);
    }
  })();
  // Startup failure is reported by the first bridge request without an unhandled rejection.
  void ready.catch(() => {});
  return {
    async stage(input: { name?: unknown; contentType?: unknown; bytes?: unknown }): Promise<{ ok: true; spoolId: string } | { ok: false; reason: string }> {
      try {
        await ready;
        const bytes = input.bytes instanceof Uint8Array ? input.bytes : input.bytes instanceof ArrayBuffer ? new Uint8Array(input.bytes) : null;
        const mime = typeof input.contentType === "string" ? input.contentType.toLowerCase() : "";
        if (!bytes?.byteLength) return { ok: false, reason: "The recording contains no audio bytes." };
        if (bytes.byteLength > LIMIT) return { ok: false, reason: "The recording exceeds the 128 MiB capture limit." };
        if (!["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].includes(mime)) return { ok: false, reason: "This recorder format is unsupported." };
        const spoolId = randomUUID(), absolutePath = join(root, spoolId, mime === "audio/mp4" ? "recording.m4a" : "recording.webm");
        await mkdir(join(root, spoolId));
        await writeFile(absolutePath, bytes, { flag: "wx" });
        entries.set(spoolId, { absolutePath, contentType: mime, sizeBytes: bytes.byteLength, claimed: false });
        return { ok: true, spoolId };
      } catch { return { ok: false, reason: "The desktop could not stage this recording." }; }
    },
    async claim(spoolId: string) {
      await ready;
      const entry = entries.get(spoolId);
      if (!entry || entry.claimed) return null;
      entry.claimed = true;
      const { claimed: _claimed, ...source } = entry;
      return source;
    },
    async discard(spoolId: string) {
      await ready;
      if (!entries.has(spoolId)) return;
      await remove(spoolId); entries.delete(spoolId);
    },
  };
}
