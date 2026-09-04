import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
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
  /** Streamed GET. `contentLength` is null when the server does not say. */
  fetchStream(
    url: string,
    signal: AbortSignal,
  ): Promise<{ ok: boolean; status: number; contentLength: number | null; body: AsyncIterable<Uint8Array> }>;
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
  }

  private modelsDir(): string {
    return join(this.opts.appRoot, "models");
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
        this.set(id, {
          state: "present",
          bytesDone: c.bytesTotal,
          bytesPerSecond: null,
          repairRequired: undefined,
        });
      } else if (c.state === "present") {
        this.set(id, { state: c.entry.optional === true ? "available" : "queued", bytesDone: 0 });
      }
    }
    this.diskFreeMb = await this.deps.diskFreeMb(this.opts.appRoot).catch(() => null);
    this.diskCheckedAt = new Date().toISOString();
    this.publish();
  }

  /** Remove leftover fragments, and any directory emptied by doing so. */
  private async sweepPartials(dir: string): Promise<void> {
    const entries = await readdir(toExtendedLength(dir), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        await this.sweepPartials(path);
        const left = await readdir(toExtendedLength(path)).catch(() => ["keep"]);
        if (left.length === 0) await rm(toExtendedLength(path), { recursive: true, force: true }).catch(() => {});
      } else if (e.name.endsWith(".partial")) {
        await rm(toExtendedLength(path), { force: true }).catch(() => {});
      }
    }
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
    // Nothing is in flight here (one run at a time), so any .partial is the debris of a run
    // that was cancelled or killed. Sweep it: a fragment must never quietly become a file.
    await this.sweepPartials(this.modelsDir());
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
      group.needMb += c.entry.installedMb ?? c.sizeMb;
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
        await this.install(live.entry);
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
        this.set(entry.id, { state: "downloading", bytesDone: 0, detail: undefined });
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
        await rm(toExtendedLength(staged), { recursive: true, force: true }).catch(() => {});
        const archive = join(staged, spec.file.file);
        this.set(entry.id, { state: "downloading", bytesDone: 0, detail: undefined });
        this.publish();
        const received = await this.download(entry.id, spec.file, archive, 0);

        this.set(entry.id, { state: "installing", bytesPerSecond: null, detail: "unpacking" });
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
          ...(entry.caveat !== undefined ? { detail: entry.caveat } : { detail: undefined }),
        });
        this.publish();
        await this.componentReady(entry.id);
        return;
      }

      if (spec.kind === "installer") {
        const staged = join(this.modelsDir(), ".staging", spec.file.file);
        this.set(entry.id, { state: "downloading", bytesDone: 0, detail: undefined });
        this.publish();
        await this.download(entry.id, spec.file, staged, 0);

        this.set(entry.id, { state: "installing", bytesPerSecond: null, detail: "running Ollama's own installer" });
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
        this.set(entry.id, { state: "ready", detail: undefined, bytesPerSecond: null });
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
        this.set(entry.id, { state: "downloading", bytesDone: 0, detail: undefined });
        this.publish();
        const received = await this.download(entry.id, file, archive, 0);

        this.set(entry.id, { state: "installing", bytesPerSecond: null, detail: "unpacking" });
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
        this.set(entry.id, { state: "ready", bytesDone: received, bytesPerSecond: null, detail: undefined });
        this.publish();
        await this.componentReady(entry.id);
        return;
      }

      // A pull: the runtime fetches its own model and reports its own progress; ours is coarse.
      this.set(entry.id, { state: "installing", detail: `${spec.command} ${spec.args.join(" ")}`, bytesPerSecond: null });
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
      if (this.abort.signal.aborted && !(err instanceof IncompleteDownloadCleanupError)) {
        this.set(entry.id, { state: "skipped", bytesPerSecond: null, detail: "stopped" });
      } else {
        this.set(entry.id, { state: "failed", detail: err instanceof Error ? err.message : String(err) });
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

  /** Stream one file to disk. Returns the bytes it contributed. */
  private async download(componentId: string, spec: DownloadFile, target: string, alreadyDone: number): Promise<number> {
    const res = await this.deps.fetchStream(spec.url, this.abort.signal);
    if (!res.ok) throw new Error(`${spec.file}: the source answered ${res.status}`);

    await mkdir(toExtendedLength(dirname(target)), { recursive: true });
    // A unique, exclusively-created name is the ownership proof. In a user-mapped folder, a
    // conventional `<target>.partial` may belong to somebody else and must never be truncated or
    // swept. The captured path is cleaned directly, so changing the mapping cannot orphan it.
    const partial = `${target}.${randomUUID()}.partial`;
    const sink = await open(toExtendedLength(partial), "wx");
    const started = Date.now();
    let received = 0;
    let head: number[] = [];
    let lastEmit = 0;
    const hash = spec.sha256 ? createHash("sha256") : null;
    let landed = false;
    let failure: unknown = null;

    try {
      for await (const chunk of res.body) {
        if (this.abort.signal.aborted) throw new Error("stopped");
        // Eight bytes, not four: the 7z signature is six, and a head shorter than the declared
        // magic can never match it — which read as "not the file we asked for" on a good file.
        if (head.length < 8) head = [...head, ...Array.from(chunk.subarray(0, 8 - head.length))];
        received += chunk.byteLength;
        hash?.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await sink.write(chunk, offset, chunk.byteLength - offset, null);
          if (bytesWritten === 0) throw new Error(`${spec.file}: the incomplete download could not be written`);
          offset += bytesWritten;
        }

        const now = Date.now();
        if (now - lastEmit >= (this.opts.throttleMs ?? DEFAULT_THROTTLE_MS)) {
          lastEmit = now;
          const elapsed = Math.max(1, now - started) / 1000;
          this.set(componentId, {
            bytesDone: alreadyDone + received,
            bytesPerSecond: Math.round(received / elapsed),
          });
          this.publish();
        }
      }
      if (this.abort.signal.aborted) throw new Error("stopped");

      if (spec.magic && !spec.magic.every((b, i) => head[i] === b)) {
        throw new Error(`${spec.file}: what arrived is not the file we asked for`);
      }
      if (res.contentLength !== null && received !== res.contentLength) {
        throw new Error(`${spec.file}: the download stopped short (${received} of ${res.contentLength} bytes)`);
      }
      if (spec.sha256 && hash?.digest("hex") !== spec.sha256) {
        throw new Error(`${spec.file}: checksum mismatch`);
      }

      await sink.close();
      // Only a whole file ever takes the real name — a partial is never mistaken for presence.
      await rm(toExtendedLength(target), { force: true }).catch(() => {});
      await rename(toExtendedLength(partial), toExtendedLength(target));
      landed = true;
    } catch (err) {
      failure = err;
    }

    await sink.close().catch(() => {});
    if (!landed) {
      try {
        await rm(toExtendedLength(partial), { force: true });
      } catch (err) {
        // Named with its path and its size, on the component, so Downloads can offer to reclaim
        // it. A message alone says a file survived and gives nobody a way to act on it (R-45).
        this.set(componentId, {
          leftovers: [{ path: partial, sizeMb: Math.round(received / (1024 * 1024)) }],
        });
        throw new IncompleteDownloadCleanupError(
          `${spec.file}: the incomplete download could not be removed (${errorCode(err)})`,
        );
      }
      throw failure;
    }
    return received;
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
    if (!c || c.state === "ready" || c.state === "present") return;
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
    for (const id of closure.componentIds) {
      const c = this.components.get(id);
      // Anything already on its way is left exactly as it is. Re-queuing a component that is
      // 60% through its download zeroes its bytes and takes the bar off both surfaces, so the
      // person who pressed Install on a second model is told the first transfer stopped.
      if (!c || componentIsSettled(c.state) || c.state === "queued" || c.state === "downloading" || c.state === "installing") {
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

  /** Stop everything in flight. Whatever finished stays; nothing half-written survives. */
  async cancel(): Promise<void> {
    this.abort.abort();
    for (const [id, c] of this.components) {
      if (c.state === "downloading" || c.state === "installing" || c.state === "queued") {
        this.set(id, { state: "skipped", bytesPerSecond: null, detail: "stopped" });
      }
    }
    this.publish();
    await this.inFlight;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.abort.abort();
    await this.inFlight;
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
