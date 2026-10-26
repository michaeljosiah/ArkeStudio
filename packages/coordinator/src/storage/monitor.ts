import { z } from "zod";
import { advanceStoragePressure, forecastStorage, StorageCapacitySchema, StorageHealthSnapshotSchema, StorageLimitationSchema, StorageProbeSourceSchema, StorageRootRoleSchema, STORAGE_POLICY,
  type StorageCapacity, type StorageHealthSnapshot, type StoragePressure, type StorageRootHealth } from "@arke-studio/contracts";

const key = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const rootsSchema = z.array(z.object({ rootId: key, role: StorageRootRoleSchema, revision: key }).strict()).max(128)
  .refine(roots => new Set(roots.map(root => root.rootId)).size === roots.length, "Repeated storage root");
export type StorageMonitoredRoot = z.infer<typeof rootsSchema>[number];
export const StorageProbeResultSchema = z.object({
  capacity: StorageCapacitySchema.nullable(), source: StorageProbeSourceSchema,
  state: z.enum(["measured", "unavailable", "unsupported"]), limitations: z.array(StorageLimitationSchema).max(5),
}).strict().refine(result => (result.state === "measured") === (result.capacity !== null), "Storage probe state and capacity disagree");
export type StorageProbeResult = z.infer<typeof StorageProbeResultSchema>;
interface Reading {
  result: StorageProbeResult;
  samples: StorageCapacity[];
  pressure: StoragePressure | null;
  attemptedAt: number;
  minimumAfter: number;
}
const missing = (): StorageProbeResult => ({ state: "unavailable", source: "host-provided", limitations: ["probe-failed"], capacity: null });

/** Scoped observation for SPEC-062 R-1–R-5. Paths stay in the host's probe registry.
 * The monitor never scans directories, makes cleanup decisions or changes operation authority. */
export class StorageMonitor {
  private roots: StorageMonitoredRoot[] = [];
  private readings = new Map<string, Reading>();
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private batch: Promise<void> | null = null;
  private batchAbort: AbortController | null = null;
  private version = 0;
  private capacityVersion = 0;
  private writing = false;
  private started = false;
  private stopped = false;
  private readonly admissionStopped = new AbortController();

  constructor(private readonly deps: {
    /** Bounded and cancellable. The platform port owns any outstanding native read handles. */
    probe(rootId: string, signal: AbortSignal, after?: number): Promise<StorageProbeResult>;
    onSnapshot(snapshot: StorageHealthSnapshot): void;
    now?: () => number;
    initialPressure?: Readonly<Record<string, StoragePressure>>;
  }) {}
  private now(): number { return (this.deps.now ?? Date.now)(); }
  /** Invalidations and root changes revoke facts already captured by an admission writer. */
  admissionEpoch(): number { return this.capacityVersion; }
  currentCapacity(rootId: string, captured: StorageCapacity): boolean {
    const current = this.readings.get(rootId)?.result.capacity;
    return !!current && current.volumeId === captured.volumeId && current.mappingRevision === captured.mappingRevision
      && current.measuredAt >= captured.measuredAt && current.availableBytes !== null && captured.availableBytes !== null && current.availableBytes >= captured.availableBytes;
  }

  setRoots(roots: readonly StorageMonitoredRoot[]): void {
    const next = rootsSchema.parse(roots);
    if (this.stopped || JSON.stringify(next) === JSON.stringify(this.roots)) return;
    const before = new Map(this.roots.map(root => [root.rootId, root]));
    this.roots = next; this.version++; this.capacityVersion++; this.batchAbort?.abort();
    const retained = new Map<string, Reading>();
    for (const root of next) {
      const old = before.get(root.rootId), value = this.readings.get(root.rootId);
      retained.set(root.rootId, old?.revision === root.revision && value ? value : {
        result: missing(), samples: [], pressure: value?.pressure ?? this.deps.initialPressure?.[root.rootId] ?? null, attemptedAt: -Infinity, minimumAfter: old ? this.now() : -Infinity,
      });
    }
    this.readings = retained;
    this.pending = new Set([...this.pending].filter(id => retained.has(id)));
    for (const root of next) if (before.get(root.rootId)?.revision !== root.revision) this.pending.add(root.rootId);
    this.publish();
    if (this.started) void this.refresh();
  }

