import type { SetupProcessRunner } from "./process.js";

/** Numeric-owner verbose listings from the supported GNU/BSD tar ports. Only size prefixes
 * are consumed; member names never leave this reader or enter diagnostic history. Any other
 * shape is unknown, not an empty archive. Bound bytes, entries, individual lines and duration. */
export class SetupArchiveManifest {
  private pending = "";
  private bytes = 0;
  private entries = 0;
  feed(text: string): void {
    this.pending += text;
    let end: number;
    while ((end = this.pending.indexOf("\n")) >= 0) {
      this.line(this.pending.slice(0, end).replace(/\r$/, "")); this.pending = this.pending.slice(end + 1);
    }
    if (Buffer.byteLength(this.pending) > 64 * 1024) throw new Error("Archive metadata exceeds its supported bound.");
  }
  private line(line: string): void {
    if (!line.trim()) return;
    if (++this.entries > 200_000 || Buffer.byteLength(line) > 64 * 1024) throw new Error("Archive metadata exceeds its supported bound.");
    const gnu = /^[dlh-][rwxstST-]{9}[.+@]?\s+\d+\/\d+\s+(\d+)\s+/.exec(line);
    const bsd = /^[dlh-][rwxstST-]{9}[.+@]?\s+\d+\s+\d+\s+\d+\s+(\d+)\s+/.exec(line);
    const value = gnu?.[1] ?? bsd?.[1];
    if (value === undefined) throw new Error("Archive expansion metadata is unavailable.");
    const size = Number(value);
    // The estimate includes per-entry directory/inode/allocation allowance. It remains
    // planning, not OS allocation; the shared operational reserve is retained separately.
    if (!Number.isSafeInteger(size) || !Number.isSafeInteger(this.bytes + size + 8192)) throw new Error("Archive expansion metadata is unavailable.");
    this.bytes += size + 8192;
  }
  finish(): number { if (this.pending) this.line(this.pending); this.pending = ""; return this.bytes; }
}

export async function inspectSetupArchive(processes: SetupProcessRunner, tar: string, archive: string, signal: AbortSignal): Promise<number> {
  const parsing = new AbortController(), manifest = new SetupArchiveManifest(); let failed = false;
  const combined = AbortSignal.any([signal, parsing.signal, AbortSignal.timeout(60_000)]);
  const result = await processes.run(tar, ["-tvf", archive, "--numeric-owner"], combined, text => {
    if (failed) return;
    try { manifest.feed(text); } catch { failed = true; parsing.abort(); }
  }, "metadata");
  if (failed || result.code !== 0) throw new Error("Archive expansion metadata is unavailable.");
  return manifest.finish();
}
