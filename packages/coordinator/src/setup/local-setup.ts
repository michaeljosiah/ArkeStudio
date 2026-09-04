import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import {
  componentIsSettled,
  setupClosure,
  type DomainEvent,
  type SetupClosure,
  type SetupComponent,
  type SetupStatus,
} from "@arke-studio/contracts";
import { toExtendedLength } from "../world/paths.js";
import { SETUP_CATALOGUE, type CatalogueEntry, type DownloadFile } from "./catalogue.js";

/**
 * Fetching the local runtimes at setup (Ollama and its default model, the voice models).
 *
 * Three promises hold this together. Nothing is fetched twice — presence is detected first.
 * Nothing blocks the app — the user continues while it runs, and every component can be
 * skipped. Nothing fails silently — a bad status code, a truncated file or an installer that
 * refuses its own silent flags becomes a stated reason on the row.
 */

export interface SetupDeps {
  /** Streamed GET. A non-null `rangeStart` must be sent as `Range: bytes=<start>-`. */
  fetchStream(
    url: string,
    signal: AbortSignal,
    rangeStart: number | null,
    validator?: string | null,
  ): Promise<{
    ok: boolean;
    status: number;
    contentLength: number | null;
    acceptRanges: boolean;
    contentRangeStart: number | null;
    contentRangeEnd?: number | null;
    contentRangeTotal?: number | null;
    validator?: string | null;
    body: AsyncIterable<Uint8Array>;
  }>;
  /** Run a program to completion. Used for the third-party installer and `ollama pull`. */
  run(command: string, args: readonly string[], signal: AbortSignal): Promise<{ code: number; output: string }>;
  /** Absolute path of a command on PATH, or null. */
  which(command: string): Promise<string | null>;
  /** Does something answer here? Ollama's own API is the surest sign it is installed. */
  probeUrl(url: string): Promise<boolean>;
  diskFreeMb(dir: string): Promise<number | null>;
  /**
   * Whether the user deliberately selected this component somewhere Arke does not manage
   * (SPEC-021 D10). Discovery alone is not presence here; it remains an offer beside Download.
   */
  externallyPresent?(entryId: string): Promise<boolean>;
}

export interface SetupOptions {
  /** Where downloaded models live: <appRoot>/models. */
  appRoot: string;
  catalogue?: readonly CatalogueEntry[];
  /** Progress is noisy; emit at most this often per component. */
  throttleMs?: number;
  /** Refuse to start without this much headroom beyond the download itself. */
  headroomMb?: number;
  /** Which architecture's archive to fetch. Injectable so a test needs no particular machine. */
  arch?: "x64" | "arm64";
  /**
   * Named external roots for `files` entries carrying `externalRoot` (SPEC-021 §2.4): the
   * resolver answers with the user's folder, or null when nothing is mapped — the entry is
   * then blocked with the reason rather than falling back to a folder the engine never reads.
   */
  externalDirs?: Record<string, () => string | null>;
  /** Host-owned destinations that supersede a component's managed location. */
  componentLocations?: Record<string, () => string | null | undefined>;
  /** Awaited after a newly installed component becomes ready, before dependants are attempted. */
  onComponentReady?: (componentId: string) => Promise<void>;
}

interface Live extends SetupComponent {
  entry: CatalogueEntry;
}

interface RepairBlock {
  root: string;
  targets: ReadonlyArray<{ path: string; label: string }>;
  detail: string;
}

class IncompleteDownloadCleanupError extends Error {}

class DownloadPausedError extends Error {
  constructor(message: string, readonly pauseSupported: boolean) {
    super(message);
  }
}

class DiscardDownloadError extends Error {}

interface DownloadReceipt {
  version: 1;
  owner: "arke-studio/local-setup";
  componentId: string;
  url: string;
  target: string;
  partialPath: string;
  durableBytes: number;
  downloadComplete: boolean;
  totalBytes: number | null;
  rangeSupported: boolean;
  validator: string | null;
  closureIds: string[];
}

interface OwnedDownload {
  receipt: DownloadReceipt;
  receiptPath: string;
  targetMatches: boolean;
}

interface ActiveTransfer {
  componentId: string;
  abort: AbortController;
  rangeSupported: boolean;
  receiving: boolean;
  preserve: "pause" | "dispose" | null;
}

const DEFAULT_THROTTLE_MS = 400;
const DEFAULT_HEADROOM_MB = 2000;

/**
 * The tar we mean: Windows ships bsdtar at a known path, and it reads gzip and absolute paths
 * without complaint. A PATH that prefers GNU tar — Git Bash and MSYS2 both do, and a user's
 * PATH is not ours to predict — reads the `C:` in an absolute archive path as a *remote host*
 * and fails with "Cannot connect to C: resolve failed".
 *
 * Resolved rather than escaped, matching what `apps/desktop/scripts/prepare-runtimes.mjs`
 * settled on for the same failure: `--force-local` cures GNU tar and bsdtar rejects the flag
 * outright, so it cannot be passed unconditionally, and a conditional would mean sniffing the
 * tar we are about to run. The bare name stays as the fallback for a system with no System32
 * copy — every other platform included.
 */
export function systemTar(): string {
  if (process.platform !== "win32") return "tar";
  const system32 = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe");
  return existsSync(system32) ? system32 : "tar";
}

export class LocalSetupService {
  private readonly components = new Map<string, Live>();
  private abort = new AbortController();
  private diskFreeMb: number | null = null;
  /** When that figure was read — carried so a start-up reading never poses as current (SPEC-032 R-16). */
  private diskCheckedAt: string | null = null;
  private running = false;
  private disposed = false;
  /** A failed repair stays failed while the exact undeleted file survives at the same root. */
  private readonly repairBlocks = new Map<string, RepairBlock>();
  /** The run in progress, so a second caller awaits it rather than getting a silent no-op. */
  private inFlight: Promise<void> | null = null;
  /** HTTP has its own cancellation: Pause must not kill an installer or model pull. */
  private activeTransfer: ActiveTransfer | null = null;
  /** Explicit resumes survive the detect pass that precedes every run. */
  private readonly resuming = new Set<string>();
  /** The install action a paused member belongs to, persisted into its receipt for restart. */
  private readonly pendingClosures = new Map<string, readonly string[]>();
  private readonly receiptUpdates = new Set<Promise<void>>();

  constructor(
    private readonly deps: SetupDeps,
    private readonly emit: (event: DomainEvent) => void,
    private readonly opts: SetupOptions,
  ) {
    for (const entry of opts.catalogue ?? SETUP_CATALOGUE) {
      this.components.set(entry.id, {
        entry,
        id: entry.id,
        displayName: entry.displayName,
        purpose: entry.purpose,
        sizeMb: entry.sizeMb,
        installLocation: this.installLocationOf(entry),
        state: entry.optional === true ? "available" : "queued",
        bytesDone: 0,
        bytesTotal: entry.sizeMb * 1024 * 1024,
        bytesPerSecond: null,
        pauseSupported: false,
        ...(entry.caveat !== undefined ? { detail: entry.caveat } : {}),
        // Carried onto the wire so a capability row can ask what a component makes available
        // without a second copy of the catalogue in the renderer (SPEC-033 R-39).
        ...(entry.provides !== undefined ? { provides: [...entry.provides] } : {}),
        ...(entry.engine !== undefined ? { engine: entry.engine } : {}),
        ...(entry.provider !== undefined ? { provider: entry.provider } : {}),
        // The declared graph and the peak figure travel too: the button that states what an
        // install costs and the guard that refuses one this disk cannot hold have to be reading
        // the same numbers, or they eventually quote different ones (SPEC-033 R-40, R-42).
        ...(entry.requires !== undefined ? { requires: [...entry.requires] } : {}),
        ...(entry.installedMb !== undefined ? { installedMb: entry.installedMb } : {}),
        ...(this.removable(entry) ? { removable: true } : {}),
      });
    }
  }

  status(): SetupStatus {
    return {
      components: [...this.components.values()].map(({ entry, ...c }) => ({
        ...c,
        // Resolved at publication time because a newly activated or remapped engine can change
        // where dependent weights land without rebuilding the setup service.
        installLocation: this.installLocationOf(entry),
      })),
      running: this.running,
      diskFreeMb: this.diskFreeMb,
      diskCheckedAt: this.diskCheckedAt,
    };
  }

