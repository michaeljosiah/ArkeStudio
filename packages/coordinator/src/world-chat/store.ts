import { open, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  WorldChatConversationMetaSchema,
  WorldChatEventEnvelopeSchema,
  newId,
  type ConversationId,
  type WorldChatConversationMeta,
  type WorldChatEventEnvelope,
  type WorldChatProblem,
  type WorldChatStoredEvent,
} from "@arke-studio/contracts";
import { WriteQueue } from "../change-log.js";
import { toExtendedLength } from "../world/paths.js";

/**
 * One conversation's durable record: `.conversations/<cv>/events.jsonl` (#70 §4.2–§4.3).
 *
 * The shape follows the job journal — a WriteQueue serialises writers, a torn final line is
 * repaired once, and a line that will not parse is skipped rather than thrown. Two things go
 * further, both because this log is the only copy of what was said:
 *
 *   · **fsync before reporting success.** The journal lets the OS decide when bytes reach the
 *     disk. Here an append resolves only after the data is actually down, because the caller's
 *     next act is to send the user's message to a model, and a crash in that window must not
 *     lose the message that authorised it.
 *
 *   · **the tail is checked before it is extended.** The writer remembers the byte length and
 *     digest of the tail it last wrote. If the file no longer matches, some other process edited
 *     an operational file, and the append is refused. Ignoring `.conversations` in the world
 *     watcher means nothing else will notice, so the writer has to.
 *
 * The log is append-only. The single exception is truncating a torn final line, which is a
 * repair of a record that was never complete rather than a rewrite of one that was.
 */

const EVENTS_FILE = "events.jsonl";
const META_FILE = "conversation.json";

export class ConversationIntegrityError extends Error {
  constructor(readonly problem: WorldChatProblem) {
    super(problem.detail);
    this.name = "ConversationIntegrityError";
  }
}

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

export interface AppendResult {
  envelope: WorldChatEventEnvelope;
  /** True when a matching requestId had already been applied and nothing new was written. */
  deduplicated: boolean;
}

export interface ReadResult {
  events: WorldChatEventEnvelope[];
  problems: WorldChatProblem[];
}

export class WorldChatStore {
  private readonly queue = new WriteQueue();
  /** The tail this writer last saw. A mismatch means somebody else wrote to the file. */
  private tail: { size: number; digest: string; seq: number } | null = null;
  private repaired = false;

  constructor(readonly dir: string) {}

  get eventsPath(): string {
    return join(this.dir, EVENTS_FILE);
  }

  get metaPath(): string {
    return join(this.dir, META_FILE);
  }

