import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ProviderId } from "@arke-studio/contracts";
import type { SecretRegistry } from "../redact.js";
import { renameWithRetry, serializeFileMutation } from "../world/atomic.js";

const execFileAsync = promisify(execFile);

/**
 * Credential storage (SPEC-008 §2.3, R-5, R-8): `safeStorage` is an encryption primitive, not
 * a store — this is the store. Ciphertext lives in `%APP_ROOT%\credentials.dat`, outside every
 * world so no export can carry it; the ACL is reset to the current user on every write.
 * Plaintext exists only in main-process memory, and every plaintext that passes through here
 * is registered with the redaction boundary before anything can log it (R-7).
 */

export interface Cipher {
  isAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(cipher: Buffer): string;
}

interface FileShape {
  version: 1;
  /** provider → base64 ciphertext. */
  entries: Record<string, string>;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

/** Reset the file's ACL to the current user alone, inherited permissions removed (R-5). */
async function lockDownAcl(path: string): Promise<void> {
  if (process.platform === "win32") {
    const user = `${process.env["USERDOMAIN"] ?? "."}\\${process.env["USERNAME"] ?? ""}`;
    await execFileAsync("icacls.exe", [path, "/inheritance:r", "/grant:r", `${user}:F`], {
      timeout: 10_000,
      windowsHide: true,
    });
  } else {
    await chmod(path, 0o600);
  }
}

export class CredentialStore {
  constructor(
    private readonly path: string,
    private readonly cipher: Cipher,
    private readonly registry: SecretRegistry,
    /** Injectable for tests; the real one calls icacls / chmod. */
    private readonly aclReset: (path: string) => Promise<void> = lockDownAcl,
  ) {}

  private async load(): Promise<FileShape> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: {} };
      throw err;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (err) {
      throw new Error(`credential file "${this.path}" contains malformed JSON`, { cause: err });
    }
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      (value as Record<string, unknown>)["version"] !== 1 ||
      !isStringRecord((value as Record<string, unknown>)["entries"])
    ) {
      throw new Error(`credential file "${this.path}" does not match the current schema`);
    }
    return { version: 1, entries: { ...(value as { entries: Record<string, string> }).entries } };
  }

  private async persist(shape: FileShape): Promise<void> {
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `.tmp-${basename(this.path)}-${randomUUID()}`);
    try {
      const created = await open(tmp, "wx", 0o600);
      await created.close();
      // Harden the staged inode before credential bytes are written or it can replace a valid file.
      await this.aclReset(tmp);
      const handle = await open(tmp, "r+");
      try {
        await handle.writeFile(JSON.stringify(shape), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await renameWithRetry(tmp, this.path);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  /** Store a credential: registered for redaction, encrypted, written, ACL reset (R-5, R-7). */
  async set(provider: ProviderId, plaintext: string): Promise<void> {
    if (!this.cipher.isAvailable()) throw new Error("credential encryption is unavailable on this machine");
    this.registry.register(plaintext);
    const encrypted = this.cipher.encryptString(plaintext).toString("base64");
    await serializeFileMutation(this.path, async () => {
      const shape = await this.load();
      await this.persist({ version: 1, entries: { ...shape.entries, [provider]: encrypted } });
    });
  }

  async clear(provider: ProviderId): Promise<void> {
    await serializeFileMutation(this.path, async () => {
      const shape = await this.load();
      if (!(provider in shape.entries)) return;
      const entries = { ...shape.entries };
      delete entries[provider];
      await this.persist({ version: 1, entries });
    });
  }

  /**
   * Decrypt for a request's lifetime (R-8). The plaintext is registered with the redaction
   * boundary on every read — a restart re-arms the scrubber the first time a key is used.
   */
  async get(provider: ProviderId): Promise<string | null> {
    const shape = await this.load();
    const b64 = shape.entries[provider];
    if (b64 === undefined) return null;
    if (!this.cipher.isAvailable()) throw new Error("credential decryption is unavailable on this machine");
    const plain = this.cipher.decryptString(Buffer.from(b64, "base64"));
    this.registry.register(plain);
    return plain;
  }

  async has(provider: ProviderId): Promise<boolean> {
    const shape = await this.load();
    return provider in shape.entries;
  }

  async configuredProviders(): Promise<ProviderId[]> {
    const shape = await this.load();
    return Object.keys(shape.entries) as ProviderId[];
  }
}
