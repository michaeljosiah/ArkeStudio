import { appendFlushed } from "../flushed-append.js";
import { atomicWriteFile } from "../world/atomic.js";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { LedgerEntrySchema, type LedgerEntry } from "@arke-studio/contracts";
import { WriteQueue } from "../change-log.js";
import { NdjsonTail } from "../ndjson-tail.js";

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
  private readonly tail: NdjsonTail<LedgerEntry>;
  /** First entry per job, in file order, as `.find` answered; extended as rows arrive (issue 2792). */
  private byJob = new Map<string, LedgerEntry>();
  private indexed = { generation: -1, count: 0 };

  constructor(readonly path: string) {
    this.tail = new NdjsonTail(path, (row) => LedgerEntrySchema.parse(row));
  }

  /**
   * Tolerate-and-repair a torn tail once, before the first append or read (§3.2).
   *
   * The latch is set only on a settled outcome — the same shape as the bench store's repair.
   * Latching before the read instead meant one transiently unreadable first touch (an EBUSY
   * from a virus scanner) permanently marked the file repaired: the next append then wrote
   * straight after the torn fragment, merging it with a valid entry into one line that parses
   * as neither, so a billed job vanished from a file that is never rewritten — and its absence
   * later reads as "never billed". Unrepairable now means the append rejects, which the queue
   * already treats as the ⑦ crash window and completes idempotently next start-up.
   */
  private async repairTail(): Promise<void> {
    if (this.repaired) return;
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") this.repaired = true; // no file yet
      return;
    }
    if (raw.length === 0 || raw.endsWith("\n")) {
      this.repaired = true;
      return;
    }
    // A final line without its newline is a torn write: keep every complete line, drop the tail.
    const cut = raw.lastIndexOf("\n");
    const keep = cut === -1 ? "" : raw.slice(0, cut + 1);
    await atomicWriteFile(this.path, keep);
    this.repaired = true;
  }

  /** Append one terminal outcome (R-16). Serialised, validated and file-synced before resolving
   * under SPEC-009 §2.2.1; a flush failure is not evidence that the row is absent. */
  append(entry: LedgerEntry): Promise<void> {
    const validated = LedgerEntrySchema.parse(entry);
    return this.queue.enqueue(async () => {
      await this.repairTail();
      await mkdir(dirname(this.path), { recursive: true });
      await appendFlushed(this.path, JSON.stringify(validated) + "\n");
    });
  }

  /**
   * Every valid entry; malformed interior lines are skipped, never fatal (tolerant reader).
   * The whole read is tolerant too — a file that cannot be read, or whose torn tail cannot be
   * repaired, answers as empty. Only for callers whose answer decorates something else (a
   * take's actual cost): for them a blank figure is honest degradation. Anything that would
   * *append* on the strength of an absence must use `readAllStrict`; anything that publishes
   * a figure the user reads as a total must use `readAllChecked`, which degrades and says so.
   */
  async readAll(): Promise<LedgerEntry[]> {
    return (await this.readAllChecked()).entries;
  }

  /**
   * The third answer between those two, for the spend evaluation (SPEC-032 R-21): it degrades
   * rather than throwing, and states the degradation rather than dressing an unreadable ledger
   * as a quiet window. A spend chart was named above as a caller that can blank honestly, and
   * it is the one that cannot: a rolling zero and an un-fired alert are a claim about the
   * money, not a blank. What counts as absence rather than failure is the shared reader's to
   * say (see ndjson.ts) — the seed reads this same file, and two definitions of `unavailable`
   * would let the seeded flag and the evaluated one disagree about one condition.
   *
   * The repair is settled first, and its failure is deliberately not a read that failed: the
   * repair is a *write*, it can fail on its own — a torn tail in a directory a scanner has
   * pinned — and the torn line it would have removed is skipped by the tolerant parse anyway.
   * Unguarded, that rejection escaped through `seedAppConfig` and the app would not boot on
   * exactly the degraded install this read exists to describe. `append` still meets the repair
   * failure head-on, which is where it is load-bearing, and the latch stays unset so it does.
   */
  async readAllChecked(): Promise<{ entries: LedgerEntry[]; unavailable: boolean }> {
    await this.queue.enqueue(() => this.repairTail()).catch(() => {});
    try {
      return { entries: [...(await this.entries())], unavailable: false };
    } catch (err) {
      // The shared reader's classification (ndjson.ts): ENOENT and ENOTDIR are absence.
      const code = (err as NodeJS.ErrnoException).code;
      return { entries: [], unavailable: code !== "ENOENT" && code !== "ENOTDIR" };
    }
  }

  /**
   * One job's entry, for the callers that read the whole ledger to find it (issue 2792). Tolerant
   * like `readAll`: an unreadable ledger answers undefined, a blank figure on what it decorates.
   */
  async entryFor(jobId: string): Promise<LedgerEntry | undefined> {
    try {
      await this.queue.enqueue(() => this.repairTail()).catch(() => {});
      await this.entries();
      return this.byJob.get(jobId);
    } catch {
      return undefined;
    }
  }

  /** Whether a job has its entry — strict like `readAllStrict`, because its caller appends on absence. */
  async has(jobId: string): Promise<boolean> {
    await this.read();
    return this.byJob.has(jobId);
  }

  /**
   * `readAll` for callers whose answer changes money. A missing file is a genuinely empty
   * ledger — nothing has ever been recorded — but any other read failure (EACCES, a transient
   * lock) throws rather than answering []: folded into "empty", an unreadable ledger tells the
   * reconciliation dedupe that every job in history was never billed, and the crash-window-⑦
   * completion pass appends a second entry for each — permanent, in a file that is never
   * rewritten or compacted, and indistinguishable from the double-charge bug SPEC-009 R-16
   * exists to prevent. A *missing* entry, by contrast, is the recoverable state: the next
   * start-up that can read the file completes it idempotently.
   */
  readAllStrict(): Promise<LedgerEntry[]> {
    return this.read();
  }

  /** The reconciliation dedupe snapshot — strict, because its only caller appends on absence. */
  async readJobIds(): Promise<Set<string>> {
    await this.read();
    return new Set(this.byJob.keys());
  }

  /**
   * The strict read path: ENOENT is an empty ledger, every other failure — the repair
   * included — reaches the caller. Its tolerant siblings resolve the same file through the
   * shared reader, so the three can never drift over what "the file" means; only over what to
   * do when it resists, which is the whole distinction between them.
   */
  private async read(): Promise<LedgerEntry[]> {
    await this.queue.enqueue(() => this.repairTail());
    try {
      return [...(await this.entries())];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.byJob = new Map();
        this.indexed = { generation: -1, count: 0 };
        return [];
      }
      throw err;
    }
  }

  /** The parsed entries, read by what the file gained, with the by-job index brought level. */
  private async entries(): Promise<readonly LedgerEntry[]> {
    const { entries, generation } = await this.tail.read();
    if (generation !== this.indexed.generation) this.byJob = new Map();
    const from = generation === this.indexed.generation ? this.indexed.count : 0;
    for (let i = from; i < entries.length; i++) {
      const entry = entries[i]!;
      if (!this.byJob.has(entry.jobId)) this.byJob.set(entry.jobId, entry);
    }
    this.indexed = { generation, count: entries.length };
    return entries;
  }

  drain(): Promise<void> {
    return this.queue.drain();
  }
}