  /** Create the directory and its immutable header. Safe to call twice. */
  async create(id: ConversationId, createdAt: string): Promise<WorldChatConversationMeta> {
    const meta = WorldChatConversationMetaSchema.parse({ schemaVersion: 1, id, createdAt });
    await mkdir(toExtendedLength(this.dir), { recursive: true });
    // wx: a second create must not silently rewrite the identity of an existing conversation.
    await writeFile(toExtendedLength(this.metaPath), JSON.stringify(meta, null, 2), {
      encoding: "utf8",
      flag: "wx",
    }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") throw err;
    });
    return meta;
  }

  async readMeta(): Promise<WorldChatConversationMeta | null> {
    try {
      const raw = await readFile(toExtendedLength(this.metaPath), "utf8");
      const parsed = WorldChatConversationMetaSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /**
   * Truncate a torn final line, once per process.
   *
   * A crash mid-append leaves bytes that are not a record. Keeping them would corrupt the next
   * append by merging two half-lines into one plausible-looking record, which is worse than
   * losing the incomplete one.
   */
  private async repairTail(problems: WorldChatProblem[]): Promise<void> {
    if (this.repaired) return;
    this.repaired = true;
    let raw: string;
    try {
      raw = await readFile(toExtendedLength(this.eventsPath), "utf8");
    } catch {
      return;
    }
    if (raw.length === 0 || raw.endsWith("\n")) return;
    const cut = raw.lastIndexOf("\n");
    const keep = cut === -1 ? "" : raw.slice(0, cut + 1);
    const tmp = join(this.dir, `.tmp-events-repair-${process.pid}`);
    await writeFile(toExtendedLength(tmp), keep, "utf8");
    await rename(toExtendedLength(tmp), toExtendedLength(this.eventsPath));
    problems.push({
      kind: "torn-tail",
      detail: "The last event was incomplete and has been discarded. Everything before it is intact.",
    });
  }

  /** Current tail facts, straight from disk. */
  private async inspectTail(): Promise<{ size: number; digest: string; seq: number }> {
    let raw = "";
    try {
      raw = await readFile(toExtendedLength(this.eventsPath), "utf8");
    } catch {
      return { size: 0, digest: sha256(""), seq: 0 };
    }
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    let seq = 0;
    for (const line of lines) {
      try {
        const parsed = WorldChatEventEnvelopeSchema.safeParse(JSON.parse(line));
        if (parsed.success) seq = Math.max(seq, parsed.data.seq);
      } catch {
        /* a line that will not parse cannot advance the sequence */
      }
    }
    return { size: Buffer.byteLength(raw, "utf8"), digest: sha256(raw), seq };
  }

  /**
   * Append one event, durably.
   *
   * `requestId` makes a retry safe: a repeat of an id already in the log returns the original
   * envelope and writes nothing, so a client that resends after a dropped connection cannot
   * duplicate a message or a wrap-up.
   */
  append(
    event: WorldChatStoredEvent,
    options: { at: string; requestId?: string } = { at: new Date().toISOString() },
  ): Promise<AppendResult> {
    let result!: AppendResult;
    return this.queue
      .enqueue(async () => {
        const problems: WorldChatProblem[] = [];
        await mkdir(toExtendedLength(this.dir), { recursive: true });
        await this.repairTail(problems);

        if (options.requestId) {
          const existing = await this.findByRequestId(options.requestId);
          if (existing) {
            result = { envelope: existing, deduplicated: true };
            return;
          }
        }

        const current = await this.inspectTail();
        if (this.tail && (current.size !== this.tail.size || current.digest !== this.tail.digest)) {
          throw new ConversationIntegrityError({
            kind: "foreign-write",
            detail:
              "This conversation changed outside Arke Studio. Nothing was appended, so no record has been lost.",
            atSeq: current.seq,
          });
        }

        const envelope = WorldChatEventEnvelopeSchema.parse({
          schemaVersion: 1,
          seq: current.seq + 1,
          eventId: newId("wce"),
          at: options.at,
          ...(options.requestId ? { requestId: options.requestId } : {}),
          event,
        });

        const line = JSON.stringify(envelope) + "\n";
        const handle = await open(toExtendedLength(this.eventsPath), "a");
        try {
          await handle.appendFile(line, "utf8");
          // The whole point of this store: the caller acts on the strength of this append, so
          // it resolves only once the bytes are on the device, not merely in a page cache.
          await handle.sync();
        } finally {
          await handle.close();
        }

        this.tail = {
          size: current.size + Buffer.byteLength(line, "utf8"),
          digest: sha256((await readFile(toExtendedLength(this.eventsPath), "utf8")) as string),
          seq: envelope.seq,
        };
        result = { envelope, deduplicated: false };
      })
      .then(() => result);
  }

  /** Every complete, valid event, with any problems reading them named rather than swallowed. */
  async read(): Promise<ReadResult> {
    const problems: WorldChatProblem[] = [];
    await this.queue.enqueue(() => this.repairTail(problems));
    return this.readParsed(problems);
  }

  /**
   * The parsing half of a read, without touching the write queue.
   *
   * `append` runs inside the queue and needs to look at the log to honour a repeated request id.
   * Going through `read` from there would enqueue a task behind the one already running and
   * deadlock the chain, so both paths share this and each takes care of repair itself.
   */
  private async readParsed(problems: WorldChatProblem[]): Promise<ReadResult> {
    let raw: string;
    try {
      raw = await readFile(toExtendedLength(this.eventsPath), "utf8");
    } catch {
      return { events: [], problems };
    }
    const events: WorldChatEventEnvelope[] = [];
    const lines = raw.split("\n");
    for (const [index, line] of lines.entries()) {
      const text = line.trim();
      if (!text) continue;
      let parsed;
      try {
        parsed = WorldChatEventEnvelopeSchema.safeParse(JSON.parse(text));
      } catch {
        parsed = undefined;
      }
      if (parsed?.success) {
        events.push(parsed.data);
        continue;
      }
      // A bad line in the middle is not the crash signature — repairTail already handled that —
      // so it is corruption. The valid records around it still matter, so reading continues and
      // the failure is reported instead of thrown.
      problems.push({
        kind: "interior-corruption",
        detail: `Line ${index + 1} of this conversation could not be read. The events around it are intact.`,
      });
    }
    // Out-of-order sequences would mean two writers; sorting hides that, so it is reported.
    for (let i = 1; i < events.length; i++) {
      if (events[i]!.seq <= events[i - 1]!.seq) {
        problems.push({
          kind: "interior-corruption",
          detail: "Event sequence numbers are out of order, which means two writers touched this log.",
          atSeq: events[i]!.seq,
        });
        break;
      }
    }
    return { events, problems };
  }

  /** Called from inside the queue, so it reads directly rather than enqueuing another task. */
  private async findByRequestId(requestId: string): Promise<WorldChatEventEnvelope | null> {
    const { events } = await this.readParsed([]);
    return events.find((e) => e.requestId === requestId) ?? null;
  }

  /** Wait for in-flight writes, for shutdown and for tests that assert on the file. */
  drain(): Promise<void> {
    return this.queue.drain();
  }
}

/** Where a world keeps its unfinished conversations. Operational state, like `.proposals`. */
export function conversationsDir(worldPath: string): string {
  return join(worldPath, ".conversations");
}

export function conversationDir(worldPath: string, id: ConversationId): string {
  return join(conversationsDir(worldPath), id);
}
