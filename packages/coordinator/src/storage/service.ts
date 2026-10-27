import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { StorageHealthSnapshot, StorageRootRole } from "@arke-studio/contracts";
import { FileStorageReservationStore } from "./reservation-file.js";
import { StorageReservations, type StorageReservationStore } from "./reservations.js";
import { StorageMonitor, type StorageProbeResult } from "./monitor.js";
import { WindowsVolumeProbe } from "./windows-volume.js";
import { LinuxVolumeProbe } from "./linux-volume.js";

export interface StorageNativePort {
  setRoots(roots: readonly { rootId: string; path: string }[]): void;
  probe(rootId: string, signal: AbortSignal, after?: number): Promise<StorageProbeResult>;
  stop(): Promise<void>;
}
interface Root {
  rootId: string;
  path: string;
  role: StorageRootRole;
  fixed: boolean;
  world: boolean;
  leases: number;
}
const rootKey = (path: string) => createHash("sha256").update("storage-root\0" + path).digest("hex");

/** Application-local composition for SPEC-061/062. Only trusted owners register paths;
 * snapshots contain handles and measured facts. World/job authorities stay with their owners. */
export class AppStorageService {
  readonly supportsAdmission: boolean;
  readonly reservations: StorageReservations;
  private readonly monitor: StorageMonitor;
  private readonly native: StorageNativePort;
  private readonly roots = new Map<string, Root>();
  private readonly listeners = new Set<(snapshot: StorageHealthSnapshot) => void>();
  private currentWorld: string | null = null;
  private observedWriting = false;
  private writers = 0;
  private closing = false;
  private limited = false;
  private admissionReady = false;
  private starting: Promise<void> | null = null;
  private observationsStopped: Promise<unknown> | null = null;

  constructor(options: { appRoot: string; native?: StorageNativePort; platform?: string; now?: () => number; store?: StorageReservationStore }) {
    const platform = options.platform ?? process.platform;
    this.supportsAdmission = options.native !== undefined || platform === "win32" || platform === "linux";
    this.native = options.native ?? (platform === "win32" ? new WindowsVolumeProbe({ now: options.now }) : platform === "linux" ? new LinuxVolumeProbe({ now: options.now }) : {
      setRoots: () => {},
      probe: async (): Promise<StorageProbeResult> => ({ state: "unsupported", capacity: null, source: "host-provided", limitations: ["unsupported-filesystem"] }),
      stop: async () => {},
    });
    this.reservations = new StorageReservations({
      store: options.store ?? new FileStorageReservationStore(join(options.appRoot, "operations", "storage-reservations.json")),
      probe: (rootId, signal, after) => this.monitor.capacity(rootId, signal, after), now: options.now,
      capacityEpoch: () => this.monitor.admissionEpoch(),
      capacityCurrent: (rootId, fact) => this.monitor.currentCapacity(rootId, fact),
      onChange: () => { this.syncRoots(); this.publish(this.monitor.snapshot()); },
    });
    this.monitor = new StorageMonitor({ probe: (rootId, signal, after) => this.native.probe(rootId, signal, after), now: options.now,
      onSnapshot: snapshot => this.publish(snapshot) });
    const path = resolve(options.appRoot), rootId = rootKey(path);
    this.roots.set(rootId, { rootId, path, role: "working-files", fixed: true, world: false, leases: 0 });
    this.syncRoots();
  }

  subscribe(listener: (snapshot: StorageHealthSnapshot) => void): () => void {
    this.listeners.add(listener);
    try { listener(this.snapshot()); } catch { /* The next observation remains available. */ }
    return () => { this.listeners.delete(listener); };
  }
  private decorate(snapshot: StorageHealthSnapshot): StorageHealthSnapshot {
    const control = this.reservations.snapshot(), uncertain = control.records.filter(record => record.state === "uncertain").length;
    return { ...snapshot, limited: this.limited, admission: {
      state: !this.admissionReady ? "starting" : !control.auditAvailable ? "unavailable" : uncertain ? "reconciling" : "available",
      reservations: control.records.length, uncertain,
      reason: control.auditFailure,
    } };
  }
  snapshot(): StorageHealthSnapshot { return this.decorate(this.monitor.snapshot()); }
  /** Registered host handle only; waits through collector coalescing for a post-fence sample. */
  measure(rootId: string, signal: AbortSignal, after: number): Promise<import("@arke-studio/contracts").StorageCapacity | null> {
    return this.closing || !this.roots.has(rootId) ? Promise.resolve(null) : this.monitor.capacity(rootId, signal, after);
  }
  private publish(snapshot: StorageHealthSnapshot): void {
    if (this.closing) return;
    const value = this.decorate(snapshot);
    for (const listener of this.listeners) { try { listener(value); } catch { /* A view cannot stop resource collection. */ } }
  }

