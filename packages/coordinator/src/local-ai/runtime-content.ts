import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { verifiedFileContent, type FileContentEvidence } from "../harness/executable-content.js";

export interface RuntimeContentPin { readonly version: string; readonly arch: string; readonly archiveSha256: string; readonly files: readonly { readonly path: string; readonly bytes: number; readonly sha256: string }[] }
/** Fixed release files only. No models, arbitrary inventory, extraction or filesystem mutation. */
export class RuntimeContentVerifier {
  private readonly files: RuntimeContentPin["files"];
  private readonly allowed = new Set<string>();
  private proofs: FileContentEvidence[] = [];
  private working = false;
  constructor(private readonly root: string, pin: RuntimeContentPin) {
    if (!pin.files.length || pin.files.length > 1024 || !/^[a-f0-9]{64}$/.test(pin.archiveSha256)) throw Error("Invalid runtime content pin");
    this.files = Object.freeze(pin.files.map(file => Object.freeze({ ...file }))); let total = 0;
    for (const file of this.files) {
      if (file.path.length > 512 || !/^[a-zA-Z0-9_.+-]+(?:\/[a-zA-Z0-9_.+-]+)*$/.test(file.path) || file.path.split("/").some(part => part === "." || part === "..") || this.allowed.has(file.path) ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 1024 ** 3 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw Error("Invalid runtime file pin");
      this.allowed.add(file.path); total += file.bytes;
      const parts = file.path.split("/"); for (let i = 1; i < parts.length; i++) this.allowed.add(parts.slice(0, i).join("/") + "/");
    }
    if (total > 4 * 1024 ** 3 || this.allowed.size > 2048) throw Error("Runtime content pin exceeds its supported bound");
  }
  private async treeMatches(signal: AbortSignal, current: () => boolean): Promise<boolean> {
    const pending = [""], seen = new Set<string>(); let count = 0;
    while (pending.length) {
      const directory = pending.shift()!;
      for await (const entry of await opendir(join(this.root, directory), { bufferSize: 16 })) {
        if (++count > 2048 || signal.aborted || !current() || entry.isSymbolicLink()) return false;
        const relative = directory + entry.name;
        if (!directory && relative === ".arke-runtime.json" && entry.isFile() && (await lstat(join(this.root, relative))).size <= 4096) continue;
        const key = relative + (entry.isDirectory() ? "/" : "");
        if (!this.allowed.has(key) || !entry.isDirectory() && !entry.isFile()) return false;
        seen.add(key); if (entry.isDirectory()) pending.push(key);
      }
    }
    return seen.size === this.allowed.size && !signal.aborted && current();
  }
  async verify(signal: AbortSignal, current: () => boolean): Promise<boolean> {
    if (this.working || signal.aborted) return false;
    this.working = true;
    try {
      if (!current()) return false;
      if (!await this.treeMatches(signal, current)) return false;
      if (this.proofs.length === this.files.length) {
        let valid = true; for (const proof of this.proofs) if (!await proof.current(signal) || !current()) { valid = false; break; }
        if (valid && !signal.aborted && current()) return await this.treeMatches(signal, current);
      }
      this.proofs = []; const next: FileContentEvidence[] = [];
      for (const file of this.files) {
        const proof = await verifiedFileContent(join(this.root, ...file.path.split("/")), file, signal, current, 1024 ** 3);
        if (!proof || signal.aborted || !current()) return false;
        next.push(proof);
      }
      // An earlier file can change while a later file is hashing.
      for (const proof of next) if (!await proof.current(signal) || !current()) return false;
      if (signal.aborted || !current() || !await this.treeMatches(signal, current)) return false;
      this.proofs = next; return true;
    } catch { return false; }
    finally { this.working = false; }
  }
}
