import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { StorageHealthSnapshot, StorageRootRole, StorageSpaceCheck } from "@arke-studio/contracts";
import { FileStorageReservationStore } from "./reservation-file.js";
import { StorageReservations, type StorageCheckObservation, type StorageReservationStore } from "./reservations.js";
import { StorageMonitor, type StorageProbeResult } from "./monitor.js";
import { WindowsVolumeProbe } from "./windows-volume.js";
import { LinuxVolumeProbe } from "./linux-volume.js";
import { StorageInventoryCollector, type InventoryRoot } from "./inventory.js";

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
  worldScope?: string;
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
  private readonly inventory: StorageInventoryCollector;
  private readonly inventoryRoots: InventoryRoot[];
  private readonly previewInventoryRoot: InventoryRoot;
  private managedModelRoots: InventoryRoot[] = [];
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
  private readonly spaceChecks = new Map<string, StorageSpaceCheck>();
  private readonly now: () => number;

  constructor(options: { appRoot: string; native?: StorageNativePort; platform?: string; now?: () => number; store?: StorageReservationStore }) {
    this.now = options.now ?? Date.now;
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
      capacityEpoch: roots => this.monitor.admissionEpoch(roots),
      capacityCurrent: (rootId, fact) => this.monitor.currentCapacity(rootId, fact),
      onChange: () => { this.syncRoots(); this.publish(this.monitor.snapshot()); },
      onCheck: check => this.recordCheck(check),
    });
    this.monitor = new StorageMonitor({ probe: (rootId, signal, after) => this.native.probe(rootId, signal, after), now: options.now,
      onSnapshot: snapshot => this.publish(snapshot) });
    const path = resolve(options.appRoot), rootId = rootKey(path);
    this.inventory = new StorageInventoryCollector({ now: options.now, changed: () => this.publish(this.monitor.snapshot()) });
    // Fixed Arke-owned folders only: never walk appRoot itself, its worlds library, an
    // external runtime installation or a caller's arbitrary destination lease.
    this.inventoryRoots = [
      { path: join(path, "models"), kind: "models" }, { path: join(path, "comfyui-runtime"), kind: "comfyui" },
      { path: join(path, "ollama-runtime"), kind: "other" }, { path: join(path, "story-publications"), kind: "publications" },
      ...["downloads", ".setup-downloads", "comfyui-runtime.staging", "ollama-runtime.staging"].map(name => ({ path: join(path, name), kind: "downloads" as const })),
      ...[".staging", ".stage", ".ask", "runtime-cache", "voice-previews"].map(name => ({ path: join(path, name), kind: "temporary" as const })),
    ];
    this.previewInventoryRoot = { path: join(path, "voice-previews", "local-presets-v1"), kind: "temporary" };
    this.inventory.record(this.previewInventoryRoot, null);
    this.inventory.setRoots(this.inventoryRoots);
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
    return { ...snapshot, inventory: this.inventory.snapshot(), limited: this.limited, admission: {
      state: !this.admissionReady ? "starting" : !control.auditAvailable ? "unavailable" : uncertain ? "reconciling" : "available",
      reservations: control.records.length, uncertain,
      reason: control.auditFailure,
    }, spaceChecks: structuredClone([...this.spaceChecks.values()].filter(check => check.checkedAt <= this.now() && this.now() - check.checkedAt <= 15 * 60_000).reverse()) };
  }
  private recordCheck(check: StorageCheckObservation): void {
    if (this.closing) return;
    const id = createHash("sha256").update(JSON.stringify(["storage-check", check.owner.kind, check.owner.id, check.assessment])).digest("hex");
    this.spaceChecks.delete(id);
    if (check.volumes.some(volume => volume.admission.status === "held")) {
      const volumes: StorageSpaceCheck["volumes"] = [];
      for (const volume of check.volumes) {
        const roles = [...new Set(volume.rootIds.map(rootId => this.roots.get(rootId)?.role).filter((role): role is StorageRootRole => !!role))];
        if (!roles.length) return;
        volumes.push({ volumeId: volume.volumeId, measuredAt: volume.measuredAt, roles, ...volume.admission });
      }
      this.spaceChecks.set(id, { id, checkedAt: check.checkedAt, purpose: check.assessment ? "submission" : check.owner.kind, volumes });
      while (this.spaceChecks.size > 16) this.spaceChecks.delete(this.spaceChecks.keys().next().value!);
    }
    // Refused requests have no durable reservation and can outlive their root leases. Keep
    // only these bounded, anonymous check facts; never retain a path or invent live work.
    this.publish(this.monitor.snapshot());
  }
  snapshot(): StorageHealthSnapshot { return this.decorate(this.monitor.snapshot()); }
  /** Reuse the preview owner's existing bounded receipt read. It does not measure allocation. */
  recordPreviewInventory(value: { files: number; bytes: number; at: number } | null): void {
    if (!this.closing) this.inventory.record(this.previewInventoryRoot, value ? {
      counts: { temporary: { files: value.files, bytes: value.bytes } }, complete: false, at: value.at,
    } : null);
  }
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
      if (!this.closing) { this.admissionReady = true; this.inventory.start(); this.publish(this.monitor.snapshot()); await this.monitor.start(); }
    })();
    return this.starting;
  }

  setWorld(directory: string | null): void {
    const path = directory ? resolve(directory) : null;
    if (this.closing || this.currentWorld === path) return;
    if (this.currentWorld) for (const root of this.roots.values()) {
      if (root.rootId === rootKey(this.currentWorld) || root.worldScope === this.currentWorld) root.world = false;
    }
    this.currentWorld = path;
    this.syncInventoryRoots();
    if (path) for (const root of this.roots.values()) if (root.worldScope === path) root.world = true;
    this.syncRoots();
  }

  /** Trusted managed-store owners supply only their model subfolders, never a personal
   * installation or the whole selected drive. Capacity follows those actual destinations. */
  setManagedModelRoots(directories: readonly string[]): void {
    if (this.closing) return;
    const next = [...new Set(directories.map(path => resolve(path)))].sort().map(path => ({ path, kind: "models" as const }));
    if (JSON.stringify(next) === JSON.stringify(this.managedModelRoots)) return;
    if (next.length > 16) throw new Error("Too many managed model destinations.");
    this.managedModelRoots = next;
    // Set the new scope before publishing a root change: observers can re-enter this setter.
    this.syncRoots();
    this.syncInventoryRoots();
  }

  private syncInventoryRoots(): void {
    this.inventory.setRoots([...this.inventoryRoots, ...this.managedModelRoots,
      ...(this.currentWorld ? [{ path: this.currentWorld, kind: "world" as const }] : [])]);
  }

  /** A background operation retains just its known destination after its world leaves the UI.
   * It does not authorize scanning every closed world or deleting anything in this root. */
  acquireRoot(directory: string, role: StorageRootRole, retainInWorld = false): { rootId: string; release(): void } {
    if (this.closing) throw new Error("Storage observation is stopping.");
    const path = resolve(directory), rootId = rootKey(path);
    let root = this.roots.get(rootId);
    if (!root) {
      if (this.roots.size >= 128) throw new Error("Too many active storage destinations.");
      root = { rootId, path, role, fixed: false, world: false, leases: 0 }; this.roots.set(rootId, root);
    }
    // Only an explicit stable destination opts in. Per-job staging/UUID roots keep their
    // ordinary lease lifetime and cannot accumulate for the life of an open world.
    if (retainInWorld && this.currentWorld) {
      const rel = relative(this.currentWorld, path);
      if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep)) { root.worldScope = this.currentWorld; root.world = true; }
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
    return () => { if (held) { held = false; this.writers--; if (!this.closing) { this.monitor.setWriting(this.observedWriting || this.writers > 0); this.inventory.refresh(); } } };
  }
  refresh(): Promise<void> { if (!this.closing) this.inventory.refresh(); return this.closing ? Promise.resolve() : this.monitor.refresh(); }
  wake(): Promise<void> { if (!this.closing) this.inventory.refresh(); return this.closing ? Promise.resolve() : this.monitor.wake(); }
  writeFailed(rootId: string): void { if (!this.closing && this.roots.has(rootId)) this.monitor.invalidate(rootId); }

  private syncRoots(): void {
    const retained = new Set(this.reservations.snapshot().records.flatMap(record => record.demands.map(demand => demand.rootId)));
    const models = new Set(this.managedModelRoots.map(root => rootKey(root.path)));
    for (const [id, root] of this.roots) if (!root.fixed && !root.world && root.leases === 0 && !retained.has(id) && !models.has(id)) this.roots.delete(id);
    if (this.closing) return;
    const wasLimited = this.limited;
    this.limited = false;
    for (const model of this.managedModelRoots) {
      const rootId = rootKey(model.path);
      if (!this.roots.has(rootId)) {
        if (this.roots.size < 128) this.roots.set(rootId, { rootId, path: model.path, role: "local-ai", fixed: false, world: false, leases: 0 });
        else this.limited = true;
      }
    }
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
    this.closing = true; this.reservations.closeAdmission(); this.inventory.stop();
    this.observationsStopped = Promise.allSettled([this.monitor.stop(), this.native.stop()]);
  }
  async stop(): Promise<void> {
    this.closeAdmission(); await this.observationsStopped; await this.starting;
    await this.reservations.stop(); this.listeners.clear();
  }
}
