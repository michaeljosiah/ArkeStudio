import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { z } from "zod";
import { VideoPublicationRequestSchema, type PublicationBridge, type PublicationJob, type PublicationPlayback, type PublicationReply } from "@arke-studio/contracts";
import { prepareVideoPublication, openPublication, parseByteRange, publishPublication, PublicationFileError,
  type PinnedPublication, type PreparedVideoPublication, type PublishedPublication, type WorldProvider, type VideoPublicationCompilerOptions } from "@arke-studio/coordinator";

const REFUSALS: Record<PublicationFileError["code"], string> = {
  "unsafe-path": "The package contains unsafe paths or linked files.",
  "limit-exceeded": "The publication exceeds supported file or size limits.",
  "source-changed": "Source files changed during capture. Check the source and try again.",
  "invalid-package": "The package or source media is invalid or unsupported.",
  "invalid-manifest": "The publication manifest is invalid.",
  "unsupported-schema": "This publication uses an unsupported schema version.",
  "unsupported-profile": "This player does not support the publication profile.",
  "unsupported-capability": "The publication requires unsupported player features.",
  "operation-conflict": "The saved operation conflicts with these settings or is already in use.",
  "incomplete-publication": "Saved publication output is incomplete or damaged. It has been preserved. Create a new edition.",
  "unsupported-codec": "Unsupported codec. Use H.264/AAC MP4 or VP8/VP9 WebM with Opus/Vorbis in 8-bit 4:2:0.",
};

const Start = z.object({ worldId: z.string().min(1), request: VideoPublicationRequestSchema, format: z.enum(["directory", "zip"]) }).strict();
const Intent = Start.extend({ operationId: z.string().uuid(), outputRoot: z.string().min(1), encoderVersion: z.string().min(1).max(256) }).strict();
type Intent = z.infer<typeof Intent>;
class EncoderChanged extends Error {}
const UNREADABLE_RECOVERY = "The saved publication job is unreadable or incompatible. Its files have been preserved. Create a new edition.";
interface Job { intent: Intent; view: PublicationJob; controller?: AbortController; work?: Promise<void>; result?: PublishedPublication }
interface Ports {
  root: string;
  origins: string[];
  providers(): { starting: WorldProvider | null; live: WorldProvider | null };
  pick(kind: "directory" | "zip" | "output"): Promise<string | null>;
  reveal(path: string): void;
  compiler(signal: AbortSignal): Promise<Omit<VideoPublicationCompilerOptions, "scratchRoot">>;
  probe(video: string, type: string, signal?: AbortSignal): Promise<{ duration: number; mediaType: string }>;
}

/** Desktop lifetime owns native dialogs, private intent records, the media endpoint and drains. */
export class PublicationHost implements PublicationBridge {
  private jobs = new Map<string, Job>();
  private recoveryProblems = new Map<string, PublicationJob>();
  private players = new Map<string, PinnedPublication>();
  private ready: Promise<void> | undefined;
  private server: Server | undefined;
  private starting: Promise<void> | undefined;
  private pending = new Set<Promise<unknown>>();
  private controller = new AbortController();
  private playbackController = new AbortController();
  private startingJob = false;
  private opening = false;
  private readonly token = randomBytes(32).toString("hex");
  session: { port: number; token: string } | null = null;
  constructor(private readonly ports: Ports) {}

  private provider(): WorldProvider | null {
    const { starting, live } = this.ports.providers();
    return live ?? starting;
  }

