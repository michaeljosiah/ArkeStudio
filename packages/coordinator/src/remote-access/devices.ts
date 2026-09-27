import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { lockDownAcl } from "../credentials/store.js";
import { renameWithRetry } from "../world/atomic.js";

const lifetime = 90 * 24 * 60 * 60 * 1000;
const DeviceSchema = z.object({ id: z.string().uuid(), name: z.string().min(1).max(60),
  hash: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.number(), expiresAt: z.number() });
const RegistrySchema = z.object({ version: z.literal(1), devices: z.array(DeviceSchema).max(100) });
type Device = z.infer<typeof DeviceSchema>;
type Request = { id: string; name: string; proof: string; expiresAt: number; approved: boolean };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Permissions are applied before publication, including on Windows; failed writes grant nothing. */
export async function writeRemotePrivate(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + "." + randomUUID() + ".tmp";
  const file = await open(temporary, "wx", 0o600);
  try {
    await lockDownAcl(temporary);
    await file.writeFile(JSON.stringify(value) + "\n");
    await file.sync();
    await file.close();
    await renameWithRetry(temporary, path);
  } finally {
    await file.close().catch(() => {});
    await rm(temporary, { force: true });
  }
}

/** A device owns a random proof, never the coordinator's process capability. Disk holds hashes.
 * Pending requests and codes die with the host, while approved proofs survive normal restarts. */
export class RemoteDevices {
  private devices: Device[] = [];
  private requests = new Map<string, Request>();
  private pairing: { code: string; expiresAt: number; attempts: number } | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string, private readonly now = Date.now,
    private readonly persist = writeRemotePrivate) {}

  async load(): Promise<void> {
    try { this.devices = RegistrySchema.parse(JSON.parse(await readFile(this.path, "utf8"))).devices; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result;
  }
  private expire(): void {
    for (const [proof, request] of this.requests) if (request.expiresAt <= this.now()) this.requests.delete(proof);
  }
  list() { return this.devices.filter(row => row.expiresAt > this.now()).map(({ hash: _hash, ...row }) => row); }
  pending() { this.expire(); return [...this.requests.values()].filter(row => !row.approved)
    .map(({ id, name, expiresAt }) => ({ id, name, expiresAt })); }
  createCode(): { code: string; expiresAt: number } {
    const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    const code = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join("");
    this.pairing = { code, expiresAt: this.now() + 5 * 60_000, attempts: 0 };
    return { code, expiresAt: this.pairing.expiresAt };
  }
  request(code: string, name: string): string | null {
    this.expire();
    const pairing = this.pairing;
    if (!pairing || pairing.expiresAt <= this.now() || ++pairing.attempts > 5 || this.requests.size >= 10) return null;
    if (!equal(pairing.code, code.trim().toUpperCase().replace(/[ -]/g, ""))) return null;
    this.pairing = null;
    const proof = randomBytes(32).toString("hex");
    this.requests.set(proof, { id: randomUUID(), name: name.trim().slice(0, 60) || "Browser",
      proof, expiresAt: this.now() + 5 * 60_000, approved: false });
    return proof;
  }
  poll(proof: string): "pending" | "approved" | "expired" {
    this.expire();
    const request = this.requests.get(proof);
    return request ? request.approved && this.authenticate(proof) ? "approved" : "pending" : "expired";
  }
  approve(id: string): Promise<void> {
    return this.serial(async () => {
      this.expire();
      const request = [...this.requests.values()].find(row => row.id === id);
      if (!request || request.approved) throw new Error("This pairing request has expired.");
      const devices = this.devices.filter(row => row.expiresAt > this.now());
      if (devices.length >= 100) throw new Error("Remove an old device before pairing another.");
      devices.push({ id, name: request.name, hash: digest(request.proof), createdAt: this.now(), expiresAt: this.now() + lifetime });
      await this.persist(this.path, { version: 1, devices });
      this.devices = devices;
      request.approved = true;
    });
  }
  reject(id: string): void { for (const [proof, request] of this.requests) if (request.id === id) this.requests.delete(proof); }
  revoke(id: string): Promise<void> {
    return this.serial(async () => {
      const devices = this.devices.filter(row => row.id !== id);
      await this.persist(this.path, { version: 1, devices });
      this.devices = devices;
      this.reject(id);
    });
  }
  authenticate(proof: string | undefined): string | null {
    if (!proof || !/^[a-f0-9]{64}$/.test(proof)) return null;
    const hash = digest(proof);
    return this.devices.find(row => row.expiresAt > this.now() && equal(row.hash, hash))?.id ?? null;
  }
  stop(): Promise<unknown> { this.pairing = null; this.requests.clear(); return this.tail; }
}