  private publish(): void {
    if (this.disposed) return;
    this.emit({ at: new Date().toISOString(), type: "setup.status", setup: this.status() });
  }

  private set(id: string, patch: Partial<SetupComponent>): void {
    const current = this.components.get(id);
    if (!current) return;
    const next = { ...current, ...patch };
    // A blocked cause describes the blocked state alone. Merging patches would otherwise leave
    // "disk" on a component that has moved on to downloading, and a diagnostics join reading it
    // would report a shortage the screen no longer shows (SPEC-032 R-13).
    if (patch.state !== undefined && patch.state !== "blocked" && patch.blockedBy === undefined) {
      delete next.blockedBy;
      delete next.blockedVolumeRoot;
      delete next.blockedNeedMb;
      delete next.blockedFreeMb;
      delete next.blockedAt;
    }
    this.components.set(id, next);
  }

  private async componentReady(id: string): Promise<void> {
    await this.opts.onComponentReady?.(id).catch(() => {});
    // A paused dependency leaves the rest of its install closure blocked. Once it lands, put
    // exactly those now-satisfied dependants back into the drain so Resume finishes the action
    // the person originally started rather than requiring a second Install press.
    for (const component of this.components.values()) {
      if (
        component.state === "blocked" &&
        component.blockedBy === "dependency" &&
        (component.entry.requires ?? []).every((dependency) => {
          const state = this.components.get(dependency)?.state;
          return state === "ready" || state === "present";
        })
      ) {
        this.set(component.id, { state: "queued", bytesPerSecond: null, detail: undefined });
      }
    }
  }

  private modelsDir(): string {
    return join(this.opts.appRoot, "models");
  }

  /** Receipts live under Arke's root even when the bytes themselves land in a user-mapped folder. */
  private receiptsDir(): string {
    return join(this.opts.appRoot, ".setup-downloads");
  }

  private receiptPath(componentId: string, url: string, target: string): string {
    // Deliberately independent of the destination folder: a mapping may change while Arke is
    // closed. The declared filename still separates two files from the same component and URL.
    const key = createHash("sha256").update(`${componentId}\0${url}\0${parse(target).base}`).digest("hex");
    return join(this.receiptsDir(), `${key}.json`);
  }

  private async syncDirectory(path: string): Promise<void> {
    const directory = await open(toExtendedLength(path), "r").catch(() => null);
    if (directory === null) return;
    try {
      await directory.sync();
    } catch {
      // Windows does not expose directory fsync; the file handles themselves are still flushed.
    } finally {
      await directory.close().catch(() => {});
    }
  }

  private async writeReceipt(path: string, receipt: DownloadReceipt): Promise<void> {
    receipt.closureIds = [...(this.pendingClosures.get(receipt.componentId) ?? receipt.closureIds)];
    await mkdir(toExtendedLength(dirname(path)), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(toExtendedLength(temporary), "wx");
    try {
      await file.writeFile(JSON.stringify(receipt));
      await file.sync();
    } finally {
      await file.close().catch(() => {});
    }
    await rename(toExtendedLength(temporary), toExtendedLength(path)).catch(async (err) => {
      await rm(toExtendedLength(temporary), { force: true }).catch(() => {});
      throw err;
    });
    await this.syncDirectory(dirname(path));
  }

  /**
   * A path in a receipt is trusted only when the current catalogue independently derives every
   * identity in it. The UUID-shaped sibling check prevents a damaged receipt from turning Stop
   * all into deletion of an arbitrary path in a mapped folder.
   */
  private async ownedDownload(
    componentId: string,
    spec: DownloadFile,
    target: string,
    allowMoved = false,
  ): Promise<OwnedDownload | null> {
    const receiptPath = this.receiptPath(componentId, spec.url, target);
    const raw = await readFile(toExtendedLength(receiptPath), "utf8").catch(() => null);
    if (raw === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof value !== "object" || value === null) return null;
    const receipt = value as Partial<DownloadReceipt>;
    const totalBytes = receipt.totalBytes;
    const savedTarget = typeof receipt.target === "string" ? receipt.target : "";
    const prefix = `${savedTarget}.`;
    const uuid = typeof receipt.partialPath === "string"
      && receipt.partialPath.startsWith(prefix)
      && receipt.partialPath.endsWith(".partial")
      ? receipt.partialPath.slice(prefix.length, -".partial".length)
      : "";
    if (
      receipt.version !== 1
      || receipt.owner !== "arke-studio/local-setup"
      || receipt.componentId !== componentId
      || receipt.url !== spec.url
      || (!allowMoved && savedTarget !== target)
      || typeof receipt.partialPath !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)
      || !Number.isSafeInteger(receipt.durableBytes)
      || receipt.durableBytes! < 0
      || typeof receipt.downloadComplete !== "boolean"
      || !(totalBytes === null || (typeof totalBytes === "number" && Number.isSafeInteger(totalBytes) && totalBytes >= 0))
      || typeof receipt.rangeSupported !== "boolean"
      || !(receipt.validator === null || typeof receipt.validator === "string")
      || !Array.isArray(receipt.closureIds)
      || !receipt.closureIds.includes(componentId)
      || receipt.closureIds.some((id) => typeof id !== "string" || id.length === 0)
      || receipt.closureIds.some((id) => !this.components.has(id))
    ) {
      return null;
    }
    const info = await stat(toExtendedLength(receipt.partialPath)).catch(() => null);
    if (!info?.isFile()) {
      // Receipt-first allocation and final-file rename both have a safe, recoverable state with
      // no partial. Clearing only this app-owned metadata cannot delete somebody else's bytes.
      await rm(toExtendedLength(receiptPath), { force: true }).catch(() => {});
      return null;
    }
    if (info.size < receipt.durableBytes!) return null;
    return { receipt: receipt as DownloadReceipt, receiptPath, targetMatches: savedTarget === target };
  }

  private downloadTargets(entry: CatalogueEntry): Array<{ spec: DownloadFile; target: string }> {
    const spec = entry.spec;
    if (spec.kind === "files") {
      // A missing external mapping still needs a deterministic basename so the app-owned receipt
      // can recover and discard bytes from the old mapping. No download writes to this fallback.
      const root = this.filesRoot(spec) ?? join(this.opts.appRoot, ".unmapped");
      return spec.files.map((file) => ({ spec: file, target: join(root, spec.dir, file.file) }));
    }
    if (spec.kind === "tree") {
      return [{ spec: spec.file, target: join(`${join(this.opts.appRoot, spec.dir)}.staging`, spec.file.file) }];
    }
    if (spec.kind === "installer") {
      return [{ spec: spec.file, target: join(this.modelsDir(), ".staging", spec.file.file) }];
    }
    if (spec.kind === "archive") {
      const file = this.archiveFor(spec);
      return file === null ? [] : [{ spec: file, target: join(this.toolDir(spec), ".staging", file.file) }];
    }
    return [];
  }

  private async pausedProgress(entry: CatalogueEntry): Promise<{
    bytesDone: number;
    pauseSupported: boolean;
    detail: string;
    closureIds: readonly string[];
  } | null> {
    let bytesDone = 0;
    let paused: OwnedDownload | null = null;
    for (const { spec, target } of this.downloadTargets(entry)) {
      const complete = await stat(toExtendedLength(target)).catch(() => null);
      if (complete?.isFile() && complete.size > 0) {
        bytesDone += complete.size;
        continue;
      }
      const owned = await this.ownedDownload(entry.id, spec, target, true);
      if (owned !== null) {
        bytesDone += owned.receipt.durableBytes;
        paused = owned;
      }
    }
    if (paused === null) return null;
    const canResume =
      paused.receipt.rangeSupported ||
      paused.receipt.downloadComplete ||
      (paused.receipt.totalBytes !== null && paused.receipt.durableBytes === paused.receipt.totalBytes);
    return {
      bytesDone,
      pauseSupported: canResume && paused.targetMatches,
      detail: paused.targetMatches
        ? canResume ? "paused" : "this source does not support pause"
        : "the download location changed; Stop all can discard the retained bytes",
      closureIds: paused.receipt.closureIds,
    };
  }

