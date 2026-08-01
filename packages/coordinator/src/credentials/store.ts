import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ProviderId } from "@arke-studio/contracts";
import type { SecretRegistry } from "../redact.js";

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
  private cache: FileShape | null = null;

  constructor(
    private readonly path: string,
    private readonly cipher: Cipher,
    private readonly registry: SecretRegistry,
    /** Injectable for tests; the real one calls icacls / chmod. */
    private readonly aclReset: (path: string) => Promise<void> = lockDownAcl,
  ) {}

  private async load(): Promise<FileShape> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as FileShape;
      this.cache = parsed.version === 1 && typeof parsed.entries === "object" ? parsed : { version: 1, entries: {} };
    } catch {
      this.cache = { version: 1, entries: {} };
    }
    return this.cache;
  }

  private async persist(shape: FileShape): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = join(dirname(this.path), `.tmp-credentials-${process.pid}`);
    await writeFile(tmp, JSON.stringify(shape), "utf8");
    await rename(tmp, this.path);
    try {
      await this.aclReset(this.path);
    } catch {
      // ACL hardening is best-effort on exotic file systems; the ciphertext still requires
      // the OS user's DPAPI key to decrypt.
    }
    this.cache = shape;
  }

  /** Store a credential: registered for redaction, encrypted, written, ACL reset (R-5, R-7). */
  async set(provider: ProviderId, plaintext: string): Promise<void> {
    if (!this.cipher.isAvailable()) throw new Error("credential encryption is unavailable on this machine");
    this.registry.register(plaintext);
    const shape = await this.load();
    const next: FileShape = {
      version: 1,
      entries: { ...shape.entries, [provider]: this.cipher.encryptString(plaintext).toString("base64") },
    };
    await this.persist(next);
  }

  async clear(provider: ProviderId): Promise<void> {
    const shape = await this.load();
    if (!(provider in shape.entries)) return;
    const entries = { ...shape.entries };
    delete entries[provider];
    await this.persist({ version: 1, entries });
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
