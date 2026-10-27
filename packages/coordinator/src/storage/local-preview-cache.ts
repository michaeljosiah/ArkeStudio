import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, opendir, realpath, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { AppStorageService } from "./service.js";
import type { ResolvedMediaFile } from "../transport.js";
import { atomicWriteFile, serializeFileMutation } from "../world/atomic.js";

const MAX_AUDIO = 12 * 1024 * 1024;
const MAX_INDEX = 256 * 1024;
const MAX_ENTRIES = 512;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const receiptSchema = z.object({ key: hashSchema, kind: z.literal("local-catalogue-preset-v1"),
  rootIdentity: hashSchema, fileIdentity: hashSchema, contentHash: hashSchema,
  bytes: z.number().int().positive().max(MAX_AUDIO), modifiedNs: z.string().regex(/^\d+$/),
  createdAt: z.number().int().nonnegative().safe() }).strict();
type Receipt = z.infer<typeof receiptSchema>;
const indexSchema = z.object({ version: z.literal(1), rootIdentity: hashSchema,
  entries: z.array(receiptSchema).max(MAX_ENTRIES) }).strict().refine(index => new Set(index.entries.map(row => row.key)).size === index.entries.length);
type Index = z.infer<typeof indexSchema>;
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const unavailable = () => new Error("The local preview cache needs attention. No existing files were removed.");
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
class UnknownClose extends Error { constructor(readonly file: FileHandle) { super(); } }
class PreviewSpaceHeld extends Error {
  constructor() { super("This preview is waiting for disk space or storage accounting. Check Diagnostics."); }
}
async function close(handle: FileHandle): Promise<void> {
  try { await handle.close(); } catch { throw new UnknownClose(handle); }
}
async function boundedRead(handle: FileHandle, limit: number): Promise<Buffer> {
  const buffer = Buffer.alloc(limit + 1);
  let size = 0;
  while (size < buffer.length) {
    const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
    if (!bytesRead) break;
    size += bytesRead;
  }
  if (size > limit) throw unavailable();
  return buffer.subarray(0, size);
}

// Shared across service instances: an old response can still own its reader after a refresh.
// These are in-process holds, not cross-process proof or authority to unlink a pathname.
const leases = new Map<string, { readers: number; writer: boolean }>();
// Unknown owners keep their exact handles and release/settlement capabilities. Neither a new
// service instance nor an inventory refresh can turn that uncertainty into released capacity.
const retainedOwners = new Set<{ path: string; file?: FileHandle; release(): void; settle?: () => Promise<boolean> }>();
let writers = 0, readers = 0;
function lease(path: string, write: boolean): (() => void) | null {
  const key = process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  const current = leases.get(key);
  if (current?.writer || (write && current) || (write ? writers >= 8 : readers >= 256)) return null;
  const state = current ?? { readers: 0, writer: false };
  if (write) { state.writer = true; writers++; } else { state.readers++; readers++; }
  leases.set(key, state);
  let released = false;
  return () => {
    if (released) return; released = true;
    if (write) { state.writer = false; writers--; } else { state.readers--; readers--; }
    if (!state.writer && state.readers === 0) leases.delete(key);
  };
}

/** Producer receipts for the fixed, free local-preset audition line only (SPEC-062 R-16).
 * Paid/ledgered previews, cloned recordings and legacy files never enter this directory.
 * Node identity observations and these receipts do not qualify native deletion. */
