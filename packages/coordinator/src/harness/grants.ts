import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../world/atomic.js";
import { toExtendedLength } from "../world/paths.js";

/**
 * Remembered permission grants (SPEC-005 R-16), persisted at the app root — durable across
 * restarts, revocable, and every auto-grant is recorded. Adopted in spirit from Arke's
 * grant-store.
 */

export interface RememberedGrant {
  id: string;
  actionClass: string;
  createdAt: string;
  revoked?: boolean;
}

export class GrantStore {
  private grants: RememberedGrant[] = [];
  private loaded = false;

  constructor(private readonly appRoot: string) {}

  private path(): string {
    return join(this.appRoot, "grants.json");
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(toExtendedLength(this.path()), "utf8");
      const parsed = JSON.parse(raw) as { grants?: RememberedGrant[] };
      if (Array.isArray(parsed.grants)) this.grants = parsed.grants;
    } catch {
      /* no grants yet */
    }
  }

  private async save(): Promise<void> {
    await atomicWriteFile(this.path(), JSON.stringify({ grants: this.grants }, null, 2) + "\n");
  }

  /** Whether a live remembered grant covers this action class. */
  async covers(actionClass: string): Promise<boolean> {
    await this.load();
    return this.grants.some((g) => g.actionClass === actionClass && g.revoked !== true);
  }

  async remember(actionClass: string, at: string): Promise<void> {
    await this.load();
    if (this.grants.some((g) => g.actionClass === actionClass && g.revoked !== true)) return;
    this.grants.push({ id: `grant_${Date.now().toString(36)}`, actionClass, createdAt: at });
    await this.save();
  }

  async revoke(id: string): Promise<void> {
    await this.load();
    this.grants = this.grants.map((g) => (g.id === id ? { ...g, revoked: true } : g));
    await this.save();
  }

  async list(): Promise<RememberedGrant[]> {
    await this.load();
    return [...this.grants];
  }
}
