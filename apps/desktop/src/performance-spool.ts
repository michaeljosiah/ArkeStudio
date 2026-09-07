import { randomUUID } from "node:crypto";
import { mkdir, lstat, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const LIMIT = 128 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Process-owned opaque claims: neither renderer paths nor a prior process's ids are accepted. */
export function createPerformanceSpool(appRoot: string) {
  const requested = resolve(appRoot, ".spool", "performance");
  /*
   * The store's own canonical path, adopted once it is known (issue 871).
   *
   * The promise here is that nothing has substituted the store directory — not that the store
   * sits at the exact string the app composed. Those are different, and only the first is a
   * security property. Comparing `realpath` against the composed string enforced the second,
   * and refused three ordinary app roots for it: a profile whose ArkeStudio folder is junctioned
   * onto a data drive, a redirected profile, and an 8.3 short path (`RUNNER~1` on a Windows CI
   * runner, `PROGRA~1` in an ARKE_STUDIO_ROOT) — every recording refused, permanently, on that
   * installation. So the root is canonicalised and worked from; a link ON THE WAY to the store is
   * an alias and accepted, and a link AT the store is still refused, as is every entry under it.
   */
  let root = requested;
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
    await mkdir(requested, { recursive: true });
    // A setup problem the person can act on, said as one: the generic "could not stage" used to
    // cover this, and nothing told a user whose store was a link apart from a transient write.
    if ((await lstat(requested)).isSymbolicLink()) {
      throw new Error(`The recording store at ${requested} is a link. Replace it with a folder and restart.`);
    }
    root = resolve(await realpath(requested));
    if (!(await lstat(root)).isDirectory()) throw new Error(`The recording store at ${root} is not a folder.`);
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory() && UUID.test(entry.name)) await remove(entry.name);
    }
  })();
  // Startup failure is reported by the first bridge request without an unhandled rejection.
  void ready.catch(() => {});
  return {
    async stage(input: { name?: unknown; contentType?: unknown; bytes?: unknown }): Promise<{ ok: true; spoolId: string } | { ok: false; reason: string }> {
      // A store that never opened is not a recording that failed to write: the first is a setup
      // problem with a cause worth repeating, the second is transient and worth retrying.
      try { await ready; } catch (error) {
        return { ok: false, reason: `The recording store could not open. ${error instanceof Error ? error.message : String(error)}` };
      }
      try {
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