  start(): Promise<void> {
    if (this.closing) return Promise.resolve();
    this.starting ??= (async () => {
      await this.reservations.open();
      if (!this.closing) { this.admissionReady = true; this.publish(this.monitor.snapshot()); await this.monitor.start(); }
    })();
    return this.starting;
  }

  setWorld(directory: string | null): void {
    const path = directory ? resolve(directory) : null;
    if (this.closing || this.currentWorld === path) return;
    if (this.currentWorld) { const old = this.roots.get(rootKey(this.currentWorld)); if (old) old.world = false; }
    this.currentWorld = path;
    this.syncRoots();
  }

  /** A background operation retains just its known destination after its world leaves the UI.
   * It does not authorize scanning every closed world or deleting anything in this root. */
  acquireRoot(directory: string, role: StorageRootRole): { rootId: string; release(): void } {
    if (this.closing) throw new Error("Storage observation is stopping.");
    const path = resolve(directory), rootId = rootKey(path);
    let root = this.roots.get(rootId);
    if (!root) {
      if (this.roots.size >= 128) throw new Error("Too many active storage destinations.");
      root = { rootId, path, role, fixed: false, world: false, leases: 0 }; this.roots.set(rootId, root);
    }
    root.leases++; this.syncRoots();
    let held = true;
    return { rootId, release: () => { if (held) { held = false; root.leases--; this.syncRoots(); } } };
  }

  setWriting(writing: boolean): void { this.observedWriting = writing; if (!this.closing) this.monitor.setWriting(writing || this.writers > 0); }
  beginWrite(): () => void {
    if (this.closing) throw new Error("Storage admission is stopping.");
    this.writers++; this.monitor.setWriting(true);
    let held = true;
    return () => { if (held) { held = false; this.writers--; if (!this.closing) this.monitor.setWriting(this.observedWriting || this.writers > 0); } };
  }
  refresh(): Promise<void> { return this.closing ? Promise.resolve() : this.monitor.refresh(); }
  wake(): Promise<void> { return this.closing ? Promise.resolve() : this.monitor.wake(); }
  writeFailed(rootId: string): void { if (!this.closing && this.roots.has(rootId)) this.monitor.invalidate(rootId); }

  private syncRoots(): void {
    const retained = new Set(this.reservations.snapshot().records.flatMap(record => record.demands.map(demand => demand.rootId)));
    for (const [id, root] of this.roots) if (!root.fixed && !root.world && root.leases === 0 && !retained.has(id)) this.roots.delete(id);
    if (this.closing) return;
    const wasLimited = this.limited;
    this.limited = false;
    if (this.currentWorld) {
      const rootId = rootKey(this.currentWorld), existing = this.roots.get(rootId);
      if (existing) existing.world = true;
      else if (this.roots.size < 128) this.roots.set(rootId, { rootId, path: this.currentWorld, role: "generated-media", fixed: false, world: true, leases: 0 });
      else this.limited = true;
    }
    const roots = [...this.roots.values()];
    try { this.native.setRoots(roots.map(root => ({ rootId: root.rootId, path: root.path }))); }
    catch { this.limited = true; }
    this.monitor.setRoots(roots.map(root => ({ rootId: root.rootId, role: root.role, revision: root.rootId })));
    if (wasLimited !== this.limited) this.publish(this.monitor.snapshot());
  }

  closeAdmission(): void {
    if (this.closing) return;
    this.closing = true; this.reservations.closeAdmission();
    this.observationsStopped = Promise.allSettled([this.monitor.stop(), this.native.stop()]);
  }
  async stop(): Promise<void> {
    this.closeAdmission(); await this.observationsStopped; await this.starting;
    await this.reservations.stop(); this.listeners.clear();
  }
}
