import type { HarnessAdapter } from "@arke-studio/contracts";

/** Host-only lifecycle facts; no renderer-supplied paths, commands or turn authority. */
export interface HarnessRecoveryOwner {
  ownership: "managed" | "external";
  componentDigest(): string;
  reserve(signal: AbortSignal): Promise<() => void>;
}

/** Completion, rather than async admission, bounds a writing turn. Coordinator's async
 * dispatch wrapper calls sendMessage too, so cloud and local turns share this fence. */
export class HarnessRuntimeChanges {
  private active = 0;
  private changing = false;
  private recoveryWaiting = false;
  private recoveryHeld = false;
  private readonly idle = new Set<() => void>();
  private changed(): void { for (const listener of this.idle) listener(); }

  wrap<T extends HarnessAdapter>(adapter: T): T {
    const privateCompletion = new Map<string, Promise<void>>();
    return new Proxy(adapter, { get: (target, property) => {
      if (property === "createSession") return async (input: Parameters<HarnessAdapter["createSession"]>[0]) => {
        const session = await target.createSession(input);
        if (input.visibility === "private") {
          if (!session.privateTurnSettled) throw new Error("The private session has no native completion proof.");
          privateCompletion.set(session.sessionId, session.privateTurnSettled);
        }
        return session;
      };
      if (property === "sendMessage" || property === "sendMessageWithFence") return async (input: Parameters<HarnessAdapter["sendMessage"]>[0], beforeDispatch?: () => void) => {
        if (this.changing || this.recoveryWaiting || this.recoveryHeld) throw new Error("Writing runtime settings are changing or recovering. Try again shortly.");
        this.active++;
        const completion = privateCompletion.get(input.sessionId);
        let dispatched = false, confirmed = false;
        try {
          let receipt: Awaited<ReturnType<HarnessAdapter["sendMessage"]>> | undefined, failure: unknown, failed = false;
          const dispatch = () => { beforeDispatch?.(); dispatched = true; };
          try {
            if (target.sendMessageWithFence) receipt = await target.sendMessageWithFence(input, dispatch);
            else { dispatch(); receipt = await target.sendMessage(input); }
          } catch (error) { failed = true; failure = error; }
          // A settled private HTTP/SDK call is not proof that its backing inference stopped.
          // Settings/recovery keep their admitted owner until the same native turn completes.
          if (completion && dispatched) { await completion; confirmed = true; }
          if (failed) throw failure;
          return receipt!;
        }
        finally { if (!completion || !dispatched || confirmed) { this.active--; this.changed(); } }
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active > 0 || this.changing || this.recoveryWaiting || this.recoveryHeld) throw new Error("Finish or cancel writing before changing the Ollama runtime.");
    this.changing = true;
    try { return await work(); }
    finally { this.changing = false; this.changed(); }
  }

  /** One cancellable recovery reservation waits for completion of admitted cloud/local turns.
   * It closes new admission while waiting and never replays or interrupts the old turn. */
  async reserveRecovery(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw signal.reason ?? new Error("Writing recovery cancelled.");
    if (this.recoveryWaiting || this.recoveryHeld) throw new Error("Writing recovery is already reserved.");
    this.recoveryWaiting = true;
    try {
      await new Promise<void>((resolve, reject) => {
        const done = (error?: unknown) => { this.idle.delete(check); signal.removeEventListener("abort", abort); error ? reject(error) : resolve(); };
        const check = () => { if (this.active === 0 && !this.changing) done(); };
        const abort = () => done(signal.reason ?? new Error("Writing recovery cancelled."));
        this.idle.add(check); signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort(); else check();
      });
      if (signal.aborted) throw signal.reason ?? new Error("Writing recovery cancelled.");
      this.recoveryWaiting = false; this.recoveryHeld = true;
      let released = false;
      return () => { if (released) return; released = true; this.recoveryHeld = false; this.changed(); };
    } catch (error) { this.recoveryWaiting = false; this.changed(); throw error; }
  }
}
