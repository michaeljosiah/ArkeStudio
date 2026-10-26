import { createHash } from "node:crypto";
import { lstat, open, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { z } from "zod";
import { SpeechUsageSchema, type Job, type SpeechUsage } from "@arke-studio/contracts";
import { atomicWriteFile } from "../world/atomic.js";
import { toExtendedLength } from "../world/paths.js";
import type { ArtifactWriteSpace } from "../storage/job-artifacts.js";
import type { DispatchArtifact } from "./dispatcher.js";

export const ARTIFACT_FILE_OVERHEAD = 64 * 1024;
const MAX_FILE = 1024 ** 3, MAX_TOTAL = 4 * 1024 ** 3, MAX_MANIFEST = 128 * 1024;
async function hash(data: Uint8Array, signal?: AbortSignal): Promise<string> {
  const digest = createHash("sha256");
  for (let offset = 0; offset < data.length; offset += 1024 * 1024) {
    signal?.throwIfAborted(); digest.update(data.subarray(offset, offset + 1024 * 1024));
    if (offset > 0 && offset % (8 * 1024 * 1024) === 0) await yieldTurn(undefined, { signal });
  }
  signal?.throwIfAborted(); return digest.digest("hex");
}
const entry = z.object({ name: z.string().max(1024), contentType: z.string().max(256),
  bytes: z.number().int().nonnegative().max(MAX_FILE), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const receiptSchema = z.object({ version: z.literal(2), jobId: z.string(), receiptId: z.string().regex(/^[A-Z0-9]{26}$/), attempt: z.number().int().nonnegative(),
  provider: z.string().max(256), remoteId: z.string().max(4096), resultKind: z.enum(["inline", "remote"]),
  providerCostMicroUsd: z.number().int().nonnegative().safe().optional(), speechUsage: SpeechUsageSchema.optional(), artifacts: z.array(entry).max(64) }).strict();
type Receipt = z.infer<typeof receiptSchema>;
type Identity = Pick<Job, "id" | "attempt" | "provider" | "providerJobId" | "resultReceiptId" | "providerResultKind" | "providerCostMicroUsd" | "speechUsage">;
export interface SavedArtifactResult { remoteId: string; artifacts: DispatchArtifact[]; resultKind?: "inline" | "remote"; providerCostMicroUsd?: number; speechUsage?: SpeechUsage }
export class ArtifactCheckpointInvalid extends Error {
  constructor(reason: "invalid" | "limit" = "invalid") { super(reason === "limit"
    ? "The completed result exceeds the current local receipt limits. Review its provider result before closing Arke; no generation was repeated."
    : "The saved result checkpoint could not be verified. Keep its files and review before retrying; no generation was repeated."); this.name = "ArtifactCheckpointInvalid"; }
}
const missing = (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";

/** Read only a declared extent, even if an external writer grows the file. */
async function readBounded(path: string, maximum: number, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted(); const before = await lstat(toExtendedLength(path));
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) throw new ArtifactCheckpointInvalid();
  const handle = await open(toExtendedLength(path), "r");
  try {
    const start = await handle.stat();
    if (!start.isFile() || start.size !== before.size || start.dev !== before.dev || start.ino !== before.ino) throw new ArtifactCheckpointInvalid();
    const data = Buffer.alloc(start.size); let offset = 0;
    while (offset < data.length) {
      signal?.throwIfAborted(); const next = await handle.read(data, offset, Math.min(1024 * 1024, data.length - offset), offset);
      if (!next.bytesRead) throw new ArtifactCheckpointInvalid(); offset += next.bytesRead;
    }
    const end = await handle.stat();
    if (end.size !== start.size || end.mtimeMs !== start.mtimeMs || end.ctimeMs !== start.ctimeMs) throw new ArtifactCheckpointInvalid();
    return data;
  } finally { await handle.close(); }
}

export async function artifactFileMatches(path: string, expected: Uint8Array, signal: AbortSignal): Promise<boolean> {
  try { const data = await readBounded(path, expected.length, signal); return data.length === expected.length && await hash(data, signal) === await hash(expected, signal); }
  catch (error) { if (missing(error)) return false; throw error; }
}

/** Private, finite completed-result receipts. They are not expendable caches while unfiled.
 * Hash-named blobs and attempt directories never overwrite a prior attempt's valid result. */
export class ArtifactResultFiles {
  private readonly root: string;
  constructor(journalPath: string, private readonly space?: ArtifactWriteSpace,
    private readonly write: typeof atomicWriteFile = atomicWriteFile) { this.root = join(dirname(journalPath), "inline-artifacts"); }
  directory(job: Identity): string {
    if (!job.resultReceiptId) throw new ArtifactCheckpointInvalid();
    return join(this.root, job.id, `result-${job.resultReceiptId}`);
  }
  private blob(directory: string, index: number, digest: string): string { return join(directory, `${index}-${digest}.bin`); }

  async save(job: Identity, artifacts: readonly DispatchArtifact[], signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (artifacts.length > 64 || artifacts.some(value => value.data.length > MAX_FILE) || artifacts.reduce((sum, value) => sum + value.data.length, 0) > MAX_TOTAL) throw new ArtifactCheckpointInvalid("limit");
    const entries = [];
    for (const value of artifacts) entries.push({ name: value.name, contentType: value.contentType, bytes: value.data.length, digest: await hash(value.data, signal) });
    const parsed = receiptSchema.safeParse({ version: 2, jobId: job.id, receiptId: job.resultReceiptId, attempt: job.attempt, provider: job.provider,
      remoteId: job.providerJobId, resultKind: job.providerResultKind ?? "remote", providerCostMicroUsd: job.providerCostMicroUsd, speechUsage: job.speechUsage,
      artifacts: entries });
    if (!parsed.success) throw new ArtifactCheckpointInvalid("limit");
    const receipt = parsed.data;
    const text = JSON.stringify(receipt);
    if (Buffer.byteLength(text) > MAX_MANIFEST) throw new ArtifactCheckpointInvalid("limit");
    const directory = this.directory(job), existing = await this.readReceipt(directory, signal).catch(error => { if (missing(error)) return null; throw error; });
    if (existing && JSON.stringify(existing) !== text) throw new ArtifactCheckpointInvalid();
    const todo: number[] = [];
    for (const [index, value] of receipt.artifacts.entries()) {
      try {
        const data = await readBounded(this.blob(directory, index, value.digest), value.bytes, signal);
        if (data.length !== value.bytes || await hash(data, signal) !== value.digest) throw new ArtifactCheckpointInvalid();
      } catch (error) { if (missing(error)) todo.push(index); else throw error; }
    }
    if (existing && !todo.length) return;
    const remainingBytes = todo.reduce((sum, index) => sum + artifacts[index]!.data.length + ARTIFACT_FILE_OVERHEAD, 0) + Buffer.byteLength(text) + ARTIFACT_FILE_OVERHEAD;
    const lease = await this.space?.reserve(job.id, [{ directory, remainingBytes, role: "working-files" }], signal);
    try {
      for (const index of todo) {
        signal.throwIfAborted(); const value = receipt.artifacts[index]!;
        await this.write(this.blob(directory, index, value.digest), artifacts[index]!.data);
        await lease?.consumed(directory, value.bytes + ARTIFACT_FILE_OVERHEAD);
      }
      signal.throwIfAborted(); await this.write(join(directory, "manifest.json"), text);
      await lease?.consumed(directory, Buffer.byteLength(text) + ARTIFACT_FILE_OVERHEAD);
    } catch (error) { lease?.writeFailed(); throw error; }
    finally { await lease?.settle(); }
  }

  private async readReceipt(directory: string, signal?: AbortSignal): Promise<Receipt> {
    return receiptSchema.parse(JSON.parse((await readBounded(join(directory, "manifest.json"), MAX_MANIFEST, signal)).toString("utf8")));
  }
  async read(job: Identity, signal?: AbortSignal): Promise<SavedArtifactResult | null> {
    if (!job.resultReceiptId) return this.readLegacy(job, signal);
    const directory = this.directory(job); let receipt: Receipt;
    try { receipt = await this.readReceipt(directory, signal); }
    catch (error) { if (!missing(error)) throw new ArtifactCheckpointInvalid(); return null; }
    if (receipt.jobId !== job.id || receipt.receiptId !== job.resultReceiptId || receipt.provider !== job.provider ||
      job.providerJobId !== null && receipt.remoteId !== job.providerJobId || receipt.artifacts.reduce((sum, value) => sum + value.bytes, 0) > MAX_TOTAL) throw new ArtifactCheckpointInvalid();
    const artifacts: DispatchArtifact[] = [];
    for (const [index, value] of receipt.artifacts.entries()) {
      const data = await readBounded(this.blob(directory, index, value.digest), value.bytes, signal);
      if (data.length !== value.bytes || await hash(data, signal) !== value.digest) throw new ArtifactCheckpointInvalid();
      artifacts.push({ name: value.name, contentType: value.contentType, data });
    }
    return { remoteId: receipt.remoteId, artifacts, resultKind: receipt.resultKind,
      ...(receipt.providerCostMicroUsd !== undefined ? { providerCostMicroUsd: receipt.providerCostMicroUsd } : {}), ...(receipt.speechUsage ? { speechUsage: receipt.speechUsage } : {}) };
  }
  private async readLegacy(job: Identity, signal?: AbortSignal): Promise<{ remoteId: string; artifacts: DispatchArtifact[] } | null> {
    // Legacy receipts contain no attempt/digest. Only an exact durable accepted ID may adopt
    // one; malformed/missing receipts never authorize deleting their possibly valid blobs.
    const directory = join(this.root, job.id); let raw;
    try { raw = JSON.parse((await readBounded(join(directory, "manifest.json"), MAX_MANIFEST, signal)).toString("utf8")); }
    catch (error) { if (missing(error)) return null; throw new ArtifactCheckpointInvalid(); }
    const parsed = z.object({ remoteId: z.string().max(4096), artifacts: z.array(z.object({ name: z.string().max(1024), contentType: z.string().max(256) }).strict()).max(64) }).strict().safeParse(raw);
    if (!parsed.success || !job.providerJobId || parsed.data.remoteId !== job.providerJobId) throw new ArtifactCheckpointInvalid();
    const artifacts: DispatchArtifact[] = []; let total = 0;
    for (const [index, value] of parsed.data.artifacts.entries()) {
      const data = await readBounded(join(directory, `${index}.bin`), Math.min(MAX_FILE, MAX_TOTAL - total), signal); total += data.length;
      artifacts.push({ ...value, data });
    }
    return { remoteId: parsed.data.remoteId, artifacts };
  }
  async removeFiled(job: Identity): Promise<void> {
    // Enumerated, verified current-attempt files only. Unknown/legacy/previous attempts remain.
    if (!job.resultReceiptId) return;
    const directory = this.directory(job); let receipt: Receipt;
    try { receipt = await this.readReceipt(directory); } catch { return; }
    if (receipt.jobId !== job.id || receipt.receiptId !== job.resultReceiptId || receipt.provider !== job.provider || receipt.remoteId !== job.providerJobId) return;
    for (const [index, value] of receipt.artifacts.entries()) await unlink(toExtendedLength(this.blob(directory, index, value.digest))).catch(() => {});
    await unlink(toExtendedLength(join(directory, "manifest.json"))).catch(() => {}); await rmdir(toExtendedLength(directory)).catch(() => {});
  }
}
