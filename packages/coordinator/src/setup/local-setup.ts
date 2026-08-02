import { createWriteStream } from "node:fs";
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
}

export interface SetupOptions {
  /** Where downloaded models live: <appRoot>/models. */
  appRoot: string;
  catalogue?: readonly CatalogueEntry[];
  /** Progress is noisy; emit at most this often per component. */
  throttleMs?: number;
  /** Refuse to start without this much headroom beyond the download itself. */
  headroomMb?: number;
}

interface Live extends SetupComponent {
  entry: CatalogueEntry;
}

const DEFAULT_THROTTLE_MS = 400;
const DEFAULT_HEADROOM_MB = 2000;

export class LocalSetupService {
  private readonly components = new Map<string, Live>();
  private readonly abort = new AbortController();
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
    const spec = entry.spec;
    if (spec.kind === "installer") {
      if (await this.deps.probeUrl("http://127.0.0.1:11434/api/version")) return true;
      return (await this.deps.which("ollama")) !== null;
    }
    if (spec.kind === "pull") {
      const listed = await this.deps.run(spec.command, ["list"], this.abort.signal).catch(() => null);
      if (!listed || listed.code !== 0) return false;
      const wanted = spec.args[spec.args.length - 1] ?? "";
      // The exact tag: gemma4:12b and gemma4:e2b are different models on the same shelf.
      return listed.output.split(/\r?\n/).some((line) => line.trim().split(/\s+/)[0] === wanted);
    }
    for (const f of spec.files) {
      const path = join(this.modelsDir(), spec.dir, f.file);
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
    const neededMb = outstanding.reduce((sum, c) => sum + c.sizeMb, 0);
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

  private async install(entry: CatalogueEntry): Promise<void> {
    const spec = entry.spec;
    try {
      if (spec.kind === "files") {
        const dir = join(this.modelsDir(), spec.dir);
        this.set(entry.id, { state: "downloading", bytesDone: 0, detail: undefined });
        this.publish();
        let done = 0;
        for (const f of spec.files) {
          done += await this.download(entry.id, f, join(dir, f.file), done);
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

    try {
      for await (const chunk of res.body) {
        if (this.abort.signal.aborted) throw new Error("stopped");
        if (head.length < 4) head = [...head, ...Array.from(chunk.subarray(0, 4 - head.length))];
        received += chunk.byteLength;
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
