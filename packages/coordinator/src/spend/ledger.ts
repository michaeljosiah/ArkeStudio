import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LedgerEntrySchema, type LedgerEntry } from "@arke-studio/contracts";
import { WriteQueue } from "../change-log.js";

/**
 * The ledger (SPEC-008 §2.10, R-16): `%APP_ROOT%\ledger.jsonl`, append-only, one entry per
 * terminal job outcome — failures and cancellations included (D7), because Arke Studio cannot
 * promise a failed job was not billed. Never rewritten, never compacted; the one repair
 * permitted is truncating a torn final line left by a crash mid-write, which removes no
 * completed record.
 */
export class LedgerFile {
  private readonly queue = new WriteQueue();
  private repaired = false;

  constructor(readonly path: string) {}

  /** Tolerate-and-repair a torn tail once, before the first append or read (§3.2). */
  private async repairTail(): Promise<void> {
    if (this.repaired) return;
    this.repaired = true;
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      return; // no file yet
    }
    if (raw.length === 0 || raw.endsWith("\n")) return;
    // A final line without its newline is a torn write: keep every complete line, drop the tail.
    const cut = raw.lastIndexOf("\n");
    const keep = cut === -1 ? "" : raw.slice(0, cut + 1);
    const tmp = join(dirname(this.path), `.tmp-ledger-repair-${process.pid}`);
    await writeFile(tmp, keep, "utf8");
    await rename(tmp, this.path);
  }

  /** Append one terminal outcome (R-16). Serialised; validated before it can land. */
  append(entry: LedgerEntry): Promise<void> {
    const validated = LedgerEntrySchema.parse(entry);
    return this.queue.enqueue(async () => {
      await this.repairTail();
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, JSON.stringify(validated) + "\n", "utf8");
    });
  }

  /** Every valid entry; malformed interior lines are skipped, never fatal (tolerant reader). */
  async readAll(): Promise<LedgerEntry[]> {
    await this.queue.enqueue(() => this.repairTail());
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      return [];
    }
    const out: LedgerEntry[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const parsed = LedgerEntrySchema.safeParse(JSON.parse(t));
        if (parsed.success) out.push(parsed.data);
      } catch {
        /* torn or foreign line — skipped */
      }
    }
    return out;
  }

  drain(): Promise<void> {
    return this.queue.drain();
  }
}