export class LocalPreviewCache {
  private readonly root: string;
  private readonly indexPath: string;
  private closed = false;
  constructor(parent: string, private readonly storage?: AppStorageService) {
    this.root = join(parent, "local-presets-v1");
    this.indexPath = join(this.root, "receipts.json");
  }
  close(): void { this.closed = true; }
  private path(key: string): string { hashSchema.parse(key); return join(this.root, `${key}.wav`); }
  private async rootIdentity(create = false): Promise<string> {
    if (create) await mkdir(this.root, { recursive: true });
    const info = await lstat(this.root, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || info.ino === 0n) throw unavailable();
    const canonical = await realpath(this.root);
    return digest(JSON.stringify([process.platform === "win32" ? canonical.toLowerCase() : canonical,
      String(info.dev), String(info.ino), String(info.birthtimeNs)]));
  }
  private async identity(path: string): Promise<{ identity: string; bytes: number; modifiedNs: string }> {
    const info = await lstat(path, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.ino === 0n || info.size > BigInt(MAX_AUDIO)) throw unavailable();
    return { identity: digest(JSON.stringify([String(info.dev), String(info.ino), String(info.birthtimeNs)])),
      bytes: Number(info.size), modifiedNs: String(info.mtimeNs) };
  }
  private async index(rootIdentity: string): Promise<Index> {
    let handle: FileHandle;
    try { handle = await open(this.indexPath, "r"); } catch (error) {
      if (missing(error)) return { version: 1, rootIdentity, entries: [] };
      throw error;
    }
    try {
      const info = await handle.stat();
      const leaf = await lstat(this.indexPath);
      if (!info.isFile() || !leaf.isFile() || leaf.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_INDEX ||
        info.dev !== leaf.dev || info.ino !== leaf.ino) throw unavailable();
      const index = indexSchema.parse(JSON.parse((await boundedRead(handle, MAX_INDEX)).toString("utf8")));
      if (index.rootIdentity !== rootIdentity || index.entries.some(row => row.rootIdentity !== rootIdentity)) throw unavailable();
      return index;
    } finally { await close(handle); }
  }
  private async recorded(key: string, rootIdentity: string): Promise<Receipt | undefined> {
    return (await this.index(rootIdentity)).entries.find(row => row.key === key);
  }
  private async roomForOutput(): Promise<void> {
    let count = 0;
    // Unknown/orphan files remain protected, but cannot accumulate without bounding new work.
    // Count directory entries only; no media reads, adoption or deletion follows from a name.
    for await (const _entry of await opendir(this.root)) {
      if (++count >= 1024) throw unavailable();
    }
  }
  private async verify(receipt: Receipt): Promise<boolean> {
    const current = await this.identity(this.path(receipt.key));
    return current.identity === receipt.fileIdentity && current.bytes === receipt.bytes && current.modifiedNs === receipt.modifiedNs;
  }
  private async bytes(receipt: Receipt): Promise<Buffer> {
    if (!await this.verify(receipt)) throw unavailable();
    const handle = await open(this.path(receipt.key), "r");
    try {
      const info = await handle.stat({ bigint: true });
      if (info.size !== BigInt(receipt.bytes) || info.nlink !== 1n || String(info.mtimeNs) !== receipt.modifiedNs ||
        digest(JSON.stringify([String(info.dev), String(info.ino), String(info.birthtimeNs)])) !== receipt.fileIdentity) throw unavailable();
      const bytes = await boundedRead(handle, receipt.bytes);
      if (bytes.length !== receipt.bytes || digest(bytes) !== receipt.contentHash || !await this.verify(receipt)) throw unavailable();
      return bytes;
    } finally { await close(handle); }
  }
  async read(key: string): Promise<Buffer | null> {
    if (this.closed) return null;
    const release = lease(this.path(key), false); if (!release) throw unavailable();
    let unknownClose = false;
    try {
      const root = await this.rootIdentity();
      const receipt = await this.recorded(key, root);
      if (!receipt) return null;
      const bytes = await this.bytes(receipt);
      if (await this.rootIdentity() !== root) throw unavailable();
      return bytes;
    } catch (error) {
      unknownClose = error instanceof UnknownClose;
      if (error instanceof UnknownClose) retainedOwners.add({ path: this.path(key), file: error.file, release });
      if (missing(error)) return null; throw unavailable();
    }
    finally { if (!unknownClose) release(); }
  }
  async generate(key: string, produce: () => Promise<Uint8Array>, signal: AbortSignal): Promise<void> {
    if (this.closed || signal.aborted) throw unavailable();
    const path = this.path(key), release = lease(path, true); if (!release) throw unavailable();
    let handle: FileHandle | undefined, unknownClose = false;
    let failedHandle: FileHandle | undefined;
    let rootHold: ReturnType<AppStorageService["acquireRoot"]> | undefined, stopWriting: (() => void) | undefined;
    let reservationId: string | undefined, remaining = MAX_AUDIO + MAX_INDEX;
    const owner = { kind: "preview" as const, id: key };
    try {
      const rootIdentity = await this.rootIdentity(true);
      const index = await this.index(rootIdentity);
      const prior = index.entries.find(row => row.key === key);
      if (prior && await this.verify(prior)) { await this.bytes(prior); return; }
      if (!prior && index.entries.length >= MAX_ENTRIES) throw unavailable();
      // A miss is never permission to overwrite an unrecorded/corrupt file or adopt it by name.
      try { await lstat(path); throw unavailable(); } catch (error) { if (!missing(error)) throw error; }
      await this.roomForOutput();
      if (signal.aborted || this.closed) throw unavailable();
      if (this.storage?.supportsAdmission) {
        rootHold = this.storage.acquireRoot(this.root, "working-files");
        await this.storage.start();
        reservationId = randomUUID();
        const result = await this.storage.reservations.reserve({ id: reservationId, owner,
          demands: [{ rootId: rootHold.rootId, remainingBytes: remaining }] }, signal);
        if (result.status !== "reserved") throw new PreviewSpaceHeld();
        stopWriting = this.storage.beginWrite();
      }
      const bytes = await produce();
      if (signal.aborted || this.closed || !bytes.byteLength || bytes.byteLength > MAX_AUDIO || await this.rootIdentity() !== rootIdentity) throw unavailable();
      if (reservationId && rootHold) {
        const actual = bytes.byteLength + MAX_INDEX;
        const result = await this.storage!.reservations.replan({ id: reservationId, owner,
          demands: [{ rootId: rootHold.rootId, remainingBytes: actual }] }, signal);
        if (result.status !== "reserved") throw new PreviewSpaceHeld();
        remaining = actual;
      }
      if (signal.aborted || this.closed || await this.rootIdentity() !== rootIdentity) throw unavailable();
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(bytes); await handle.sync();
      const written = await handle.stat({ bigint: true });
      try { await close(handle); handle = undefined; } catch (error) { unknownClose = true; throw error; }
      if (reservationId && rootHold) {
        remaining -= bytes.byteLength;
        if (!await this.storage!.reservations.reduce(reservationId, owner, { [rootHold.rootId]: remaining })) throw unavailable();
      }
      const current = await this.identity(path);
      const fileIdentity = digest(JSON.stringify([String(written.dev), String(written.ino), String(written.birthtimeNs)]));
      if (written.nlink !== 1n || current.identity !== fileIdentity || current.bytes !== bytes.byteLength ||
        current.modifiedNs !== String(written.mtimeNs) || await this.rootIdentity() !== rootIdentity) throw unavailable();
      const receipt = receiptSchema.parse({ key, kind: "local-catalogue-preset-v1", rootIdentity, fileIdentity,
        contentHash: digest(bytes), bytes: bytes.byteLength, modifiedNs: current.modifiedNs, createdAt: Date.now() });
      await serializeFileMutation(this.indexPath, async () => {
        if (await this.rootIdentity() !== rootIdentity) throw unavailable();
        const latest = await this.index(rootIdentity);
        const entries = latest.entries.filter(row => row.key !== key);
        if (entries.length >= MAX_ENTRIES) throw unavailable();
        entries.push(receipt);
        const json = JSON.stringify(indexSchema.parse({ ...latest, entries })) + "\n";
        if (Buffer.byteLength(json) > MAX_INDEX) throw unavailable();
        await atomicWriteFile(this.indexPath, json, { stage: async path => {
          const file = await open(path, "wx");
          return { writeFile: file.writeFile.bind(file), sync: file.sync.bind(file), close: () => close(file) };
        } });
        if (reservationId && rootHold) {
          remaining -= Buffer.byteLength(json);
          if (!await this.storage!.reservations.reduce(reservationId, owner, { [rootHold.rootId]: remaining })) throw unavailable();
        }
      });
    } catch (error) {
      unknownClose ||= error instanceof UnknownClose;
      if (error instanceof UnknownClose) failedHandle = error.file;
      if (rootHold) this.storage!.writeFailed(rootHold.rootId);
      throw error instanceof PreviewSpaceHeld ? error : unavailable();
    }
    finally {
      if (handle && !unknownClose) try { await handle.close(); } catch { unknownClose = true; }
      if (!unknownClose && reservationId) {
        let settled = false;
        try { settled = await this.storage!.reservations.settle(reservationId, owner); } catch { unknownClose = true; }
        // A refused admission may have saved no intent. Any retained intent needs settlement.
        if (!settled && this.storage!.reservations.snapshot().records.some(row => row.id === reservationId)) unknownClose = true;
      }
      if (!unknownClose) { stopWriting?.(); rootHold?.release(); }
      if (!unknownClose) release();
      else retainedOwners.add({ path, file: failedHandle ?? handle,
        release: () => { stopWriting?.(); rootHold?.release(); release(); },
        ...(reservationId ? { settle: () => this.storage!.reservations.settle(reservationId!, owner) } : {}) });
    }
    if (unknownClose) throw unavailable();
  }
  async serve(key: string): Promise<ResolvedMediaFile | null> {
    if (this.closed) return null;
    let path: string;
    try { path = this.path(key); } catch { return null; }
    const release = lease(path, false); if (!release) return null;
    try {
      const root = await this.rootIdentity(), receipt = await this.recorded(key, root);
      if (!receipt) { release(); return null; }
      await this.bytes(receipt);
      if (await this.rootIdentity() !== root || this.closed) throw unavailable();
      return { path, contentType: "audio/wav", release };
    } catch (error) {
      if (error instanceof UnknownClose) retainedOwners.add({ path, file: error.file, release }); else release();
      return null;
    }
  }
  /** Metadata only: recorded bytes are not a claim of reclaimable allocation or cleanup authority. */
  async inventory(): Promise<{ state: "recorded" | "unavailable"; scope: "producer-receipts"; complete: false; entries: Array<{
    resourceKey: string; recordedBytes: number; allocatedBytes: null; createdAt: number; leased: boolean;
  }> }> {
    if (this.closed) return { state: "unavailable", scope: "producer-receipts", complete: false, entries: [] };
    const release = lease(this.indexPath, false);
    if (!release) return { state: "unavailable", scope: "producer-receipts", complete: false, entries: [] };
    let unknownClose = false;
    try {
      const root = await this.rootIdentity(), index = await this.index(root);
      if (await this.rootIdentity() !== root) throw unavailable();
      return { state: "recorded", scope: "producer-receipts", complete: false, entries: index.entries.map(row => {
        const path = this.path(row.key), key = process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
        return { resourceKey: row.key, recordedBytes: row.bytes, allocatedBytes: null, createdAt: row.createdAt, leased: leases.has(key) };
      }) };
    } catch (error) {
      unknownClose = error instanceof UnknownClose;
      if (error instanceof UnknownClose) retainedOwners.add({ path: this.indexPath, file: error.file, release });
      return { state: "unavailable", scope: "producer-receipts", complete: false, entries: [] };
    } finally { if (!unknownClose) release(); }
  }
}
