import { cpus, freemem, totalmem, type CpuInfo } from "node:os";
import { setTimeout as pause } from "node:timers/promises";
import { SystemResourcesSchema, unavailableSystemResources, type GpuMeasurement, type SystemResources } from "@arke-studio/contracts";

export type SystemResourceProbe = (signal: AbortSignal) => Promise<SystemResources>;

export function cpuUtilisation(before: readonly CpuInfo[], after: readonly CpuInfo[]): number | null {
  if (!before.length || before.length !== after.length) return null;
  let idle = 0, total = 0;
  for (let index = 0; index < before.length; index++) {
    const a = before[index]!.times, b = after[index]!.times;
    for (const key of ["user", "nice", "sys", "idle", "irq"] as const) {
      const delta = b[key] - a[key];
      if (!Number.isFinite(delta) || delta < 0) return null;
      total += delta; if (key === "idle") idle += delta;
    }
  }
  return total > 0 ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : null;
}

/** A short host sample, never renderer hardware. GPU probing is supplied by the native host. */
export function createNodeSystemResourceProbe(deps: {
  cpu?: typeof cpus; free?: () => number; total?: () => number; now?: () => number;
  wait?: (signal: AbortSignal) => Promise<void>;
  gpu?: (signal: AbortSignal) => Promise<GpuMeasurement>;
  mingRunning?: () => boolean;
} = {}): SystemResourceProbe {
  const now = deps.now ?? Date.now;
  return async signal => {
    const result = unavailableSystemResources(now());
    const gpu = deps.gpu?.(signal).catch(() => ({ ...result.gpu, state: "unavailable" as const }));
    try {
      const before = (deps.cpu ?? cpus)();
      await (deps.wait?.(signal) ?? pause(250, undefined, { signal }));
      signal.throwIfAborted();
      const value = cpuUtilisation(before, (deps.cpu ?? cpus)());
      if (value !== null) result.cpu = { source: "node-os", state: "measured", measuredAt: now(), value };
    } catch { /* A failed sample remains unknown; never zero. */ }
    if (!signal.aborted) {
      try {
        const totalBytes = (deps.total ?? totalmem)(), freeBytes = (deps.free ?? freemem)();
        if (Number.isSafeInteger(totalBytes) && totalBytes > 0 && Number.isSafeInteger(freeBytes) && freeBytes >= 0 && freeBytes <= totalBytes) {
          result.memory = { source: "node-os", state: "measured", measuredAt: now(), value: { usedBytes: totalBytes - freeBytes, totalBytes } };
        }
      } catch { /* OS memory probe unavailable. */ }
      if (deps.mingRunning) {
        try { result.ming = { source: "host-owner", state: "measured", measuredAt: now(), value: deps.mingRunning() }; }
        catch { /* Reading a lifecycle owner does not start or repair it. */ }
      }
    }
    if (gpu) result.gpu = await gpu;
    signal.throwIfAborted(); result.at = now();
    return SystemResourcesSchema.parse(result);
  };
}

/** On-demand, coalesced, ephemeral observations. No background timer, disk journal or model. */
export class SystemResourceService {
  private readonly lifetime = new AbortController();
  private readonly listeners = new Set<(snapshot: SystemResources) => void>();
  private pending: Promise<void> | null = null;
  // Retained until the host confirms completion, even if the observation wait times out.
  private native: Promise<SystemResources> | null = null;
  private lastAttempt = -Infinity;
  private snapshot: SystemResources | null = null;
  constructor(private readonly probe: SystemResourceProbe = createNodeSystemResourceProbe(), private readonly now = Date.now,
    private readonly limits = { observationMs: 8_000, shutdownMs: 250 }) {}
  subscribe(listener: (snapshot: SystemResources) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  current(): SystemResources | null { return this.snapshot; }
  refresh(): Promise<void> {
    if (this.lifetime.signal.aborted) return Promise.resolve();
    if (this.pending) return this.pending;
    if (this.native) return Promise.resolve(); // An unconfirmed native read is not permission to start another.
    const sinceAttempt = this.now() - this.lastAttempt;
    if (sinceAttempt >= 0 && sinceAttempt < 1_000) return Promise.resolve();
    this.lastAttempt = this.now();
    const attempt = new AbortController();
    const signal = AbortSignal.any([attempt.signal, this.lifetime.signal]);
    const native = Promise.resolve().then(() => this.probe(signal)); this.native = native;
    void native.then(() => { if (this.native === native) this.native = null; }, () => { if (this.native === native) this.native = null; });
    this.pending = (async () => {
      let next: SystemResources;
      let timer: ReturnType<typeof setTimeout> | undefined, abort!: () => void;
      try {
        const observed = await new Promise<SystemResources | null>(resolve => {
          abort = () => { attempt.abort(); resolve(null); };
          this.lifetime.signal.addEventListener("abort", abort, { once: true });
          timer = setTimeout(abort, this.limits.observationMs);
          void native.then(value => resolve(value), () => resolve(null));
          if (this.lifetime.signal.aborted) abort();
        });
        next = SystemResourcesSchema.parse(observed ?? unavailableSystemResources(this.now()));
      } catch { next = unavailableSystemResources(this.now()); }
      finally { clearTimeout(timer); this.lifetime.signal.removeEventListener("abort", abort); }
      if (this.lifetime.signal.aborted) return;
      // Keep an old value only with its old measurement time and explicit failed state.
      for (const key of ["cpu", "memory", "gpu", "ming"] as const) {
        const previous = this.snapshot?.[key];
        if (next[key].value === null && previous?.value !== null && previous?.value !== undefined) {
          Object.assign(next[key], { value: previous.value, measuredAt: previous.measuredAt });
        }
      }
      this.snapshot = next;
      for (const listener of this.listeners) { try { listener(next); } catch { /* A view cannot break collection. */ } }
    })().finally(() => { this.pending = null; });
    return this.pending;
  }
  async stop(): Promise<void> {
    this.listeners.clear(); this.lifetime.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.pending, new Promise<void>(resolve => { timer = setTimeout(resolve, this.limits.shutdownMs); })]); }
    finally { clearTimeout(timer); }
    // `native` stays owned here until actual settlement. Timeout is no claim of process exit.
  }
}
