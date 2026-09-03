import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { atomicWriteFile, toExtendedLength } from "@arke-studio/coordinator";

type FileIdentity = {
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  dev: string;
  ino: string;
};

type DigestReceipt = {
  version: 1;
  path: string;
  identity: FileIdentity;
  sha256: string;
};

type DigestFile = (path: string, signal?: AbortSignal) => Promise<string | null>;

function absolutePath(path: string): string {
  if (process.platform !== "win32") return resolve(path);
  const ordinary = path.startsWith("\\\\?\\UNC\\")
    ? `\\\\${path.slice(8)}`
    : path.startsWith("\\\\?\\")
      ? path.slice(4)
      : path;
  return resolve(ordinary);
}

function isIdentity(value: unknown): value is FileIdentity {
  if (typeof value !== "object" || value === null) return false;
  const identity = value as Record<string, unknown>;
  return ["size", "mtimeNs", "ctimeNs", "dev", "ino"].every((key) => typeof identity[key] === "string");
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

async function fileIdentity(path: string): Promise<FileIdentity | null> {
  const found = await stat(toExtendedLength(path), { bigint: true }).catch(() => null);
  if (found === null || !found.isFile()) return null;
  return {
    size: found.size.toString(),
    mtimeNs: found.mtimeNs.toString(),
    ctimeNs: found.ctimeNs.toString(),
    dev: found.dev.toString(),
    ino: found.ino.toString(),
  };
}

const streamDigest: DigestFile = (path, signal) =>
  new Promise<string | null>((resolveDigest) => {
    const hash = createHash("sha256");
    const stream = createReadStream(toExtendedLength(path));
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      resolveDigest(value);
    };
    const abort = () => {
      stream.destroy();
      finish(null);
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => finish(hash.digest("hex")));
    stream.on("error", () => finish(null));
  });

/** Persistent checkpoint digests; exact file identity makes stale receipts harmless misses. */
export class ComfyUiDigestCache {
  private readonly inFlight = new Map<string, Promise<string | null>>();

  constructor(
    private readonly appRoot: string,
    private readonly digestFile: DigestFile = streamDigest,
  ) {}

  async hashFile(path: string, signal?: AbortSignal, force = false): Promise<string | null> {
    if (signal?.aborted) return null;
    const absolute = absolutePath(path);
    const normalized = process.platform === "win32" ? absolute.toLowerCase() : absolute;
    const identity = await fileIdentity(absolute);
    if (identity === null) return null;
    const key = `${force ? "force" : "cached"}:${normalized}:${JSON.stringify(identity)}`;
    const existing = this.inFlight.get(key);
    if (existing !== undefined) return existing;
    const work = this.measure(absolute, normalized, identity, signal, force);
    this.inFlight.set(key, work);
    try {
      return await work;
    } finally {
      if (this.inFlight.get(key) === work) this.inFlight.delete(key);
    }
  }

  private receiptPath(normalized: string): string {
    const key = createHash("sha256").update(normalized).digest("hex");
    return join(this.appRoot, ".index", "comfyui-digests", `${key}.json`);
  }

  private async readReceipt(normalized: string, identity: FileIdentity): Promise<string | null> {
    const raw = await readFile(toExtendedLength(this.receiptPath(normalized)), "utf8").catch(() => null);
    if (raw === null) return null;
    try {
      const receipt = JSON.parse(raw) as Partial<DigestReceipt>;
      if (
        receipt.version !== 1 ||
        receipt.path !== normalized ||
        !isIdentity(receipt.identity) ||
        !sameIdentity(receipt.identity, identity) ||
        typeof receipt.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(receipt.sha256)
      ) {
        return null;
      }
      return receipt.sha256;
    } catch {
      return null;
    }
  }

  private async measure(
    path: string,
    normalized: string,
    identity: FileIdentity,
    signal: AbortSignal | undefined,
    force: boolean,
  ): Promise<string | null> {
    if (!force) {
      const cached = await this.readReceipt(normalized, identity);
      if (cached !== null) {
        const after = await fileIdentity(path);
        return after !== null && sameIdentity(identity, after) ? cached : null;
      }
    }
    const sha256 = await this.digestFile(path, signal);
    if (sha256 === null || signal?.aborted) return null;
    const after = await fileIdentity(path);
    if (after === null || !sameIdentity(identity, after)) return null;
    const receipt: DigestReceipt = { version: 1, path: normalized, identity: after, sha256: sha256.toLowerCase() };
    await atomicWriteFile(this.receiptPath(normalized), JSON.stringify(receipt) + "\n").catch(() => {});
    return receipt.sha256;
  }
}
