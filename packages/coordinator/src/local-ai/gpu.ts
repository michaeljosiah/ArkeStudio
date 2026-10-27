/** One graphics card shared by the local inference workers (SPEC-033, issue 984). */
export type LocalGpuEngine = "Ollama" | "ComfyUI" | "Ming";

interface WaitingTurn {
  engine: LocalGpuEngine;
  priority: "normal" | "background";
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
  private retainedMing: (() => void) | null = null;
  private mingCleanup: Promise<void> | null = null;
  private mingRevision = 0;
  private mingConfirmed: number | null = null;
  private readonly mingListeners = new Set<() => void>();

  mingCleanupState(): { state: "unavailable" | "working" | "idle" | "held" | "checking"; revision: number; confirmed: number | null; waiting: number } {
    return { state: !this.engines.includes("Ming") ? "unavailable" : this.retainedMing ? this.mingCleanup ? "checking" : "held" : this.owner === "Ming" ? "working" : "idle",
      revision: this.mingRevision, confirmed: this.mingConfirmed, waiting: this.retainedMing ? this.queue.length : 0 };
  }
  subscribeMingCleanup(listener: () => void): () => void { this.mingListeners.add(listener); return () => { this.mingListeners.delete(listener); }; }
  private mingChanged(): void { for (const listener of this.mingListeners) try { listener(); } catch { /* Observation grants no GPU authority. */ } }
  prepareMingCleanup(): { revision: number; current(): boolean; run(signal: AbortSignal, allowed: () => boolean): Promise<"verified" | "refused" | "unknown"> } | null {
    const held = this.retainedMing, revision = this.mingRevision;
    if (!held || this.mingCleanup || this.stopped.signal.aborted) return null;
    const current = () => !this.stopped.signal.aborted && this.retainedMing === held && this.mingRevision === revision;
    return { revision, current, run: async (signal, allowed) => {
      if (signal.aborted || !current() || !allowed()) return "refused";
      try { await this.confirmMingCleanup(signal); return this.retainedMing !== held ? "verified" : "unknown"; }
      catch { return "unknown"; }
    } };
  }

  constructor(
    private readonly unload: (engine: LocalGpuEngine, signal: AbortSignal) => Promise<void>,
    private readonly engines: readonly LocalGpuEngine[] = ["Ollama", "ComfyUI"],
  ) {}

  acquire(engine: LocalGpuEngine, signal: AbortSignal, waiting: (reason: string | null) => void = () => {}, priority: "normal" | "background" = "normal"): Promise<() => void> {
    if (!this.engines.includes(engine)) return Promise.reject(new Error(`${engine} is not registered for local inference.`));
    const combined = AbortSignal.any([signal, this.stopped.signal]);
    if (combined.aborted) return Promise.reject(combined.reason);
    return new Promise((resolve, reject) => {
      const turn: WaitingTurn = { engine, priority, signal: combined, waiting, resolve, reject, abort: () => {
        const index = this.queue.indexOf(turn);
        if (index < 0) return;
        this.queue.splice(index, 1);
        this.mingChanged();
        waiting(null);
        reject(combined.reason);
      } };
      combined.addEventListener("abort", turn.abort, { once: true });
      const background = priority === "normal" ? this.queue.findIndex(value => value.priority === "background") : -1;
      if (background < 0) this.queue.push(turn); else this.queue.splice(background, 0, turn);
      this.mingChanged();
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
    this.mingChanged();
    turn.waiting(null);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.owner = null;
      this.mingChanged();
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

  private async settleMingBatch(release: () => void): Promise<void> {
    try { await this.unload("Ming", AbortSignal.timeout(30_000)); }
    catch (error) { this.retainedMing = release; this.mingRevision++; this.mingChanged(); throw error; }
    release();
  }

  /** Retry only the settled batch owner's cleanup. No inference or old request is replayed.
   * A failed confirmation keeps the exact retained lease and all queued engines held. */
  confirmMingCleanup(signal: AbortSignal): Promise<void> {
    if (this.mingCleanup) return this.mingCleanup;
    const held = this.retainedMing;
    if (!held) return Promise.resolve();
    this.mingCleanup = (async () => {
      await this.unload("Ming", signal);
      if (this.retainedMing === held) { this.mingConfirmed = this.mingRevision; this.retainedMing = null; held(); }
    })().finally(() => { this.mingCleanup = null; this.mingChanged(); });
    this.mingChanged();
    return this.mingCleanup;
  }

  /** A Python batch may retain its weights between chunks, but never beyond confirmed cleanup. */
  async runMingBatch<T>(
    work: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
    waiting?: (reason: string | null) => void,
  ): Promise<T> {
    const combined = AbortSignal.any([signal, this.stopped.signal]);
    // A newly authorized reading may confirm the old settled worker's cleanup first;
    // it cannot silently regenerate the previous reading or release a possibly live child.
    combined.throwIfAborted(); await this.confirmMingCleanup(combined);
    const release = await this.acquire("Ming", combined, waiting);
    try { return await work(combined); }
    finally {
      // Cancellation must not cancel cleanup. A rejected cleanup deliberately retains the
      // reservation: another worker cannot safely start while this process might still live.
      await this.settleMingBatch(release);
    }
  }

  stop(): void { this.stopped.abort(new Error("Local inference is stopping.")); this.mingChanged(); }
}