  private initialize(): Promise<void> {
    return this.ready ??= (async () => {
      await mkdir(join(this.ports.root, "operations"), { recursive: true });
      await mkdir(join(this.ports.root, "playback"), { recursive: true });
      for (const name of await readdir(join(this.ports.root, "operations"))) {
        if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
        const path = join(this.ports.root, "operations", name);
        try {
          if ((await stat(path)).size > 1024 * 1024) throw new Error("A publication recovery record is too large.");
          const intent = Intent.parse(JSON.parse(await readFile(path, "utf8")));
          if (name !== `${intent.operationId}.json`) throw new Error("Publication recovery identity mismatch.");
          this.jobs.set(intent.operationId, { intent, view: this.view(intent) });
        } catch {
          // Preserve each bad record and report only its opaque filename identity. One damaged
          // intent must not hide valid jobs or stop unrelated publications opening.
          const operationId = name.slice(0, -5);
          this.recoveryProblems.set(operationId, { operationId, worldId: "", productionId: "", title: "Unreadable publication job",
            status: "failed", phase: "Recovery unavailable", reason: UNREADABLE_RECOVERY, retryable: false });
        }
      }
    })();
  }
  private view(intent: Intent): PublicationJob {
    return { operationId: intent.operationId, worldId: intent.worldId, productionId: intent.request.productionId,
      title: intent.request.title, status: "interrupted", phase: "Check saved output or retry" };
  }
  private reply<T>(work: () => Promise<T>): Promise<PublicationReply<T>> {
    const promise = (async (): Promise<PublicationReply<T>> => {
      try { this.controller.signal.throwIfAborted(); return { ok: true, value: await work() }; }
      catch (error) { return { ok: false, reason: this.reason(error), ...(error instanceof Error && error.name === "AbortError" ? { cancelled: true } : {}) }; }
    })();
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise));
    return promise;
  }
  private reason(error: unknown): string {
    if (error instanceof EncoderChanged) return "The media encoder changed since this job was saved. Create a new edition from the source production.";
    // Domain wrappers can contain nested filesystem errors too. Only fixed copy crosses IPC.
    if (error instanceof PublicationFileError) return `${error.code}: ${REFUSALS[error.code]}`;
    if (error instanceof Error && error.name === "AbortError") return "Publication cancelled.";
    return "The publication could not be processed. Check the package, media tools and available disk space, then retry.";
  }
  private pick(kind: "directory" | "zip" | "output", signal: AbortSignal): Promise<string | null> {
    signal.throwIfAborted();
    // Native file dialogs have no close/abort API. Stop waiting on shutdown or renderer loss;
    // attach both handlers so a later answer cannot resume work or reject unobserved.
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      const cleanup = () => signal.removeEventListener("abort", abort);
      Promise.resolve().then(() => { signal.throwIfAborted(); return this.ports.pick(kind); }).then(
        value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
      if (signal.aborted) { cleanup(); abort(); }
    });
  }
  list() { return this.reply(async () => { await this.initialize(); return [...this.recoveryProblems.values(), ...[...this.jobs.values()].map(job => job.view)].map(view => ({ ...view })); }); }
  start(input: Parameters<PublicationBridge["start"]>[0]) {
    return this.reply(async () => {
      await this.initialize();
      if (this.startingJob || [...this.jobs.values()].some(job => job.work)) throw new Error("A publication is already running.");
      this.startingJob = true;
      try {
        const parsed = Start.parse(input);
        const outputRoot = await this.pick("output", this.controller.signal);
        if (!outputRoot) throw new DOMException("Cancelled", "AbortError");
        this.controller.signal.throwIfAborted();
        const provider = this.provider();
        if (!provider?.assertWritingScratch) throw new Error("World storage is unavailable.");
        await provider.assertWritingScratch(outputRoot);
        const compiler = await this.ports.compiler(this.controller.signal);
        const intent = Intent.parse({ ...parsed, outputRoot, operationId: randomUUID(), encoderVersion: compiler.encoderVersion });
        const temporary = join(this.ports.root, "operations", `${intent.operationId}.tmp`);
        const handle = await open(temporary, "wx");
        try { await handle.writeFile(JSON.stringify(intent) + "\n"); await handle.sync(); }
        finally { await handle.close(); }
        await link(temporary, join(this.ports.root, "operations", `${intent.operationId}.json`));
        await rm(temporary);
        const job: Job = { intent, view: this.view(intent) };
        this.jobs.set(intent.operationId, job);
        this.launch(job);
        return { ...job.view };
      } finally { this.startingJob = false; }
    });
  }
  retry(operationId: string) { return this.reply(async () => {
    await this.initialize();
    if (this.recoveryProblems.has(operationId)) throw new PublicationFileError("incomplete-publication", "Unreadable recovery record.");
    const job = this.jobs.get(operationId);
    if (!job || this.startingJob || [...this.jobs.values()].some(item => item.work)) throw new Error("Publication is unavailable or running.");
    this.launch(job); return { ...job.view };
  }); }
  private launch(job: Job): void {
    this.controller.signal.throwIfAborted();
    const controller = new AbortController(); job.controller = controller;
    const signal = AbortSignal.any([controller.signal, this.controller.signal]);
    job.view = { ...this.view(job.intent), status: "running", phase: "Checking saved output" };
    const { intent } = job;
    job.work = (async () => {
      try {
        const requestFingerprint = createHash("sha256").update(JSON.stringify({ request: intent.request, world: intent.worldId, encoder: intent.encoderVersion })).digest("hex");
        job.result = await publishPublication({ operationId: intent.operationId, publicationId: intent.request.id, requestFingerprint, format: intent.format }, async scratchRoot => {
          const compiler = await this.ports.compiler(signal);
          if (compiler.encoderVersion !== intent.encoderVersion) throw new EncoderChanged();
          const provider = this.provider();
          if (!provider?.withWorldStore) throw new Error("World is unavailable.");
          job.view.phase = "Capturing";
          let prepared: PreparedVideoPublication | undefined;
          try {
            await provider.withWorldStore(intent.worldId, async store => {
              prepared = await prepareVideoPublication(store, intent.request, { ...compiler, scratchRoot, signal,
                onProgress: value => { job.view.phase = value >= 100 ? "Verifying package" : "Rendering"; } });
            });
            job.view.phase = "Rendering";
            return await prepared!.render();
          } finally { await prepared?.dispose(); }
        }, { outputRoot: intent.outputRoot, signal, onPhase: phase => { job.view.phase = phase === "prepared" ? "Publishing" : "Verifying output"; } });
        job.view = { ...job.view, status: "completed", phase: "Ready to play" };
      } catch (error) {
        const permanent = error instanceof EncoderChanged || error instanceof PublicationFileError && error.code === "incomplete-publication";
        job.view = { ...job.view, status: signal.aborted ? "cancelled" : "failed", phase: permanent ? "Create a new edition" : "Check or retry",
          reason: this.reason(error), ...(permanent ? { retryable: false } : {}) };
      } finally { delete job.work; delete job.controller; }
    })();
  }
  async cancel(operationId: string): Promise<void> { const job = this.jobs.get(operationId); job?.controller?.abort(); await job?.work; }
  reveal(operationId: string) { return this.reply(async () => {
    const result = this.jobs.get(operationId)?.result;
    if (!result) throw new Error("Check the saved output first.");
    this.ports.reveal(result.path); return null;
  }); }
  open(kind: Parameters<PublicationBridge["open"]>[0]) {
    return this.reply(async () => {
      if (this.opening) throw new Error("A publication is already opening.");
      if (this.players.size >= 2) throw new PublicationFileError("operation-conflict", "Close an unused playback session before opening another.");
      this.opening = true;
      const signal = AbortSignal.any([this.controller.signal, this.playbackController.signal]);
      try {
        await mkdir(join(this.ports.root, "playback"), { recursive: true });
        let source: string | null; let format: "directory" | "zip";
        if (kind === "directory" || kind === "zip") { format = kind; source = await this.pick(kind, signal); }
        else {
          await this.initialize();
          const parsed = z.object({ operationId: z.string().uuid() }).strict().parse(kind);
          const result = this.jobs.get(parsed.operationId)?.result;
          if (!result) throw new Error("Check the saved output first.");
          source = result.path; format = result.format;
        }
        if (!source) throw new DOMException("Cancelled", "AbortError");
        signal.throwIfAborted();
        const pinned = await openPublication(source, format, join(this.ports.root, "playback"), this.ports.probe, { signal });
        try {
          await this.listen();
          signal.throwIfAborted();
          // Keep the current session until the renderer has mounted this successful replacement.
          // The two-session bound allows that handoff without retaining an unbounded library.
          const sessionId = randomUUID();
          this.players.set(sessionId, pinned);
          const assets = Object.fromEntries(Object.keys(pinned.manifest.assets).map(id => [id, `http://127.0.0.1:${this.session!.port}/media/${sessionId}/${id}`]));
          return { sessionId, manifest: pinned.manifest, manifestSha256: pinned.manifestSha256, mediaType: pinned.mediaType, assets } satisfies PublicationPlayback;
        } catch (error) { await pinned.dispose(); throw error; }
      } finally { this.opening = false; }
    });
  }
  close(sessionId: string): Promise<void> {
    const pinned = this.players.get(sessionId); this.players.delete(sessionId);
    const work = pinned?.dispose() ?? Promise.resolve();
    // A route can begin closing just before shutdown takes its snapshot. Keep that disposal
    // in the drain even though its asset ids have already been withdrawn from the endpoint.
    this.pending.add(work);
    void work.then(() => this.pending.delete(work), () => this.pending.delete(work));
    return work;
  }
  /** Renderer reload/crash loses session ids, but must not cancel host-owned publication jobs. */
  async resetPlayback(): Promise<void> {
    this.playbackController.abort();
    this.playbackController = new AbortController();
    await Promise.all([...this.players.keys()].map(id => this.close(id)));
  }
  private listen(): Promise<void> {
    return this.starting ??= new Promise((resolve, reject) => {
      const server = createServer((request, response) => {
        const supplied = request.headers.authorization;
        const expected = `Bearer ${this.token}`;
        if (typeof supplied !== "string" || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)) ||
          (request.headers.origin !== undefined && !this.ports.origins.includes(request.headers.origin))) { response.writeHead(401).end(); return; }
        if (request.headers.origin) response.setHeader("Access-Control-Allow-Origin", request.headers.origin);
        response.setHeader("Cache-Control", "no-store"); response.setHeader("X-Content-Type-Options", "nosniff");
        const match = /^\/media\/([0-9a-f-]{36})\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})$/.exec(request.url ?? "");
        const pinned = match ? this.players.get(match[1]!) : undefined;
        const asset = pinned && match && Object.hasOwn(pinned.manifest.assets, match[2]!) ? pinned.manifest.assets[match[2]!] : undefined;
        if (request.method !== "GET" || !pinned || !asset) { response.writeHead(404).end(); return; }
        const range = parseByteRange(request.headers.range, asset.byteLength);
        if (range === "unsatisfiable") { response.writeHead(416, { "Content-Range": `bytes */${asset.byteLength}` }).end(); return; }
        response.setHeader("Content-Type", asset.mediaType); response.setHeader("Accept-Ranges", "bytes");
        response.setHeader("Content-Length", range ? range.end - range.start + 1 : asset.byteLength);
        if (range) response.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${asset.byteLength}`);
        response.writeHead(range ? 206 : 200);
        const stream = createReadStream(join(pinned.directory, asset.href), range ?? {});
        stream.on("error", () => response.destroy()); response.on("close", () => stream.destroy()); stream.pipe(response);
      });
      this.server = server;
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") { reject(new Error("No media endpoint")); return; }
        this.session = { port: address.port, token: this.token }; resolve();
      });
    });
  }
  async stop(): Promise<void> {
    this.controller.abort();
    await Promise.allSettled([...this.pending, ...[...this.jobs.values()].flatMap(job => job.work ? [job.work] : [])]);
    if (this.server) { this.server.closeAllConnections(); await new Promise<void>(resolve => this.server!.close(() => resolve())); }
    for (const id of this.players.keys()) await this.close(id);
    this.session = null;
  }
}
