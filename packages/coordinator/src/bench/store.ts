import { open, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import {
  BenchEventEnvelopeSchema,
  BenchSessionMetaSchema,
  foldBenchSession,
  type BenchEvent,
  type BenchEventEnvelope,
  type BenchSession,
  type BenchSessionMeta,
  type SessionId,
} from "@arke-studio/contracts";
import { WriteQueue } from "../change-log.js";
import { toExtendedLength } from "../world/paths.js";

/**
 * One bench session's durable record: `.sessions/<sess>/events.jsonl` (issue 305 §6).
 *
 * The shape is World Chat's store, for the same reason at higher stakes: an append here is what
 * authorizes a paid provider call, so it resolves only once the bytes are on the device —
 * `fsync` before dispatch — and a torn final line is repaired once rather than extended. Writers
 * serialize per directory, not per instance, because handlers build a store per command and two
 * overlapping appends reading the same tail would claim the same sequence number.
 *
 * The log is append-only. The single exception is truncating a torn final line, which is a
 * repair of a record that was never complete rather than a rewrite of one that was.
 */

const EVENTS_FILE = "events.jsonl";
const META_FILE = "session.json";

export function sessionsDir(worldDir: string): string {
  return join(worldDir, ".sessions");
}

export function sessionDir(worldDir: string, id: SessionId): string {
  return join(sessionsDir(worldDir), id);
}

/** Where a take's landed media lives, world-relative — the job's landing dir points here. */
export function sessionMediaDir(id: SessionId, takeId: string): string {
  return `.sessions/${id}/media/${takeId}`;
}

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

interface Tail {
  size: number;
  digest: string;
  seq: number;
}

interface Writer {
  queue: WriteQueue;
  tail: Tail | null;
  /** An append failed where bytes may be down; the next one re-checks the tail first. */
  uncertain: boolean;
}

const writers = new Map<string, Writer>();

function writerFor(dir: string): Writer {
  const key = resolve(dir);
  const existing = writers.get(key);
  if (existing) return existing;
  const created: Writer = { queue: new WriteQueue(), tail: null, uncertain: false };
  writers.set(key, created);
  return created;
}

export interface BenchAppendResult {
  envelope: BenchEventEnvelope;
  /** True when a matching requestId had already been applied and nothing new was written. */
  deduplicated: boolean;
}

export class BenchStore {
  private readonly writer: Writer;
  private repaired = false;

  constructor(readonly dir: string) {
    this.writer = writerFor(dir);
  }

  get eventsPath(): string {
    return join(this.dir, EVENTS_FILE);
  }

  get metaPath(): string {
    return join(this.dir, META_FILE);
  }

  /** Create the directory and its immutable header. Safe to call twice. */
  async create(id: SessionId, createdAt: string): Promise<BenchSessionMeta> {
    const meta = BenchSessionMetaSchema.parse({ schemaVersion: 1, id, createdAt });
    await mkdir(toExtendedLength(this.dir), { recursive: true });
    // wx: a second create must not silently rewrite the identity of an existing session.
    await writeFile(toExtendedLength(this.metaPath), JSON.stringify(meta, null, 2), {
      encoding: "utf8",
      flag: "wx",
    }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") throw err;
    });
    return meta;
  }

  async readMeta(): Promise<BenchSessionMeta | null> {
    try {
      const raw = await readFile(toExtendedLength(this.metaPath), "utf8");
      const parsed = BenchSessionMetaSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** Truncate a torn final line, once per store — and again after an append that may have torn one. */
  private async repairTail(): Promise<void> {
    if (this.repaired && !this.writer.uncertain) return;
    let raw: string;
    try {
      raw = await readFile(toExtendedLength(this.eventsPath), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") this.settleRepair();
      return;
    }
    if (raw.length === 0 || raw.endsWith("\n")) {
      this.settleRepair();
      return;
    }
    const cut = raw.lastIndexOf("\n");
    const keep = cut === -1 ? "" : raw.slice(0, cut + 1);
    const tmp = join(this.dir, `.tmp-events-repair-${process.pid}`);
    await writeFile(toExtendedLength(tmp), keep, "utf8");
    await rename(toExtendedLength(tmp), toExtendedLength(this.eventsPath));
    this.settleRepair();
  }

  private settleRepair(): void {
    this.repaired = true;
    this.writer.uncertain = false;
  }

  private async inspectTail(): Promise<Tail> {
    let raw = "";
    try {
      raw = await readFile(toExtendedLength(this.eventsPath), "utf8");
    } catch {
      return { size: 0, digest: sha256(""), seq: 0 };
    }
    let seq = 0;
    for (const line of raw.split("\n")) {
      const text = line.trim();
      if (!text) continue;
    try {
        const parsed = BenchEventEnvelopeSchema.safeParse(JSON.parse(text));
        if (parsed.success) seq = Math.max(seq, parsed.data.seq);
      } catch {
        /* a line that will not parse cannot advance the sequence */
      }
    }
    return { size: Buffer.byteLength(raw, "utf8"), digest: sha256(raw), seq };
  }

  /**
   * Append one event, durably. `requestId` makes a retried command safe: a repeat of an id
   * already in the log returns the original envelope and writes nothing, so a client that
   * resends after a dropped connection cannot dispatch twice.
   */
  append(
    event: BenchEvent,
    options: { at: string; requestId?: string } = { at: new Date().toISOString() },
  ): Promise<BenchAppendResult> {
    let result!: BenchAppendResult;
    return this.writer.queue
      .enqueue(async () => {
        await mkdir(toExtendedLength(this.dir), { recursive: true });
        await this.repairTail();

        if (options.requestId) {
          const existing = await this.findByRequestId(options.requestId);
          if (existing) {
            result = { envelope: existing, deduplicated: true };
            return;
          }
        }

        const current = await this.inspectTail();
        const seen = this.writer.tail;
        if (seen && (current.size !== seen.size || current.digest !== seen.digest)) {
          throw new Error("this bench session changed outside Arke Studio — nothing was appended");
        }

        const envelope = BenchEventEnvelopeSchema.parse({
          seq: current.seq + 1,
          at: options.at,
          ...(options.requestId ? { requestId: options.requestId } : {}),
          event,
        });

        const line = JSON.stringify(envelope) + "\n";
        // From here the bytes may be down; on any failure the tail is forgotten and re-checked.
        try {
          const handle = await open(toExtendedLength(this.eventsPath), "a");
          try {
            await handle.appendFile(line, "utf8");
            // The caller acts on the strength of this append — the reservation that authorizes
            // provider spend — so it resolves only once the bytes are on the device.
            await handle.sync();
          } finally {
            await handle.close();
          }
          this.writer.tail = {
            size: current.size + Buffer.byteLength(line, "utf8"),
            digest: sha256(await readFile(toExtendedLength(this.eventsPath), "utf8")),
            seq: envelope.seq,
          };
        } catch (err) {
          this.writer.tail = null;
          this.writer.uncertain = true;
          throw err;
        }
        result = { envelope, deduplicated: false };
      })
      .then(() => result);
  }

  /** Every complete, valid event. Interior corruption skips the line rather than throwing. */
  async read(): Promise<BenchEventEnvelope[]> {
    await this.writer.queue.enqueue(() => this.repairTail());
    return this.readParsed();
  }

  private async readParsed(): Promise<BenchEventEnvelope[]> {
    let raw: string;
    try {
      raw = await readFile(toExtendedLength(this.eventsPath), "utf8");
    } catch {
      return [];
    }
    const events: BenchEventEnvelope[] = [];
    for (const line of raw.split("\n")) {
      const text = line.trim();
      if (!text) continue;
      try {
        const parsed = BenchEventEnvelopeSchema.safeParse(JSON.parse(text));
        if (parsed.success) events.push(parsed.data);
      } catch {
        /* the valid records around it still matter */
      }
    }
    return events;
  }

  private async findByRequestId(requestId: string): Promise<BenchEventEnvelope | null> {
    const events = await this.readParsed();
    return events.find((e) => e.requestId === requestId) ?? null;
  }

  /** The folded session, or null where the directory is not a session at all. */
  async fold(): Promise<BenchSession | null> {
    const meta = await this.readMeta();
    if (!meta) return null;
    return foldBenchSession(meta, await this.read());
  }
}
