/**
 * What the harness adapters share for their event streams and session preparations (#2824): pure
 * helpers, no I/O, so a delivery fix — registration, abort, disposal — is made once rather than in
 * each adapter. The transports differ on purpose (an in-process query per session, one JSON-RPC
 * child, a supervised HTTP server); these sit above all of that.
 */

/** A queue one consumer drains with `for await`: what was pushed arrives in order, and after
 * `close`, what was already queued still arrives before it ends. */
export class AsyncQueue<T> {
  private readonly items: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | null = null;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiting;
    if (waiter) {
      this.waiting = null;
      waiter({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  close(): void {
    this.closed = true;
    const waiter = this.waiting;
    if (waiter) {
      this.waiting = null;
      waiter({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () =>
        new Promise<IteratorResult<T>>((resolve) => {
          if (this.items.length > 0) return resolve({ value: this.items.shift()!, done: false });
          if (this.closed) return resolve({ value: undefined as never, done: true });
          this.waiting = resolve;
        }),
    };
  }
}

/** Every event to every listener. */
export class HarnessEventHub<T> {
  private readonly listeners = new Set<AsyncQueue<T>>();
  private closed = false;

  /**
   * A listener is registered when this is called, not at its first pull, so an event emitted
   * between a dispatch and the consumer's first `next()` is not lost. It ends when its signal
   * aborts or the hub closes, after what was already queued; one subscribed to a closed hub, or
   * with a signal already aborted, ends at once.
   */
  subscribe(signal?: AbortSignal): AsyncIterable<T> {
    const queue = new AsyncQueue<T>();
    if (this.closed || signal?.aborted) queue.close();
    else this.listeners.add(queue);
    const stop = () => queue.close();
    signal?.addEventListener("abort", stop, { once: true });
    const listeners = this.listeners;
    return (async function* () {
      try {
        yield* queue;
      } finally {
        listeners.delete(queue);
        signal?.removeEventListener("abort", stop);
      }
    })();
  }

  emit(event: T): void {
    for (const listener of this.listeners) listener.push(event);
  }

  /** Every listener ends, and later ones end at once: the adapter is gone. */
  close(): void {
    this.closed = true;
    for (const listener of this.listeners) listener.close();
    this.listeners.clear();
  }
}

/** Session settings handed over before `createSession`, each under a token used once. */
export class PreparationTable<T> {
  private readonly pending = new Map<string, T>();

  /** Kept as it was handed over: a caller that changes its object afterwards changes nothing. */
  prepare(id: string | undefined, input: T): void {
    if (id === undefined) return;
    if (this.pending.has(id)) throw new Error("Session preparation token is already in use.");
    this.pending.set(id, structuredClone(input));
  }

  abandon(id: string): void {
    this.pending.delete(id);
  }

  /** The preparation, removed so no second session can use it. No token, no preparation. */
  take(id: string | undefined): Partial<T> {
    if (id === undefined) return {};
    const prepared = this.pending.get(id);
    this.pending.delete(id);
    if (prepared === undefined) throw new Error("Session preparation is missing or was already consumed.");
    return prepared;
  }

  clear(): void {
    this.pending.clear();
  }
}
