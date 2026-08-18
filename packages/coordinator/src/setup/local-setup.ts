import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DomainEvent, SetupComponent, SetupStatus } from "@arke-studio/contracts";
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
   * Whether this component already exists somewhere Arke does not manage (SPEC-021 D10) —
   * a user-directed engine, a live default port, a well-known install. Consulted before the
   * component's own files are even looked at, so detection always wins over installation.
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
}

interface Live extends SetupComponent {
  entry: CatalogueEntry;
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
  private running = false;
  private disposed = false;
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
        state: entry.optional === true ? "available" : "queued",
        bytesDone: 0,
        bytesTotal: entry.sizeMb * 1024 * 1024,
        bytesPerSecond: null,
        ...(entry.caveat !== undefined ? { detail: entry.caveat } : {}),
      });
    }
  }

  status(): SetupStatus {
    return {
      components: [...this.components.values()].map(({ entry: _entry, ...c }) => c),
      running: this.running,
      diskFreeMb: this.diskFreeMb,
    };
  }

  private publish(): void {
    if (this.disposed) return;
    this.emit({ at: new Date().toISOString(), type: "setup.status", setup: this.status() });
  }

  private set(id: string, patch: Partial<SetupComponent>): void {
    const current = this.components.get(id);
    if (!current) return;
    this.components.set(id, { ...current, ...patch });
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
      const present = await this.isPresent(c.entry).catch(() => false);
      if (present) {
        this.set(id, { state: "present", bytesDone: c.bytesTotal, bytesPerSecond: null });
      } else if (c.state === "present") {
        this.set(id, { state: c.entry.optional === true ? "available" : "queued", bytesDone: 0 });
      }
    }
    this.diskFreeMb = await this.deps.diskFreeMb(this.opts.appRoot).catch(() => null);
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
    // Detection always wins over installation (SPEC-021 D10): an install Arke does not manage
    // is presence, and the managed copy is never fetched over it.
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

    const outstanding = [...this.components.values()].filter((c) => c.state === "queued");
    if (outstanding.length === 0) return;

    // The guard: refuse to start a download this disk cannot hold, with both figures.
    // What it costs on disk, not what it costs to fetch: an extracted component needs room for
    // the archive and the tree at once. Guarding on the download alone let a disk with 5 GB
    // free start a 2 GB download that dies part-way through unpacking — the silent mid-way
    // failure this guard exists to replace with a refusal.
    const neededMb = outstanding.reduce((sum, c) => sum + (c.entry.installedMb ?? c.sizeMb), 0);
    const headroom = this.opts.headroomMb ?? DEFAULT_HEADROOM_MB;
    if (this.diskFreeMb !== null && this.diskFreeMb < neededMb + headroom) {
      for (const c of outstanding) {
        this.set(c.id, {
          state: "blocked",
          detail: `needs ${gb(neededMb)} plus room to work; this disk has ${gb(this.diskFreeMb)} free`,
        });
      }
      this.publish();
      return;
    }

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
          this.set(c.id, { state: "blocked", detail: `waiting on ${this.components.get(blocker)?.displayName ?? blocker}` });
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
        const filesRoot = this.filesRoot(spec);
        if (filesRoot === null) {
          this.set(entry.id, {
            state: "blocked",
            detail: "no models folder is mapped for this engine — set one in Settings",
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
          ...(entry.caveat !== undefined ? { detail: entry.caveat } : { detail: undefined }),
        });
        this.publish();
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
              detail: "Ollama's installer did not finish — run it yourself from Settings · Local runtime",
            });
            this.publish();
            return;
          }
        }
        await rm(toExtendedLength(staged), { force: true }).catch(() => {});
        this.set(entry.id, { state: "ready", detail: undefined, bytesPerSecond: null });
        this.publish();
        return;
      }

      if (spec.kind === "archive") {
        const file = this.archiveFor(spec);
        if (file === null) {
          this.set(entry.id, {
            state: "blocked",
            detail: `no ${entry.displayName} build is published for this machine's architecture`,
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
    } catch (err) {
      if (this.abort.signal.aborted) {
        this.set(entry.id, { state: "queued", bytesPerSecond: null, detail: "stopped" });
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
    const partial = `${target}.partial`;
    const sink = createWriteStream(toExtendedLength(partial));
    const started = Date.now();
    let received = 0;
    let head: number[] = [];
    let lastEmit = 0;
    const hash = spec.sha256 ? createHash("sha256") : null;

    try {
      for await (const chunk of res.body) {
        if (this.abort.signal.aborted) throw new Error("stopped");
        // Eight bytes, not four: the 7z signature is six, and a head shorter than the declared
        // magic can never match it — which read as "not the file we asked for" on a good file.
        if (head.length < 8) head = [...head, ...Array.from(chunk.subarray(0, 8 - head.length))];
        received += chunk.byteLength;
        hash?.update(chunk);
        if (!sink.write(chunk)) await new Promise<void>((r) => sink.once("drain", () => r()));

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
    } finally {
      await new Promise<void>((resolve) => sink.end(resolve));
    }

    if (spec.magic && !spec.magic.every((b, i) => head[i] === b)) {
      await rm(toExtendedLength(partial), { force: true }).catch(() => {});
      throw new Error(`${spec.file}: what arrived is not the file we asked for`);
    }
    if (res.contentLength !== null && received !== res.contentLength) {
      await rm(toExtendedLength(partial), { force: true }).catch(() => {});
      throw new Error(`${spec.file}: the download stopped short (${received} of ${res.contentLength} bytes)`);
    }
    if (spec.sha256 && hash?.digest("hex") !== spec.sha256) {
      await rm(toExtendedLength(partial), { force: true }).catch(() => {});
      throw new Error(`${spec.file}: checksum mismatch`);
    }

    // Only a whole file ever takes the real name — a partial is never mistaken for presence.
    await rm(toExtendedLength(target), { force: true }).catch(() => {});
    await rename(toExtendedLength(partial), toExtendedLength(target));
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
    this.set(componentId, { state: "queued", bytesDone: 0, bytesPerSecond: null, detail: undefined });
    this.publish();
    if (!this.running) void this.run();
  }

  /** Remove Arke-managed model files so a repair re-download cannot trust corrupt presence. */
  async repair(componentId: string): Promise<void> {
    const c = this.components.get(componentId);
    if (!c || c.entry.spec.kind !== "files") return;
    const spec = c.entry.spec;
    if (spec.externalRoot !== undefined) {
      // A user-owned folder is never recursively deleted (SPEC-021 §2.4): repair removes
      // exactly the files this entry names, one by one, and touches nothing beside them.
      const root = this.filesRoot(spec);
      if (root !== null) {
        for (const f of spec.files) {
          await rm(toExtendedLength(join(root, spec.dir, f.file)), { force: true }).catch(() => {});
        }
      }
    } else {
      await rm(toExtendedLength(join(this.modelsDir(), spec.dir)), { recursive: true, force: true });
    }
    this.set(componentId, { state: "queued", bytesDone: 0, bytesPerSecond: null, detail: undefined });
    this.publish();
  }

  /** Stop everything in flight. Whatever finished stays; nothing half-written survives. */
  cancel(): void {
    this.abort.abort();
    for (const [id, c] of this.components) {
      if (c.state === "downloading" || c.state === "installing" || c.state === "queued") {
        this.set(id, { state: "skipped", bytesPerSecond: null, detail: "stopped" });
      }
    }
    this.running = false;
    this.publish();
  }

  dispose(): void {
    this.disposed = true;
    this.abort.abort();
  }
}

function gb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

function firstLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
}
