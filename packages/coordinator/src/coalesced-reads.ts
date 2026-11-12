/** A read that passed its deadline: what it was doing then, and for how long it had run. */
export class ReadStalledError extends Error {
  constructor(readonly stage: string, readonly elapsedMs: number) {
    super(`stalled for ${Math.round(elapsedMs / 1000)} s ${stage}`);
    this.name = "ReadStalledError";
  }
}

/** What a read is told: when to stop, and where to say it has got to, for the stall's message. */
export interface ReadTurn {
  signal: AbortSignal;
  stage(what: string): void;
}

interface Waiting<T> {
  read: (turn: ReadTurn) => Promise<T>;
  askers: Array<{ resolve(value: T): void; reject(error: unknown): void }>;
}

/**
 * Reads asked for again and again while one is running, made one at a time (2026-10-24).
 *
 * On a 26-chapter book `audiobookListening` is about five seconds of the coordinator's one
 * thread. Every window that shows the book asked for it again on every picture landed and every
 * record changed, without waiting for the last answer, and the coordinator started each at once:
 * on a loop already busy with a long picture run they shared the thread round-robin, each took
 * longer than the gap between asks, and from then on none finished — no answer, no failure, for
 * as long as the run went on.
 *
 * So per key at most one read runs and one waits. An ask made while a read runs joins the waiting
 * one, which starts when the running one ends, so every answer is from a read that began after
 * its ask. A read past its deadline is answered as stalled, told to stop, and no longer holds its
 * key: a read that never ends cannot hold the asks behind it.
 */
export class CoalescedReads<T> {
  private readonly keys = new Map<string, Waiting<T> | null>();

  constructor(private readonly deadlineMs: number) {}

  /** Reads running or waiting, for a test or a log to look at. */
  get size(): number {
    return this.keys.size;
  }

  ask(key: string, read: (turn: ReadTurn) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const asker = { resolve, reject };
      if (!this.keys.has(key)) {
        this.keys.set(key, null);
        this.start(key, { read, askers: [asker] });
        return;
      }
      const waiting = this.keys.get(key) ?? { read, askers: [] };
      // The latest ask's read is the one run: each is the same read, and it is the freshest.
      waiting.read = read;
      waiting.askers.push(asker);
      this.keys.set(key, waiting);
    });
  }

  private start(key: string, turn: Waiting<T>): void {
    const control = new AbortController();
    const started = Date.now();
    let stage = "starting";
    let settled = false;
    const finish = (outcome: { ok: true; value: T } | { ok: false; error: unknown }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const asker of turn.askers) {
        if (outcome.ok) asker.resolve(outcome.value);
        else asker.reject(outcome.error);
      }
      const next = this.keys.get(key);
      if (next) {
        this.keys.set(key, null);
        this.start(key, next);
      } else this.keys.delete(key);
    };
    // Refed, and cleared in `finish`: a read stuck behind a world that never comes awaits nothing
    // the loop can see, so an unref'd deadline let the loop drain before it fired and the ask was
    // never answered — on Node 22 the test runner cancelled the book-read tests outright on Windows
    // CI. See ArtifactModel for the same lesson.
    const timer = setTimeout(() => {
      const error = new ReadStalledError(stage, Date.now() - started);
      control.abort(error);
      finish({ ok: false, error });
    }, this.deadlineMs);
    let reading: Promise<T>;
    try {
      reading = turn.read({ signal: control.signal, stage: (what) => { stage = what; } });
    } catch (error) {
      reading = Promise.reject(error);
    }
    reading.then((value) => finish({ ok: true, value }), (error: unknown) => finish({ ok: false, error }));
  }
}