  private async discardOwned(entry: CatalogueEntry): Promise<NonNullable<SetupComponent["leftovers"]>> {
    const leftovers: NonNullable<SetupComponent["leftovers"]> = [];
    for (const { spec, target } of this.downloadTargets(entry)) {
      const owned = await this.ownedDownload(entry.id, spec, target, true);
      if (owned === null) continue;
      try {
        await rm(toExtendedLength(owned.receipt.partialPath), { force: true });
      } catch {
        // Keep the receipt: it is the only durable proof that this survivor is ours.
        leftovers.push({
          path: owned.receipt.partialPath,
          sizeMb: Math.round(owned.receipt.durableBytes / (1024 * 1024)),
        });
        continue;
      }
      await rm(toExtendedLength(owned.receiptPath), { force: true }).catch(() => {});
    }
    return leftovers;
  }

  private persistPendingClosure(entry: CatalogueEntry): void {
    const update = (async () => {
      for (const { spec, target } of this.downloadTargets(entry)) {
        const owned = await this.ownedDownload(entry.id, spec, target, true);
        if (owned !== null) await this.writeReceipt(owned.receiptPath, owned.receipt);
      }
    })().catch(() => {
      // The next checkpoint retries this write for an active transfer. A paused receipt remains
      // valid for its earlier closure rather than turning a UI action into an unhandled rejection.
    });
    this.receiptUpdates.add(update);
    void update.finally(() => this.receiptUpdates.delete(update));
  }

  /**
   * Where a `files` entry's downloads live: the app's own models folder, or — for an entry
   * naming an external root — the user's mapped folder. Null means the mapping does not
   * resolve right now, which blocks the entry with the reason instead of guessing a folder.
   */
  private filesRoot(spec: { externalRoot?: string }): string | null {
    if (spec.externalRoot === undefined) return this.modelsDir();
    return this.opts.externalDirs?.[spec.externalRoot]?.() ?? null;
  }

  /** Tools live beside the models, not among them: an executable is not a weight file. */
  private toolDir(spec: { dir: string }): string {
    return join(this.opts.appRoot, spec.dir);
  }

