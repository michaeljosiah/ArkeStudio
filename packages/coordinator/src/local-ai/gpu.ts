import type { ComfyUiStatus, RecipeReadiness } from "@arke-studio/contracts";

/** One graphics card shared by the two local inference engines (SPEC-033, issue 984). */
export type LocalGpuEngine = "Ollama" | "ComfyUI";

export function memoryWait(recipe: RecipeReadiness): boolean {
  return recipe.reasonKind === "vram-busy" || recipe.reasonKind === "memory-busy";
}

/** Preserve the measured fit; transient contention is handled after queue admission. */
export function queueableLocalMemory(status: ComfyUiStatus): ComfyUiStatus {
  if (status.engine.locality !== "local") return status;
  return { ...status, recipes: status.recipes.map((recipe) => memoryWait(recipe)
    ? { ...recipe, state: "ready", reason: "Memory will be checked when the graphics card is available.", reasonKind: undefined }
    : recipe) };
}

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

  constructor(private readonly unload: (engine: LocalGpuEngine, signal: AbortSignal) => Promise<void>) {}

  acquire(engine: LocalGpuEngine, signal: AbortSignal, waiting: (reason: string | null) => void = () => {}): Promise<() => void> {
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
    void Promise.resolve().then(() => this.unload(turn.engine === "Ollama" ? "ComfyUI" : "Ollama", turn.signal)).then(() => {
      if (turn.signal.aborted) { release(); turn.reject(turn.signal.reason); }
      else turn.resolve(release);
    }, (error) => { release(); turn.reject(error); });
  }

  stop(): void { this.stopped.abort(new Error("Local inference is stopping.")); }
}
