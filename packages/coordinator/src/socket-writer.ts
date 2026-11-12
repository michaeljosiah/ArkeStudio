import type { WebSocket } from "ws";

export interface SocketWriterOptions {
  label: string;
  trace?: (detail: Record<string, unknown>) => void;
  busy?: (sending: boolean) => void;
  maxQueuedBytes?: number;
  maxQueuedFrames?: number;
  maxFrameBytes?: number;
  sendTimeoutMs?: number;
  closeTimeoutMs?: number;
}

/** A snapshot frame, so that a newer one may replace it while it waits: `key` names what it is a snapshot of. */
export interface SupersedableSnapshot {
  key: string;
  /** Whatever the sender needs back to build a frame that replaces this one. */
  base?: unknown;
  /** Never replaced, and nothing queued before it is either. */
  keep?: boolean;
}

interface Queued {
  texts: readonly string[];
  bytes: number;
  snapshot?: SupersedableSnapshot;
}

/** Ordered delivery with bounded memory. Never discard an event to make room for a snapshot:
 * transient permissions and command replies cannot be reconstructed from that snapshot.
 *
 * A snapshot still waiting is a different matter once a newer snapshot of the same thing is
 * sent behind it: the newer one holds everything the older did. On a large world a snapshot
 * is 11 MB or more, and a long picture run asks for several a picture; a window busy applying
 * one fell behind, the waiting copies passed the byte limit, and the socket was closed about
 * ten times in ten minutes (2026-10-24). The older one is dropped from the queue and every
 * event between them is kept, in order. Only the last snapshot waiting can be replaced, so the
 * snapshot before it, which the reader will have applied, is always the replacement's `base`. */
export class SocketWriter {
  private queue: Queued[] = [];
  private queuedBytes = 0;
  private supersededSnapshots = 0;
  private sending = false;
  private active: Iterator<string> | undefined;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private lastFrameBytes = 0;
  private peakBufferedBytes = 0;
  private sentFrames = 0;
  private localCloseReason: string | null = null;

  constructor(private socket: Pick<WebSocket, "readyState" | "bufferedAmount" | "send" | "close" | "terminate">,
    private options: SocketWriterOptions) {}

  stats(): Record<string, unknown> {
    return { lastFrameBytes: this.lastFrameBytes, queuedBytes: this.queuedBytes,
      queuedFrames: this.queue.length, bufferedBytes: this.socket.bufferedAmount,
      peakBufferedBytes: this.peakBufferedBytes, sentFrames: this.sentFrames,
      supersededSnapshots: this.supersededSnapshots, localCloseReason: this.localCloseReason };
  }

  /** The waiting snapshot a newer snapshot of `key` would replace: the last one queued, of `key`, not kept. */
  unsentSnapshot(key: string): SupersedableSnapshot | undefined {
    const index = this.replaceable(key);
    return index === -1 ? undefined : this.queue[index]!.snapshot;
  }

  private replaceable(key: string): number {
    const index = this.queue.findLastIndex((entry) => entry.snapshot !== undefined);
    const snapshot = index === -1 ? undefined : this.queue[index]!.snapshot;
    return snapshot !== undefined && snapshot.key === key && snapshot.keep !== true ? index : -1;
  }

  send(text: string, options: { snapshot?: SupersedableSnapshot } = {}): void {
    this.sendBatch([text], options);
  }

  /** A paged snapshot is one bounded transfer. Drain its pages one send callback at a time,
   * keeping the final barrier ahead of later events without charging its own pages to the
   * waiting queue. Its total size retains the legacy single-snapshot payload limit. */
  sendBatch(texts: readonly string[], options: { snapshot?: SupersedableSnapshot } = {}): void {
    if (this.stopped || this.socket.readyState !== 1) return;
    if (!texts.length) return;
    const bytes = texts.reduce((total, text) => total + Buffer.byteLength(text), 0);
    if (bytes > (this.options.maxFrameBytes ?? 100 * 1024 * 1024)) {
      this.fail("outbound frame limit", bytes); return;
    }
    const snapshot = options.snapshot;
    if (snapshot !== undefined && snapshot.keep !== true) {
      const older = this.replaceable(snapshot.key);
      if (older !== -1) {
        this.queuedBytes -= this.queue[older]!.bytes;
        this.queue.splice(older, 1);
        this.supersededSnapshots++;
      }
    }
    // One large frame may start immediately; subsequent frames must fit the waiting budget.
    if (this.sending && (this.queuedBytes + bytes > (this.options.maxQueuedBytes ?? 32 * 1024 * 1024)
      || this.queue.length >= (this.options.maxQueuedFrames ?? 256))) {
      this.fail("outbound queue limit", bytes); return;
    }
    this.queue.push({ texts, bytes, ...(snapshot !== undefined ? { snapshot } : {}) }); this.queuedBytes += bytes;
    this.pump();
  }

  private pump(): void {
    if (this.stopped || this.sending || this.socket.readyState !== 1) return;
    if (!this.active) {
      const entry = this.queue.shift();
      if (!entry) { this.options.busy?.(false); return; }
      this.queuedBytes -= entry.bytes;
      this.active = entry.texts[Symbol.iterator]();
    }
    const next = this.active.next();
    if (next.done) { this.active = undefined; this.pump(); return; }
    const text = next.value;
    this.lastFrameBytes = Buffer.byteLength(text);
    this.sending = true; this.options.busy?.(true);
    this.timer = setTimeout(() => this.fail("outbound send timeout"), this.options.sendTimeoutMs ?? 30_000);
    this.timer.unref();
    try {
      this.socket.send(text, error => {
        if (this.stopped) return;
        clearTimeout(this.timer); this.timer = undefined;
        if (error) { this.fail("outbound send failed"); return; }
        this.sentFrames++; this.sending = false;
        this.pump();
      });
      this.peakBufferedBytes = Math.max(this.peakBufferedBytes, this.socket.bufferedAmount);
    } catch { this.fail("outbound send failed"); }
  }

  private fail(reason: string, rejectedFrameBytes = 0): void {
    if (this.stopped) return;
    this.localCloseReason = reason;
    this.options.trace?.({ event: "overload", at: this.options.label, ...this.stats(), rejectedFrameBytes });
    this.dispose();
    // A stalled TCP stream might not deliver the close handshake. The explicit local reason
    // above survives even if the eventual peer close code is 1006.
    this.socket.close(1013, "Client is too far behind; reconnect");
    this.closeTimer = setTimeout(() => this.socket.terminate(), this.options.closeTimeoutMs ?? 5_000);
    this.closeTimer.unref();
  }

  dispose(options: { preserveCloseTimeout?: boolean } = {}): void {
    this.stopped = true; clearTimeout(this.timer);
    if (!options.preserveCloseTimeout) clearTimeout(this.closeTimer);
    this.queue = []; this.queuedBytes = 0; this.active = undefined;
  }
}
