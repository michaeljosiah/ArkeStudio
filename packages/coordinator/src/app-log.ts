import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { WriteQueue } from "./change-log.js";
import { redactDeep, type SecretRegistry } from "./redact.js";

/**
 * The app-level operational log at `%APP_ROOT%\logs\app.jsonl` (SPEC-008 R-7): provider
 * faults, validation runs, threshold alerts. Every record passes through the redaction
 * boundary on the way in — there is no unredacted write path to this file.
 */
export class AppLog {
  private readonly queue = new WriteQueue();

  constructor(
    private readonly path: string,
    private readonly registry: SecretRegistry,
  ) {}

  append(record: Record<string, unknown>): Promise<void> {
    return this.queue.enqueue(async () => {
      const redacted = redactDeep({ at: new Date().toISOString(), ...record }, this.registry);
      try {
        await mkdir(dirname(this.path), { recursive: true });
        await appendFile(this.path, JSON.stringify(redacted) + "\n", "utf8");
      } catch {
        /* an unwritable log degrades audit, never the app */
      }
    });
  }

  drain(): Promise<void> {
    return this.queue.drain();
  }

  /** The recent tail, for diagnostics — already redacted at write time, scrubbed again on read. */
  async tail(lines: number): Promise<string[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      return [];
    }
    const all = raw.split("\n").filter((l) => l.trim().length > 0);
    return all.slice(-lines).map((l) => this.registry.scrub(l));
  }
}
