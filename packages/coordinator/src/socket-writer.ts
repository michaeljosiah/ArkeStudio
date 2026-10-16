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

/** Ordered delivery with bounded memory. Never discard an event to make room for a snapshot:
 * transient permissions and command replies cannot be reconstructed from that snapshot. */
export class SocketWriter {
  private queue: string[] = [];
  private queuedBytes = 0;
  private sending = false;
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
      peakBufferedBytes: this.peakBufferedBytes, sentFrames: this.sentFrames, localCloseReason: this.localCloseReason };
  }

  send(text: string): void {
    if (this.stopped || this.socket.readyState !== 1) return;
    const bytes = Buffer.byteLength(text);
    if (bytes > (this.options.maxFrameBytes ?? 100 * 1024 * 1024)) {
      this.fail("outbound frame limit", bytes); return;
    }
    // One large frame may start immediately; subsequent frames must fit the waiting budget.
    if (this.sending && (this.queuedBytes + bytes > (this.options.maxQueuedBytes ?? 32 * 1024 * 1024)
      || this.queue.length >= (this.options.maxQueuedFrames ?? 256))) {
      this.fail("outbound queue limit", bytes); return;
    }
    this.queue.push(text); this.queuedBytes += bytes;
    this.pump();
  }

  private pump(): void {
    if (this.stopped || this.sending || !this.queue.length || this.socket.readyState !== 1) return;
    const text = this.queue.shift()!;
    this.lastFrameBytes = Buffer.byteLength(text); this.queuedBytes -= this.lastFrameBytes;
    this.sending = true; this.options.busy?.(true);
    this.timer = setTimeout(() => this.fail("outbound send timeout"), this.options.sendTimeoutMs ?? 30_000);
    this.timer.unref();
    try {
      this.socket.send(text, error => {
        if (this.stopped) return;
        clearTimeout(this.timer); this.timer = undefined;
        if (error) { this.fail("outbound send failed"); return; }
        this.sentFrames++; this.sending = false;
        if (this.queue.length) this.pump(); else this.options.busy?.(false);
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
    this.queue = []; this.queuedBytes = 0;
  }
}