  async start(): Promise<void> {
    if (this.stopped) return;
    this.started = true; await this.refresh();
  }
  setWriting(writing: boolean): void {
    if (this.stopped || this.writing === writing) return;
    this.writing = writing;
    if (this.started) this.reschedule();
  }

  /** Wake discards the rate window and invalidates facts before any new decision can read them. */
  wake(): Promise<void> {
    this.version++; this.capacityVersion++; this.batchAbort?.abort();
    for (const [id, reading] of this.readings) {
      reading.result = { ...reading.result, capacity: null, state: "unavailable" };
      reading.minimumAfter = Math.max(reading.minimumAfter, this.now());
      reading.samples = []; this.pending.add(id);
    }
    this.publish();
    return this.refresh();
  }

  /** An ENOSPC/quota hint invalidates the affected fact now and coalesces its next probe. */
  invalidate(rootId: string): void {
    const reading = this.readings.get(rootId);
    if (!reading || this.stopped) return;
    this.version++; this.capacityVersion++; this.batchAbort?.abort(); this.pending.add(rootId);
    reading.result = { ...reading.result, state: "unavailable", capacity: null };
    reading.minimumAfter = Math.max(reading.minimumAfter, this.now());
    reading.samples = [];
    this.publish();
    if (this.started) this.reschedule();
  }

  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.batch) return this.batch;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const version = this.version, control = new AbortController(); this.batchAbort = control;
    const roots = this.roots.filter(root => {
      const age = this.now() - this.readings.get(root.rootId)!.attemptedAt;
      return age >= 1_000 || age < 0;
    });
    let cursor = 0;
    this.batch = Promise.all(Array.from({ length: Math.min(4, roots.length) }, async () => {
      while (cursor < roots.length && !control.signal.aborted) {
        const root = roots[cursor++]!, reading = this.readings.get(root.rootId)!;
        this.pending.delete(root.rootId);
        reading.attemptedAt = this.now();
        let result: StorageProbeResult;
        try { result = StorageProbeResultSchema.parse(await this.deps.probe(root.rootId, control.signal, Number.isFinite(reading.minimumAfter) ? reading.minimumAfter : undefined)); }
        catch { result = missing(); }
        if (this.stopped || control.signal.aborted || version !== this.version) {
          if (this.readings.get(root.rootId) === reading) this.pending.add(root.rootId);
          continue;
        }
        if (result.capacity && result.capacity.measuredAt <= reading.minimumAfter) result = missing();
        const previous = reading.result.capacity;
        if (previous && result.capacity && result.capacity.measuredAt < previous.measuredAt && previous.measuredAt <= this.now()) {
          // A host cache may finish after a newer read. It cannot replace that evidence or
          // reset the rate window; a conflicting older mapping remains explicitly unknown.
          if (result.capacity.volumeId === previous.volumeId && result.capacity.mappingRevision === previous.mappingRevision) continue;
          result = missing();
        }
        if (previous && (!result.capacity || previous.volumeId !== result.capacity.volumeId || previous.mappingRevision !== result.capacity.mappingRevision
          || result.capacity.availableBytes === null || previous.availableBytes !== null && result.capacity.availableBytes < previous.availableBytes)) this.capacityVersion++;
        reading.result = result;
        const sample = result.capacity;
        if (sample) {
          const last = reading.samples.at(-1);
          if (last && (last.volumeId !== sample.volumeId || last.mappingRevision !== sample.mappingRevision || sample.measuredAt < last.measuredAt)) reading.samples = [];
          if (!reading.samples.length || sample.measuredAt > reading.samples.at(-1)!.measuredAt) reading.samples.push(sample);
          reading.samples = reading.samples.filter(value => this.now() - value.measuredAt <= STORAGE_POLICY.forecastWindowMs).slice(-512);
          const forecast = forecastStorage(reading.samples, this.now());
          reading.pressure = advanceStoragePressure(reading.pressure, sample, this.now(), forecast?.warning ?? false) ?? reading.pressure;
        } else reading.samples = [];
      }
    })).then(() => { if (!this.stopped && version === this.version) this.publish(); }).finally(() => {
      this.batch = null; this.batchAbort = null;
      if (!this.stopped && this.started) this.reschedule();
    });
    return this.batch;
  }

  /** Admission reads refresh stale facts, then the reservation owner checks all ages again. */
  async capacity(rootId: string, signal: AbortSignal, after = -Infinity): Promise<StorageCapacity | null> {
    if (this.stopped || signal.aborted || !this.readings.has(rootId)) return null;
    const reading = this.readings.get(rootId)!;
    reading.minimumAfter = Math.max(reading.minimumAfter, after);
    const bounded = AbortSignal.any([signal, this.admissionStopped.signal, AbortSignal.timeout(16_000)]);
    const wait = (work: Promise<unknown>) => new Promise<void>(resolve => {
      const done = () => { bounded.removeEventListener("abort", done); resolve(); };
      bounded.addEventListener("abort", done, { once: true });
      void work.then(done, done); if (bounded.aborted) done();
    });
    while (!bounded.aborted && this.readings.get(rootId) === reading) {
      let sample = reading.result.capacity;
      if (sample && sample.measuredAt > reading.minimumAfter && sample.measuredAt <= this.now() && this.now() - sample.measuredAt <= STORAGE_POLICY.admissionMaxAgeMs) return structuredClone(sample);
      const attemptedBefore = reading.attemptedAt;
      await wait(this.refresh());
      if (bounded.aborted || this.readings.get(rootId) !== reading) return null;
      sample = reading.result.capacity;
      if (sample && sample.measuredAt > reading.minimumAfter && sample.measuredAt <= this.now() && this.now() - sample.measuredAt <= STORAGE_POLICY.admissionMaxAgeMs) return structuredClone(sample);
      // A performed, current failed measurement is unavailable. A coalescing cooldown is
      // merely pending: wait for its eligible refresh instead of invalidating a live lease.
      if (sample === null && reading.attemptedAt !== attemptedBefore && reading.attemptedAt >= reading.minimumAfter) return null;
      if (reading.attemptedAt !== attemptedBefore && reading.attemptedAt >= reading.minimumAfter && sample && sample.measuredAt <= reading.minimumAfter) return null;
      const delay = Math.max(1, 1_000 - (this.now() - reading.attemptedAt));
      const waitingAt = this.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await wait(new Promise<void>(resolve => { timer = setTimeout(resolve, Math.min(delay, 1_000)); })); }
      finally { if (timer) clearTimeout(timer); }
      if (this.now() <= waitingAt) return null; // A frozen/reversed clock cannot qualify freshness.
    }
    return null;
  }

  snapshot(): StorageHealthSnapshot {
    const now = this.now();
    const roots: StorageRootHealth[] = this.roots.map(root => {
      const reading = this.readings.get(root.rootId)!, result = reading.result, sample = result.capacity;
      const stale = sample !== null && (sample.measuredAt > now || now - sample.measuredAt > STORAGE_POLICY.forecastMaxAgeMs);
      const unavailable = sample !== null && sample.availableBytes === null;
      const unmeasured = reading.attemptedAt === -Infinity && reading.minimumAfter === -Infinity;
      return { rootId: root.rootId, role: root.role, ...result, state: unmeasured ? "unmeasured" : stale ? "stale" : unavailable ? "unavailable" : result.state,
        forecast: stale ? null : forecastStorage(reading.samples, now), pressure: sample && !stale && !unavailable ? reading.pressure : null };
    });
    return StorageHealthSnapshotSchema.parse({ at: now, writing: this.writing, roots });
  }
  private publish(): void {
    if (this.stopped) return;
    try { this.deps.onSnapshot(this.snapshot()); } catch { /* Collection remains independent of a failed presentation observer. */ }
  }
  private schedule(delay: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.refresh(); }, delay); this.timer.unref?.();
  }
  private reschedule(): void {
    const waits = [...this.pending].map(id => {
      const age = this.now() - this.readings.get(id)!.attemptedAt;
      return age < 0 ? 0 : Math.max(0, 1_000 - age);
    });
    this.schedule(waits.length ? Math.min(...waits) : this.writing ? 30_000 : 300_000);
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.admissionStopped.abort();
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    this.batchAbort?.abort(); await this.batch;
  }
}
