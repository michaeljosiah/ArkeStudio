/** One graphics card shared by the local inference workers (SPEC-033, issue 984). */
export type LocalGpuEngine = "Ollama" | "ComfyUI" | "Ming";

interface WaitingTurn {
  engine: LocalGpuEngine;
  signal: AbortSignal;
  waiting: (reason: string | null) => void;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  abort: () => void;
}

export class LocalGpu {
  private owner: LocalGpuEngine | null = null;
  private readonly queue: WaitingTurn[] = [];
  private readonly stopped = new AbortController();
  private readonly ran = new Set<LocalGpuEngine>();

  constructor(
    private readonly unload: (engine: LocalGpuEngine, signal: AbortSignal) => Promise<void>,
    private readonly engines: readonly LocalGpuEngine[] = ["Ollama", "ComfyUI"],
  ) {}

  acquire(engine: LocalGpuEngine, signal: AbortSignal, waiting: (reason: string | null) => void = () => {}): Promise<() => void> {
    if (!this.engines.includes(engine)) return Promise.reject(new Error(`${engine} is not registered for local inference.`));
    const combined = AbortSignal.any([signal, this.stopped.signal]);
    if (combined.aborted) return Promise.reject(combined.reason);
    return new Promise((resolve, reject) => {
      const turn: WaitingTurn = { engine, signal: combined, waiting, resolve, reject, abort: () => {
        const index = this.queue.indexOf(turn);
        if (index < 0) return;
        this.queue.splice(index, 1);
        waiting(null);
        reject(combined.reason);
      } };
      combined.addEventListener("abort", turn.abort, { once: true });
      this.queue.push(turn);
      this.pump();
    });
  }

  private pump(): void {
    if (this.stopped.signal.aborted) return;
    if (this.owner !== null) {
      for (const turn of this.queue) turn.waiting(`Waiting for the graphics card: ${this.owner}`);
      return;
    }
    const turn = this.queue.shift();
    if (!turn) return;
    turn.signal.removeEventListener("abort", turn.abort);
    this.owner = turn.engine;
    turn.waiting(null);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.owner = null;
      this.pump();
    };
    this.pump();
    // Own the card during unloading too: another submit must not race the handover.
    void Promise.resolve().then(async () => {
      for (const engine of this.engines) {
        turn.signal.throwIfAborted();
        if (engine !== turn.engine) await this.unload(engine, turn.signal);
      }
    }).then(() => {
      if (turn.signal.aborted) { release(); turn.reject(turn.signal.reason); }
      else { this.ran.add(turn.engine); turn.resolve(release); }
    }, (error) => { release(); turn.reject(error); });
  }

  /** Whether this engine was handed the card at least once in this run: shutdown's claim on it. */
  hasRun(engine: LocalGpuEngine): boolean { return this.ran.has(engine); }
  isBusy(engine: LocalGpuEngine): boolean { return this.owner === engine || this.queue.some(turn => turn.engine === engine); }

  /** A Python batch may retain its weights between chunks, but never beyond confirmed cleanup. */
  async runMingBatch<T>(
    work: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
    waiting?: (reason: string | null) => void,
  ): Promise<T> {
    const combined = AbortSignal.any([signal, this.stopped.signal]);
    const release = await this.acquire("Ming", combined, waiting);
    try { return await work(combined); }
    finally {
      // Cancellation must not cancel cleanup. A rejected cleanup deliberately retains the
      // reservation: another worker cannot safely start while this process might still live.
      await this.unload("Ming", AbortSignal.timeout(30_000));
      release();
    }
  }

  stop(): void { this.stopped.abort(new Error("Local inference is stopping.")); }
}