  /** The concrete final folder, resolved here rather than inferred from component ids in a reader. */
  private installLocationOf(entry: CatalogueEntry): string | null {
    const hostLocation = this.opts.componentLocations?.[entry.id]?.();
    if (hostLocation !== undefined) return hostLocation;
    const spec = entry.spec;
    if (spec.kind === "files") {
      const root = this.filesRoot(spec);
      return root === null ? null : join(root, spec.dir);
    }
    if (spec.kind === "archive" || spec.kind === "tree") return this.toolDir(spec);
    if (spec.kind === "pull") {
      if (process.env["OLLAMA_MODELS"]) return resolve(process.env["OLLAMA_MODELS"]);
      return process.platform === "linux"
        ? "/usr/share/ollama/.ollama/models"
        : join(homedir(), ".ollama", "models");
    }
    // The staged installer is temporary. State the runtime's documented final location instead.
    if (process.platform === "darwin") return "/Applications/Ollama.app";
    if (process.platform === "linux") return "/usr/local/bin";
    return join(process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"), "Programs", "Ollama");
  }

  /** The installer download is staged on Arke's volume before Ollama writes its final location. */
  private guardDestinationOf(entry: CatalogueEntry): string | null {
    return entry.spec.kind === "installer" ? this.modelsDir() : this.installLocationOf(entry);
  }

  /**
   * Free space where this path will be written. `statfs` needs somewhere that exists, and a
   * destination often does not yet — `<appRoot>/models` on a first run, `checkpoints/` under a
   * freshly mapped folder — so the nearest existing ancestor is measured instead. Same volume,
   * same answer, and it keeps a not-yet-created folder from reading as unmeasurable.
   */
  private async diskFreeFor(dir: string): Promise<number | null> {
    let at = resolve(dir);
    for (;;) {
      const free = await this.deps.diskFreeMb(at).catch(() => null);
      if (free !== null) return free;
      const up = dirname(at);
      if (up === at) return null;
      at = up;
    }
  }

  /**
   * The archive for this machine. A release publishes one per architecture, and picking the
   * wrong one yields a binary that will not start — a worse failure than not fetching at all,
   * because it looks installed.
   */
  private archiveFor(spec: { byArch: Partial<Record<"x64" | "arm64", DownloadFile>> }): DownloadFile | null {
    const arch = this.opts.arch ?? (process.arch === "arm64" ? "arm64" : "x64");
    return spec.byArch[arch] ?? null;
  }

  /** What is already here. Cheap, and always runs before anything is fetched. */
  async detect(): Promise<void> {
    const recoveredClosures: Array<{ pausedId: string; componentIds: readonly string[] }> = [];
    for (const [id, c] of this.components) {
      if (c.state === "skipped") continue;
      const repairBlock = this.repairBlocks.get(id);
      if (repairBlock !== undefined) {
        const spec = c.entry.spec;
        const currentRoot = spec.kind === "files" ? this.filesRoot(spec) : null;
        if (currentRoot === repairBlock.root) {
          const survivor = await firstExisting(repairBlock.targets.map((target) => target.path));
          if (survivor !== null) {
            this.set(id, { state: "failed", detail: repairBlock.detail, repairRequired: true });
            continue;
          }
        }
        // The author removed the held file, or selected a different library. The old failure no
        // longer speaks for the current destination and must not hold it permanently.
        this.repairBlocks.delete(id);
        this.set(id, {
          state: c.entry.optional === true ? "available" : "queued",
          bytesDone: 0,
          bytesPerSecond: null,
          detail: undefined,
          repairRequired: undefined,
        });
      }
      const present = await this.isPresent(c.entry).catch(() => false);
      if (present) {
        await this.discardOwned(c.entry);
        this.set(id, {
          state: "present",
          bytesDone: c.bytesTotal,
          bytesPerSecond: null,
          pauseSupported: false,
          repairRequired: undefined,
        });
      } else if (c.state !== "downloading" && c.state !== "installing" && !this.resuming.has(id)) {
        const paused = await this.pausedProgress(c.entry);
        if (paused !== null) {
          this.set(id, {
            state: "paused",
            bytesDone: paused.bytesDone,
            bytesPerSecond: null,
            pauseSupported: paused.pauseSupported,
            detail: paused.detail,
          });
          recoveredClosures.push({ pausedId: id, componentIds: paused.closureIds });
          for (const member of paused.closureIds) this.pendingClosures.set(member, paused.closureIds);
        } else if (c.state === "present" || c.state === "paused") {
          this.set(id, {
            state: c.entry.optional === true ? "available" : "queued",
            bytesDone: 0,
            pauseSupported: false,
          });
        }
      }
    }
    for (const recovered of recoveredClosures) {
      let afterPaused = false;
      for (const id of recovered.componentIds) {
        if (id === recovered.pausedId) {
          afterPaused = true;
          continue;
        }
        if (!afterPaused) continue;
        const component = this.components.get(id);
        if (!component || componentIsSettled(component.state)) continue;
        this.set(id, {
          state: "blocked",
          bytesPerSecond: null,
          detail: `waiting on ${this.components.get(recovered.pausedId)?.displayName ?? recovered.pausedId}`,
          blockedBy: "dependency",
        });
      }
    }
    this.diskFreeMb = await this.deps.diskFreeMb(this.opts.appRoot).catch(() => null);
    this.diskCheckedAt = new Date().toISOString();
    this.publish();
  }

  private async isPresent(entry: CatalogueEntry): Promise<boolean> {
    // A deliberately selected external source wins over installation (SPEC-021 D10). Detection
    // alone is only an offer and must not suppress the managed runtime option.
    if (await this.deps.externallyPresent?.(entry.id).catch(() => false)) return true;
    const spec = entry.spec;
    if (spec.kind === "installer") {
      if (await this.deps.probeUrl("http://127.0.0.1:11434/api/version")) return true;
      return (await this.deps.which("ollama")) !== null;
    }
    if (spec.kind === "archive") {
      // The executable under its real name is the proof: extraction writes into a staging
      // directory and only a complete extraction is moved into place.
      const info = await stat(toExtendedLength(join(this.toolDir(spec), spec.executable))).catch(() => null);
      return info !== null && info.size > 0;
    }
    if (spec.kind === "tree") {
      // The marker under the installed dir — possibly one level deep, because upstream
      // archives wrap their tree in a single top folder that is installed as-is.
      const root = join(this.opts.appRoot, spec.dir);
      const marker = await this.treeMarkerPath(root, spec.rootMarker);
      return marker !== null;
    }
    if (spec.kind === "pull") {
      const listed = await this.deps.run(spec.command, ["list"], this.abort.signal).catch(() => null);
      if (!listed || listed.code !== 0) return false;
      const wanted = spec.args[spec.args.length - 1] ?? "";
      // The exact tag: gemma4:12b and gemma4:e2b are different models on the same shelf.
      return listed.output.split(/\r?\n/).some((line) => line.trim().split(/\s+/)[0] === wanted);
    }
    const filesRoot = this.filesRoot(spec);
    if (filesRoot === null) return false; // no mapped folder yet → not present, not an error
    for (const f of spec.files) {
      const path = join(filesRoot, spec.dir, f.file);
      const info = await stat(toExtendedLength(path)).catch(() => null);
      // Existence under the real name IS completion: a download writes to .partial and only a
      // whole file is ever renamed in (see fetchFile below).
      //
      // This used to also require 1024 bytes as a fragment heuristic, which was both redundant
      // and wrong. Kokoro's config.json is 44 bytes — a legitimate, complete file — so the
      // check failed on every start and re-fetched 88 MB of weights that were already there,
      // every time the app opened. A size floor cannot tell a small file from a broken one.
      if (!info || info.size === 0) return false;
    }
    return true;
  }

  /**
   * Fetch everything outstanding, in catalogue order. Resolves when the run ends — for any
   * reason. Never throws: a failure is a state with a reason.
   */
  async run(): Promise<void> {
    if (this.disposed) return;
    if (this.inFlight !== null) return this.inFlight;
    if (this.abort.signal.aborted) this.abort = new AbortController();
    this.inFlight = this.runOnce().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runOnce(): Promise<void> {
    await this.detect();

    // Drained, not snapshotted. A component can be queued *during* a pass — Repair does it,
    // having already deleted the files first — and a pass working from one list taken at the
    // start finishes without touching it, stranding a recipe with its weights gone, stuck
    // queued, and no control on its row. Each round takes what is queued and has not been
    // attempted yet, so a round may add work for the next and nothing can loop forever.
    const attempted = new Set<string>();
    for (;;) {
      if (this.abort.signal.aborted || this.disposed) break;
      const round = [...this.components.values()].filter(
        (c) => c.state === "queued" && !attempted.has(c.id),
      );
      if (round.length === 0) break;
      for (const c of round) attempted.add(c.id);
      await this.installRound(round);
    }
  }

  /** One round of the drain above: guard what it costs, then fetch what still stands. */
  private async installRound(outstanding: readonly Live[]): Promise<void> {
    // The guard: refuse to start a download this disk cannot hold, with both figures.
    // What it costs on disk, not what it costs to fetch: an extracted component needs room for
    // the archive and the tree at once. Guarding on the download alone let a disk with 5 GB
    // free start a 2 GB download that dies part-way through unpacking — the silent mid-way
    // failure this guard exists to replace with a refusal.
    //
    // Per volume, because components no longer all land on one. A mapped models folder is
    // routinely on another drive, so one pooled figure both cleared a 17 GB weight fetch onto a
    // full D: and blocked a 141 MB voice model on a roomy C:. Each volume answers only for what
    // is being written to it; one that cannot be measured blocks nothing, exactly as an
    // unmeasurable disk did before.
    //
    // Pooling needs to know which destinations share a disk, and only the path root can say.
    // On Windows it says it exactly: a drive letter or a UNC share IS a volume, so everything
    // under one root is summed together, which is what sharing a disk means. On a POSIX host
    // every path roots at `/` and that says nothing about the filesystem underneath — pooling
    // there would let a full mapped disk block a download to a roomy one, the very thing this
    // is meant to stop. So where the platform cannot tell us, each destination answers for
    // itself: never pooled with a disk it may not be on, and never over-stated for its own.
    const headroom = this.opts.headroomMb ?? DEFAULT_HEADROOM_MB;
    const rootOf = (dir: string): string => parse(resolve(dir)).root;
    const volumeKey = (dir: string): string => (process.platform === "win32" ? rootOf(dir) : resolve(dir));
    const volumes = new Map<string, { root: string; dirs: Set<string>; needMb: number; components: Live[] }>();
    for (const c of outstanding) {
      const dir = this.guardDestinationOf(c.entry);
      if (dir === null) continue; // no mapped folder — install states that, and states it better
      const key = volumeKey(dir);
      const group = volumes.get(key) ?? { root: rootOf(dir), dirs: new Set<string>(), needMb: 0, components: [] };
      group.dirs.add(dir);
      // Resumed bytes already occupy this volume. Guard only the remaining peak instead of
      // requiring room for a second copy of a 40 GB prefix that is already here.
      const retainedMb = Math.floor(c.bytesDone / (1024 * 1024));
      group.needMb += Math.max(0, (c.entry.installedMb ?? c.sizeMb) - retainedMb);
      group.components.push(c);
      volumes.set(key, group);
    }
    const appRootDrive = rootOf(this.opts.appRoot);
    let blockedAny = false;
    for (const group of volumes.values()) {
      const measured: number[] = [];
      for (const dir of group.dirs) {
        const free = await this.diskFreeFor(dir);
        if (free !== null) measured.push(free);
      }
      // The smallest reading in the group: a pooled total is only honest against the tightest
      // disk in it. On Windows they are one volume and agree; elsewhere a group holds one dir.
      const freeMb = measured.length === 0 ? null : Math.min(...measured);
      if (freeMb === null || freeMb >= group.needMb + headroom) continue;
      // Name the drive when it is not the one the app lives on: "this disk" reads as the app's
      // disk to everyone, and a refusal about D: phrased that way sends someone to clear space
      // on the wrong volume. A host with no drive letters has nothing useful to name.
      const where = group.root === appRootDrive ? "this disk" : group.root;
      const blockedAt = new Date().toISOString();
      for (const c of group.components) {
        this.set(c.id, {
          state: "blocked",
          detail: `needs ${gb(group.needMb)} plus room to work; ${where} has ${gb(freeMb)} free`,
          // Declared, so the diagnostics join can tell a full drive from a waiting dependency
          // without parsing this sentence; the root is the one filesystem identification a
          // diagnostics record may carry (SPEC-032 R-20.3, R-28). The figures are this guard's
          // own — `diskFreeMb` on the status is the app volume's, and a mapped models folder is
          // routinely on another drive.
          blockedBy: "disk",
          blockedVolumeRoot: group.root,
          blockedNeedMb: group.needMb,
          blockedFreeMb: freeMb,
          blockedAt,
        });
      }
      blockedAny = true;
    }
    if (blockedAny) this.publish();
    // A short volume no longer stops the ones with room: only what was blocked is out.
    if (!outstanding.some((c) => this.components.get(c.id)?.state === "queued")) return;

    this.running = true;
    this.publish();
    try {
      for (const c of outstanding) {
        if (this.abort.signal.aborted || this.disposed) break;
        const live = this.components.get(c.id);
        if (!live || live.state !== "queued") continue; // skipped while we worked
        const blocker = (live.entry.requires ?? []).find((id) => {
          const dep = this.components.get(id);
          return !dep || (dep.state !== "ready" && dep.state !== "present");
        });
        if (blocker !== undefined) {
          this.set(c.id, {
            state: "blocked",
            detail: `waiting on ${this.components.get(blocker)?.displayName ?? blocker}`,
            blockedBy: "dependency",
          });
          this.publish();
          continue;
        }
        try {
          await this.install(live.entry);
        } finally {
          this.resuming.delete(live.id);
        }
      }
    } finally {
      this.running = false;
      this.publish();
    }
  }

  /** The tree's marker file, at the root or one level deep, or null when neither exists. */
  private async treeMarkerPath(root: string, marker: string): Promise<string | null> {
    const direct = join(root, marker);
    if ((await stat(toExtendedLength(direct)).catch(() => null)) !== null) return direct;
    const entries = await readdir(toExtendedLength(root), { withFileTypes: true }).catch(() => []);
    for (const item of entries) {
      if (!item.isDirectory() || item.name === ".staging") continue;
      const nested = join(root, item.name, marker);
      if ((await stat(toExtendedLength(nested)).catch(() => null)) !== null) return nested;
    }
    return null;
  }

  private async install(entry: CatalogueEntry): Promise<void> {
    const spec = entry.spec;
    try {
      if (spec.kind === "files") {
        const repairBlock = this.repairBlocks.get(entry.id);
        if (repairBlock !== undefined) {
          this.set(entry.id, { state: "failed", detail: repairBlock.detail, repairRequired: true });
          this.publish();
          return;
        }
        const filesRoot = this.filesRoot(spec);
        if (filesRoot === null) {
          this.set(entry.id, {
            state: "blocked",
            detail: "no models folder is mapped for this engine — set one in Settings",
            blockedBy: "models-folder",
          });
          this.publish();
          return;
        }
        const dir = join(filesRoot, spec.dir);
        this.set(entry.id, { state: "downloading", bytesPerSecond: null, pauseSupported: false, detail: undefined });
        this.publish();
        let done = 0;
        for (const f of spec.files) {
          // A file already present in the folder is the user's, recognised rather than
          // re-fetched (SPEC-021 R-8) — detection and download resolve the same path.
          const target = join(dir, f.file);
          const existing = await stat(toExtendedLength(target)).catch(() => null);
          if (existing !== null && existing.size > 0) {
            done += existing.size;
            this.set(entry.id, { bytesDone: done });
            this.publish();
            continue;
          }
          done += await this.download(entry.id, f, target, done);
        }
        this.set(entry.id, {
          state: "ready",
          bytesDone: done,
          bytesPerSecond: null,
          pauseSupported: false,
          repairRequired: undefined,
          ...(entry.caveat !== undefined ? { detail: entry.caveat } : { detail: undefined }),
        });
        this.publish();
        await this.componentReady(entry.id);
        return;
      }

      if (spec.kind === "tree") {
        // The whole runtime directory, atomically (SPEC-021 §2.4): download, extract into
        // staging, verify the marker, and only then rename the tree into place — presence is
        // never half a runtime, exactly as a partial file is never a file.
        const dir = join(this.opts.appRoot, spec.dir);
        const staged = `${dir}.staging`;
        const archive = join(staged, spec.file.file);
        if ((await this.ownedDownload(entry.id, spec.file, archive)) === null) {
          await rm(toExtendedLength(staged), { recursive: true, force: true }).catch(() => {});
        }
        this.set(entry.id, { state: "downloading", bytesPerSecond: null, pauseSupported: false, detail: undefined });
        this.publish();
        const received = await this.download(entry.id, spec.file, archive, 0);

        this.set(entry.id, { state: "installing", bytesPerSecond: null, pauseSupported: false, detail: "unpacking" });
        this.publish();
        const unpacked = await this.deps.run(systemTar(), ["-xf", archive, "-C", staged], this.abort.signal);
        await rm(toExtendedLength(archive), { force: true }).catch(() => {});
        const marker = unpacked.code === 0 ? await this.treeMarkerPath(staged, spec.rootMarker) : null;
        if (marker === null) {
          await rm(toExtendedLength(staged), { recursive: true, force: true }).catch(() => {});
          this.set(entry.id, {
            state: "failed",
            detail: firstLine(unpacked.output) || `the archive did not contain ${spec.rootMarker}`,
          });
          this.publish();
          return;
        }
        await rm(toExtendedLength(dir), { recursive: true, force: true }).catch(() => {});
        await rename(toExtendedLength(staged), toExtendedLength(dir));
        this.set(entry.id, {
          state: "ready",
          bytesDone: received,
          bytesPerSecond: null,
          pauseSupported: false,
          ...(entry.caveat !== undefined ? { detail: entry.caveat } : { detail: undefined }),
        });
        this.publish();
        await this.componentReady(entry.id);
        return;
      }

      if (spec.kind === "installer") {
        const staged = join(this.modelsDir(), ".staging", spec.file.file);
        this.set(entry.id, { state: "downloading", bytesPerSecond: null, pauseSupported: false, detail: undefined });
        this.publish();
        await this.download(entry.id, spec.file, staged, 0);

        this.set(entry.id, {
          state: "installing",
          bytesPerSecond: null,
          pauseSupported: false,
          detail: "running Ollama's own installer",
        });
        this.publish();
        const silent = await this.deps.run(staged, spec.silentArgs, this.abort.signal);
        const arrived = silent.code === 0 && (await this.settles());
        if (!arrived) {
          // Its installer would not go quietly. Hand it to the user rather than pretend.
          await this.deps.run(staged, [], this.abort.signal).catch(() => ({ code: 1, output: "" }));
          const now = await this.settles();
          if (!now) {
            this.set(entry.id, {
              state: "failed",
              detail: "Ollama's installer did not finish — run it yourself from Settings · Providers",
            });
            this.publish();
            return;
          }
        }
        await rm(toExtendedLength(staged), { force: true }).catch(() => {});
        this.set(entry.id, { state: "ready", detail: undefined, bytesPerSecond: null, pauseSupported: false });
        this.publish();
        await this.componentReady(entry.id);
        return;
      }

      if (spec.kind === "archive") {
        const file = this.archiveFor(spec);
        if (file === null) {
          this.set(entry.id, {
            state: "blocked",
            detail: `no ${entry.displayName} build is published for this machine's architecture`,
            blockedBy: "architecture",
          });
          this.publish();
          return;
        }
        const dir = this.toolDir(spec);
        const staged = join(dir, ".staging");
        const archive = join(staged, file.file);
        this.set(entry.id, { state: "downloading", bytesPerSecond: null, pauseSupported: false, detail: undefined });
        this.publish();
        const received = await this.download(entry.id, file, archive, 0);

        this.set(entry.id, { state: "installing", bytesPerSecond: null, pauseSupported: false, detail: "unpacking" });
        this.publish();
        // Extracting into the staging directory keeps a half-unpacked archive from ever looking
        // like presence. `bsdtar` by absolute path, not `tar` off PATH — see systemTar.
        const unpacked = await this.deps.run(systemTar(), ["-xzf", archive, "-C", staged], this.abort.signal);
        const extracted = join(staged, spec.executable);
        const arrived = unpacked.code === 0 && (await stat(toExtendedLength(extracted)).catch(() => null)) !== null;
        if (!arrived) {
          await rm(toExtendedLength(staged), { recursive: true, force: true }).catch(() => {});
          this.set(entry.id, {
            state: "failed",
            detail: firstLine(unpacked.output) || `the archive did not contain ${spec.executable}`,
          });
          this.publish();
          return;
        }
        // Only a complete extraction takes the real path, so presence is never half a tool.
        const target = join(dir, spec.executable);
        await rm(toExtendedLength(target), { force: true }).catch(() => {});
        await rename(toExtendedLength(extracted), toExtendedLength(target));
        await rm(toExtendedLength(staged), { recursive: true, force: true }).catch(() => {});
        this.set(entry.id, {
          state: "ready",
          bytesDone: received,
          bytesPerSecond: null,
          pauseSupported: false,
          detail: undefined,
        });
        this.publish();
        await this.componentReady(entry.id);
        return;
      }

      // A pull: the runtime fetches its own model and reports its own progress; ours is coarse.
      this.set(entry.id, {
        state: "installing",
        detail: `${spec.command} ${spec.args.join(" ")}`,
        bytesPerSecond: null,
        pauseSupported: false,
      });
      this.publish();
      const pulled = await this.deps.run(spec.command, spec.args, this.abort.signal);
      if (pulled.code !== 0) {
        this.set(entry.id, { state: "failed", detail: firstLine(pulled.output) || `${spec.command} exited ${pulled.code}` });
      } else {
        this.set(entry.id, { state: "ready", bytesDone: this.components.get(entry.id)?.bytesTotal ?? 0, detail: undefined });
      }
      this.publish();
      if (pulled.code === 0) await this.componentReady(entry.id);
    } catch (err) {
      if (err instanceof DownloadPausedError) {
        this.set(entry.id, {
          state: "paused",
          bytesPerSecond: null,
          pauseSupported: err.pauseSupported,
          detail: err.message,
        });
      } else if (this.abort.signal.aborted && !(err instanceof IncompleteDownloadCleanupError)) {
        this.set(entry.id, { state: "skipped", bytesPerSecond: null, pauseSupported: false, detail: "stopped" });
      } else {
        this.set(entry.id, {
          state: "failed",
          bytesPerSecond: null,
          pauseSupported: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      this.publish();
    }
  }

  /** Did Ollama actually arrive? Its API answering is the only proof worth having. */
  private async settles(): Promise<boolean> {
    for (let attempt = 0; attempt < 10; attempt++) {
      if (await this.deps.probeUrl("http://127.0.0.1:11434/api/version")) return true;
      if ((await this.deps.which("ollama")) !== null) return true;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }

  /** Verify the complete bytes on disk; hash state is deliberately not serialized across pauses. */
  private async verifyDownload(spec: DownloadFile, partial: string, cancelled: () => boolean): Promise<void> {
    const source = await open(toExtendedLength(partial), "r");
    const hash = spec.sha256 ? createHash("sha256") : null;
    const head: number[] = [];
    const buffer = new Uint8Array(1024 * 1024);
    try {
      let position = 0;
      for (;;) {
        if (cancelled()) throw new Error("stopped");
        const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, position);
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        if (head.length < 8) head.push(...chunk.subarray(0, 8 - head.length));
        hash?.update(chunk);
        position += bytesRead;
      }
    } finally {
      await source.close().catch(() => {});
    }
    if (spec.magic && !spec.magic.every((byte, index) => head[index] === byte)) {
      throw new DiscardDownloadError(`${spec.file}: what arrived is not the file we asked for`);
    }
    if (spec.sha256 && hash?.digest("hex") !== spec.sha256) {
      throw new DiscardDownloadError(`${spec.file}: checksum mismatch`);
    }
  }

  /** Stream one file to disk. Returns its complete byte count, including a resumed prefix. */
  private async download(componentId: string, spec: DownloadFile, target: string, alreadyDone: number): Promise<number> {
    await mkdir(toExtendedLength(dirname(target)), { recursive: true });
    const expectedReceiptPath = this.receiptPath(componentId, spec.url, target);
    const owned = await this.ownedDownload(componentId, spec, target);
    if (owned === null && (await stat(toExtendedLength(expectedReceiptPath)).catch(() => null)) !== null) {
      throw new Error(`${spec.file}: the saved download receipt no longer matches this catalogue and target`);
    }

    const resuming = owned !== null;
    let receipt: DownloadReceipt;
    let receiptPath: string;
    if (owned !== null) {
      receipt = owned.receipt;
      receiptPath = owned.receiptPath;
      const info = await stat(toExtendedLength(receipt.partialPath));
      if (info.size > receipt.durableBytes) {
        const partial = await open(toExtendedLength(receipt.partialPath), "r+");
        try {
          await partial.truncate(receipt.durableBytes);
          await partial.sync();
        } finally {
          await partial.close().catch(() => {});
        }
      }
    } else {
      receiptPath = expectedReceiptPath;
      receipt = {
        version: 1,
        owner: "arke-studio/local-setup",
        componentId,
        url: spec.url,
        target,
        partialPath: `${target}.${randomUUID()}.partial`,
        durableBytes: 0,
        downloadComplete: false,
        totalBytes: null,
        rangeSupported: false,
        validator: null,
        closureIds: [...(this.pendingClosures.get(componentId) ?? [componentId])],
      };
      let createdPartial = false;
      try {
        await this.writeReceipt(receiptPath, receipt);
        const initial = await open(toExtendedLength(receipt.partialPath), "wx");
        createdPartial = true;
        await initial.close();
        await this.syncDirectory(dirname(receipt.partialPath));
      } catch (err) {
        if (createdPartial) await rm(toExtendedLength(receipt.partialPath), { force: true }).catch(() => {});
        await rm(toExtendedLength(receiptPath), { force: true }).catch(() => {});
        throw err;
      }
    }

    const resumedAt = receipt.durableBytes;
    if (!receipt.downloadComplete && receipt.totalBytes !== null && resumedAt === receipt.totalBytes) {
      receipt.downloadComplete = true;
      await this.writeReceipt(receiptPath, receipt);
    }
    if (resuming && !receipt.downloadComplete && !receipt.rangeSupported) {
      throw new Error(`${spec.file}: this source does not support resuming the saved download`);
    }
    const sink = await open(toExtendedLength(receipt.partialPath), "r+");
    const transfer: ActiveTransfer = {
      componentId,
      abort: new AbortController(),
      rangeSupported: receipt.rangeSupported,
      receiving: true,
      preserve: null,
    };
    this.activeTransfer = transfer;
    const started = Date.now();
    let received = 0;
    let lastEmit = 0;
    let lastCheckpoint = 0;
    let landed = false;
    let failure: unknown = null;

    try {
      if (!receipt.downloadComplete) {
        const res = await this.deps.fetchStream(
          spec.url,
          transfer.abort.signal,
          resuming ? resumedAt : null,
          resuming ? receipt.validator : null,
        );
        if (resuming) {
          if (res.status !== 206) {
            throw new DiscardDownloadError(`${spec.file}: resume was refused because the source answered ${res.status}, not 206`);
          }
          if (res.contentRangeStart !== resumedAt) {
            throw new DiscardDownloadError(
              `${spec.file}: resume was refused because Content-Range started at ${res.contentRangeStart ?? "an unknown byte"}, not ${resumedAt}`,
            );
          }
          const rangeEnd = res.contentRangeEnd ?? null;
          const rangeTotal = res.contentRangeTotal ?? null;
          if (
            rangeEnd === null ||
            rangeTotal === null ||
            !Number.isSafeInteger(rangeEnd) ||
            !Number.isSafeInteger(rangeTotal) ||
            rangeEnd < resumedAt ||
            rangeEnd !== rangeTotal - 1 ||
            (res.contentLength !== null && res.contentLength !== rangeEnd - resumedAt + 1)
          ) {
            throw new DiscardDownloadError(`${spec.file}: resume was refused because Content-Range did not describe the complete remainder`);
          }
          if (receipt.totalBytes !== null && rangeTotal !== receipt.totalBytes) {
            throw new DiscardDownloadError(`${spec.file}: resume was refused because the source size changed`);
          }
          if (receipt.validator !== null && res.validator !== receipt.validator) {
            throw new DiscardDownloadError(`${spec.file}: resume was refused because the source changed`);
          }
          receipt.totalBytes = rangeTotal;
        } else if (res.status !== 200) {
          throw new DiscardDownloadError(`${spec.file}: the source answered ${res.status}`);
        }

        if (!resuming) {
          receipt.validator = res.validator ?? null;
          receipt.totalBytes = res.contentLength;
        }
        transfer.rangeSupported = resuming
          ? receipt.rangeSupported
          : res.acceptRanges && (receipt.validator !== null || spec.sha256 !== undefined);
        receipt.rangeSupported = transfer.rangeSupported;
        await this.writeReceipt(receiptPath, receipt);
        this.set(componentId, { pauseSupported: transfer.rangeSupported });
        this.publish();

        for await (const chunk of res.body) {
          if (transfer.abort.signal.aborted || this.abort.signal.aborted || this.disposed) throw new Error("stopped");
          let offset = 0;
          while (offset < chunk.byteLength) {
            const { bytesWritten } = await sink.write(
              chunk,
              offset,
              chunk.byteLength - offset,
              resumedAt + received + offset,
            );
            if (bytesWritten === 0) throw new Error(`${spec.file}: the incomplete download could not be written`);
            offset += bytesWritten;
          }
          received += chunk.byteLength;
          const now = Date.now();
          if (now - lastCheckpoint >= Math.max(5_000, (this.opts.throttleMs ?? DEFAULT_THROTTLE_MS) * 10)) {
            lastCheckpoint = now;
            await sink.sync();
            receipt.durableBytes = resumedAt + received;
            await this.writeReceipt(receiptPath, receipt);
          }
          if (now - lastEmit >= (this.opts.throttleMs ?? DEFAULT_THROTTLE_MS)) {
            lastEmit = now;
            const elapsed = Math.max(1, now - started) / 1000;
            this.set(componentId, {
              bytesDone: alreadyDone + resumedAt + received,
              bytesPerSecond: Math.round(received / elapsed),
            });
            this.publish();
          }
        }
        if (transfer.abort.signal.aborted || this.abort.signal.aborted || this.disposed) throw new Error("stopped");
        if (res.contentLength !== null && received !== res.contentLength) {
          throw new Error(`${spec.file}: the download stopped short (${received} of ${res.contentLength} bytes)`);
        }

        await sink.sync();
        receipt.durableBytes = resumedAt + received;
        receipt.downloadComplete = true;
        await this.writeReceipt(receiptPath, receipt);
      }

      transfer.receiving = false;
      this.set(componentId, { pauseSupported: false });
      this.publish();
      await sink.close();
      await this.verifyDownload(
        spec,
        receipt.partialPath,
        () => transfer.abort.signal.aborted || this.abort.signal.aborted || this.disposed,
      );
      if (transfer.abort.signal.aborted || this.abort.signal.aborted || this.disposed) throw new Error("stopped");
      // Only a verified whole file takes the real name. Rename remains the atomic visibility step.
      await rm(toExtendedLength(target), { force: true }).catch(() => {});
      await rename(toExtendedLength(receipt.partialPath), toExtendedLength(target));
      landed = true;
      await rm(toExtendedLength(receiptPath), { force: true }).catch(() => {});
    } catch (err) {
      failure = err;
    }

    await sink.close().catch(() => {});
    if (this.activeTransfer === transfer) this.activeTransfer = null;
    if (!landed) {
      if (transfer.preserve !== null && transfer.abort.signal.aborted) {
        // Pause is an explicit durability boundary. Persist every byte written before reporting
        // the paused count, even when the ordinary progress throttle had not fired yet.
        const checkpoint = await open(toExtendedLength(receipt.partialPath), "r+");
        try {
          await checkpoint.sync();
        } finally {
          await checkpoint.close().catch(() => {});
        }
        const info = await stat(toExtendedLength(receipt.partialPath));
        receipt.durableBytes = info.size;
        await this.writeReceipt(receiptPath, receipt);
        this.set(componentId, { bytesDone: alreadyDone + receipt.durableBytes });
        throw new DownloadPausedError(
          transfer.preserve === "pause" ? "paused" : "paused when Arke closed",
          transfer.rangeSupported,
        );
      }
      const retainForResume =
        failure !== null &&
        !(failure instanceof DiscardDownloadError) &&
        !transfer.abort.signal.aborted &&
        !this.abort.signal.aborted &&
        !this.disposed &&
        receipt.rangeSupported &&
        receipt.durableBytes > 0;
      if (retainForResume) {
        throw new DownloadPausedError(
          `paused after ${failure instanceof Error ? failure.message : String(failure)}`,
          true,
        );
      }
      try {
        await rm(toExtendedLength(receipt.partialPath), { force: true });
        await rm(toExtendedLength(receiptPath), { force: true });
        this.set(componentId, { bytesDone: alreadyDone });
      } catch (err) {
        this.set(componentId, {
          leftovers: [{ path: receipt.partialPath, sizeMb: Math.round(receipt.durableBytes / (1024 * 1024)) }],
        });
        throw new IncompleteDownloadCleanupError(
          `${spec.file}: the incomplete download could not be removed (${errorCode(err)})`,
        );
      }
      throw failure;
    }
    return receipt.durableBytes;
  }

  /** Pause only the current ranged HTTP transfer; installers and runtime-owned pulls are untouched. */
  pause(componentId: string): boolean {
    const transfer = this.activeTransfer;
    if (
      transfer === null
      || transfer.componentId !== componentId
      || !transfer.rangeSupported
      || !transfer.receiving
      || this.components.get(componentId)?.state !== "downloading"
    ) {
      return false;
    }
    transfer.preserve = "pause";
    transfer.abort.abort();
    return true;
  }

  /** Queue a durable ranged transfer without resetting the progress its receipt proves. */
  resume(componentId: string): boolean {
    const component = this.components.get(componentId);
    if (!component || component.state !== "paused" || !component.pauseSupported) return false;
    this.resuming.add(componentId);
    this.set(componentId, { state: "queued", bytesPerSecond: null, detail: undefined });
    this.publish();
    // If the old pass is still handling a later component, this id is already in that pass's
    // attempted set. Always schedule one drain after it settles so Resume cannot strand at queued.
    void this.run().then(() => this.run());
    return true;
  }

  /** Leave this one out. A skipped component is never attempted again this session. */
  skip(componentId: string): void {
    const c = this.components.get(componentId);
    if (!c || c.state === "ready" || c.state === "present") return;
    this.set(componentId, { state: "skipped", bytesPerSecond: null, detail: "you skipped this" });
    this.publish();
  }

  /**
   * Start one component: an offered model someone asked for, or a skipped/failed one going
   * round again. Either way it joins the queue and the run picks it up.
   */
  retry(componentId: string): void {
    const c = this.components.get(componentId);
    if (!c || c.state === "ready" || c.state === "present" || c.state === "paused") return;
    if (this.repairBlocks.has(componentId)) {
      this.set(componentId, { state: "failed", repairRequired: true });
      this.publish();
      return;
    }
    this.set(componentId, {
      state: "queued",
      bytesDone: 0,
      bytesPerSecond: null,
      detail: undefined,
      leftovers: undefined,
    });
    this.publish();
    if (!this.running) void this.run();
  }

  /**
   * Start a component **and everything it needs** (SPEC-028 R-5, SPEC-033 R-40).
   *
   * One press, one closure. `retry` starts one component and leaves a dependant blocked on a
   * runtime nobody asked for; this queues the whole chain, so the round's own per-volume disk
   * guard measures the closure's total rather than one component's — which is where R-42 wanted
   * that figure all along, and why the guard itself needs no change.
   *
   * Anything already settled stays settled: two models sharing a component do not fetch it
   * twice (R-44).
   */
  installClosure(componentId: string): SetupClosure {
    const closure = setupClosure(this.status().components, componentId);
    for (const id of closure.componentIds) this.pendingClosures.set(id, closure.componentIds);
    for (const id of closure.componentIds) {
      const component = this.components.get(id);
      if (component !== undefined) this.persistPendingClosure(component.entry);
    }
    for (const id of closure.componentIds) {
      const c = this.components.get(id);
      // Anything already on its way is left exactly as it is. Re-queuing a component that is
      // 60% through its download zeroes its bytes and takes the bar off both surfaces, so the
      // person who pressed Install on a second model is told the first transfer stopped.
      if (
        !c
        || componentIsSettled(c.state)
        || c.state === "queued"
        || c.state === "downloading"
        || c.state === "paused"
        || c.state === "installing"
      ) {
        continue;
      }
      if (this.repairBlocks.has(id)) {
        this.set(id, { state: "failed", repairRequired: true });
        continue;
      }
      this.set(id, {
        state: "queued",
        bytesDone: 0,
        bytesPerSecond: null,
        detail: undefined,
        leftovers: undefined,
      });
    }
    this.publish();
    if (!this.running) void this.run();
    return closure;
  }

  /**
   * Whether Arke may take this component away (SPEC-033 R-43).
   *
   * Two conditions, and both are about ownership rather than convenience.
   *
   * **Optional only.** A non-optional component is fetched again by the next launch, because
   * setup's state lives in memory and the catalogue rebuilds it on every start. Offering Remove
   * for one would reclaim 400 MB until the app reopened, which is a control that undoes itself.
   *
   * **Nothing in a folder the user mapped.** A recipe's weight entry writes into the ComfyUI
   * models folder somebody pointed us at, under the canonical names any existing install already
   * uses — and `install` deliberately treats a file already there as the user's, recognised
   * rather than re-fetched (SPEC-021 R-8). So a component can be `present` *because they already
   * had the weights*, and removing it would delete a checkpoint Arke never fetched, from a folder
   * Arke does not own, with no confirmation and no undo.
   */
  private removable(entry: CatalogueEntry): boolean {
    if (entry.optional !== true) return false;
    const spec = entry.spec;
    if (spec.kind === "files") return spec.externalRoot === undefined;
    return spec.kind === "pull" || spec.kind === "archive" || spec.kind === "tree";
  }

  /**
   * Give the disk back (SPEC-033 R-43), and say what went and what would not.
   *
   * Refused where another component that is still here declares this one — removing Ollama out
   * from under an installed Gemma would leave a model that cannot run and a row that says it is
   * installed (R-44). The refusal names the dependant rather than the rule.
   *
   * Deletion is attempted for everything the entry owns, and a survivor is **named with its path
   * and its size** rather than swallowed: *nothing remains* is a promise no implementation can
   * keep on a platform where a scanner holds a file open, and every implementation would make it
   * (R-45, D14).
   */
  async remove(componentId: string): Promise<{ freedMb: number; leftovers: NonNullable<SetupComponent["leftovers"]> }> {
    const c = this.components.get(componentId);
    if (!c) return { freedMb: 0, leftovers: [] };
    if (!this.removable(c.entry)) {
      this.set(componentId, { detail: "Arke did not put this here, so it will not take it away" });
      this.publish();
      return { freedMb: 0, leftovers: [] };
    }
    // Anything that still needs it, whether or not that thing has finished arriving: a download
    // in flight is as much a dependant as one that landed.
    const dependant = [...this.components.values()].find(
      (other) =>
        other.id !== componentId &&
        other.state !== "skipped" &&
        other.state !== "available" &&
        (other.entry.requires ?? []).includes(componentId),
    );
    if (dependant) {
      this.set(componentId, { detail: `${dependant.displayName} needs this` });
      this.publish();
      return { freedMb: 0, leftovers: [] };
    }
    const spec = c.entry.spec;
    // A pulled model belongs to the runtime that pulled it, and that runtime is the only thing
    // that can take it back — `rm -rf` on a store we do not own is not a removal, it is damage.
    if (spec.kind === "pull") {
      const model = spec.args[spec.args.length - 1] ?? "";
      const result = await this.deps
        .run(spec.command, ["rm", model], this.abort.signal)
        .catch(() => ({ code: 1, output: "" }));
      const ok = result.code === 0;
      this.set(componentId, {
        state: ok ? "available" : c.state,
        bytesDone: 0,
        bytesPerSecond: null,
        leftovers: undefined,
        detail: ok
          ? `removed · ${gb(c.entry.sizeMb)} free`
          : `${spec.command} could not remove ${model}${firstLine(result.output) ? ` — ${firstLine(result.output)}` : ""}`,
      });
      this.publish();
      return { freedMb: ok ? c.entry.sizeMb : 0, leftovers: [] };
    }
    // A `files` entry owns exactly the files it declares; an archive or a tree owns the folder
    // Arke extracted it into, under the app's own root. `installer` never reaches here — the
    // removable test refuses it, because a third-party installer owns what it put down.
    const targets: string[] =
      spec.kind === "files"
        ? spec.files.map((file) => join(this.filesRoot(spec) ?? this.modelsDir(), spec.dir, file.file))
        : spec.kind === "archive" || spec.kind === "tree"
          ? [this.toolDir(spec)]
          : [];
    if (targets.length === 0) return { freedMb: 0, leftovers: [] };
    let freed = 0;
    const leftovers: NonNullable<SetupComponent["leftovers"]> = [];
    for (const target of targets) {
      const size = await directorySize(target);
      await rm(toExtendedLength(target), { recursive: true, force: true }).catch(() => {});
      // `stat` failing is not the same as the file being gone — a volume that went away answers
      // the same way an absent file does, and reporting that as clean is the lie R-45 forbids.
      const survivor = await firstExisting([target]);
      if (survivor !== null) leftovers.push({ path: target, sizeMb: Math.round(size / (1024 * 1024)) });
      else freed += size;
    }
    this.set(componentId, {
      state: "available",
      bytesDone: 0,
      bytesPerSecond: null,
      repairRequired: undefined,
      detail:
        leftovers.length === 0
          ? `removed · ${gb(Math.round(freed / (1024 * 1024)))} free`
          : `${leftovers.length} could not be removed — reclaim from Downloads`,
      leftovers: leftovers.length > 0 ? leftovers : undefined,
    });
    this.publish();
    return { freedMb: Math.round(freed / (1024 * 1024)), leftovers };
  }

  /** Remove Arke-managed model files so a repair re-download cannot trust corrupt presence. */
  async repair(componentId: string): Promise<boolean> {
    const c = this.components.get(componentId);
    if (!c || c.entry.spec.kind !== "files") return false;
    const spec = c.entry.spec;
    const root = this.filesRoot(spec);
    if (root === null) {
      this.set(componentId, {
        state: "blocked",
        detail: "no models folder is mapped for this engine — set one in Settings",
        repairRequired: undefined,
        blockedBy: "models-folder",
      });
      this.publish();
      return false;
    }
    const targets = spec.files.map((file) => ({ path: join(root, spec.dir, file.file), label: file.file }));
    const failures = new Map<string, string>();
    if (spec.externalRoot !== undefined) {
      // A user-owned folder is never recursively deleted (SPEC-021 §2.4): repair removes
      // exactly the files this entry names, one by one, and touches nothing beside them.
      for (const target of targets) {
        await rm(toExtendedLength(target.path), { force: true }).catch((err) => {
          failures.set(target.path, errorCode(err));
        });
      }
    } else {
      await rm(toExtendedLength(join(root, spec.dir)), { recursive: true, force: true }).catch((err) => {
        for (const target of targets) failures.set(target.path, errorCode(err));
      });
    }
    const survivor = await firstExisting(targets.map((target) => target.path));
    if (survivor === "unknown") {
      const target = targets.find((candidate) => failures.has(candidate.path)) ?? targets[0]!;
      const detail = `${target.label} could not be removed — close the engine and try Repair again (${failures.get(target.path) ?? "could not verify deletion"})`;
      this.repairBlocks.set(componentId, { root, targets, detail });
      this.set(componentId, { state: "failed", bytesPerSecond: null, detail, repairRequired: true });
      this.publish();
      return false;
    }
    if (survivor !== null) {
      const target = targets.find((candidate) => candidate.path === survivor)!;
      const detail = `${target.label} could not be removed — close the engine and try Repair again (${failures.get(survivor) ?? "still present"})`;
      this.repairBlocks.set(componentId, { root, targets, detail });
      this.set(componentId, {
        state: "failed",
        bytesPerSecond: null,
        detail,
        repairRequired: true,
      });
      this.publish();
      return false;
    }
    this.repairBlocks.delete(componentId);
    this.set(componentId, {
      state: "queued",
      bytesDone: 0,
      bytesPerSecond: null,
      detail: undefined,
      repairRequired: undefined,
    });
    this.publish();
    return true;
  }

  /** Stop everything and discard only partials whose current catalogue receipt proves ownership. */
  async cancel(): Promise<void> {
    const stopped = new Set<string>();
    if (this.activeTransfer !== null) {
      this.activeTransfer.preserve = null;
      this.activeTransfer.abort.abort();
    }
    this.abort.abort();
    for (const [id, c] of this.components) {
      if (c.state === "downloading" || c.state === "paused" || c.state === "installing" || c.state === "queued") {
        stopped.add(id);
        this.set(id, {
          state: "skipped",
          bytesDone: 0,
          bytesPerSecond: null,
          pauseSupported: false,
          detail: "stopped",
        });
      }
    }
    this.publish();
    await this.inFlight;
    await Promise.all(this.receiptUpdates);
    for (const component of this.components.values()) {
      const leftovers = await this.discardOwned(component.entry);
      if (leftovers.length > 0) this.set(component.id, { leftovers });
    }
    for (const id of stopped) {
      this.set(id, { state: "skipped", bytesDone: 0, bytesPerSecond: null, pauseSupported: false, detail: "stopped" });
    }
    this.publish();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.activeTransfer !== null) {
      // Only a range-capable source can survive as useful work. Keeping bytes from an ordinary
      // 200 response would strand an unresumable partial on the next launch.
      this.activeTransfer.preserve = this.activeTransfer.rangeSupported ? "dispose" : null;
      this.activeTransfer.abort.abort();
    }
    this.abort.abort();
    await this.inFlight;
    await Promise.all(this.receiptUpdates);
  }
}

function gb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

function firstLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
}

async function firstExisting(paths: readonly string[]): Promise<string | "unknown" | null> {
  for (const path of paths) {
    try {
      await stat(toExtendedLength(path));
      return path;
    } catch (err) {
      if (errorCode(err) !== "ENOENT") return "unknown";
    }
  }
  return null;
}

function errorCode(err: unknown): string {
  if (typeof err === "object" && err !== null && "code" in err && typeof err.code === "string") return err.code;
  return "filesystem error";
}

/** Bytes under a path, file or directory, or 0 where nothing is readable there. */
async function directorySize(path: string): Promise<number> {
  const info = await stat(toExtendedLength(path)).catch(() => null);
  if (info === null) return 0;
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const entry of await readdir(toExtendedLength(path), { withFileTypes: true }).catch(() => [])) {
    total += await directorySize(join(path, entry.name));
  }
  return total;
}
