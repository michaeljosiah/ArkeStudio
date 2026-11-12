import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { isSupervisedProcessOrigin, type SupervisedProcessOrigin } from "../supervisor.js";
import { windowsConnectionOrigin } from "./windows-connection-origin.js";

const LIMIT = 4 * 1024 ** 2, FRAGMENTS = 16_384;
const refused = () => new Error("The managed private connection could not be verified or completed.");
export interface VerifiedHttpOptions {
  origin: SupervisedProcessOrigin;
  /** Captured service selection/install/shutdown fence, in addition to direct child identity. */
  current(): boolean;
  /** Trusted native/test port. The default refuses platforms without qualified native proof. */
  verify?: typeof windowsConnectionOrigin;
  timeoutMs?: number;
  shutdownMs?: number;
}
export interface VerifiedHttpPolicy {
  requestBytes: number;
  responseBytes: number;
  responseType: "application/json" | "text/event-stream";
  /** Native JSON API status is needed for exact session retirement; raw errors never pass. */
  nativeStatuses?: boolean;
  /** Rechecked immediately before writing; existing response observation stays independent. */
  beforeWrite?(): boolean;
  preparedSocket?: boolean;
}
interface Collected { bytes: Buffer | null; status: number; type: string }
interface VerifiedSocket { socket: Socket; closed: Promise<void>; clientPort: number; serverPort: number; expiry?: ReturnType<typeof setTimeout> }

/** Shared finite private transport for the bounded Studio provider and writer (SPEC-061).
 * Connect first, verify that exact socket, then send. No fetch pool, redirect, proxy, DNS,
 * reconnect or retry may substitute a different socket after proof. HTTP completion/cleanup
 * never confirms native inference completion or releases GPU ownership. */
export abstract class VerifiedLoopbackHttpTransport {
  private readonly origin: SupervisedProcessOrigin;
  private readonly ownerCurrent: () => boolean;
  private readonly verify: typeof windowsConnectionOrigin;
  private readonly timeoutMs: number;
  private readonly shutdownMs: number;
  private readonly lifetime = new AbortController();
  private readonly work = new Set<Promise<unknown>>();
  private readonly sockets = new Set<VerifiedSocket>();
  private readonly prepared = new Set<VerifiedSocket>();
  private stopping = false;

  constructor(options: VerifiedHttpOptions, maximumTimeoutMs = 180_000) {
    if (!isSupervisedProcessOrigin(options.origin)) throw refused();
    this.origin = options.origin; this.ownerCurrent = options.current; this.verify = options.verify ?? windowsConnectionOrigin;
    this.timeoutMs = options.timeoutMs ?? 180_000; this.shutdownMs = options.shutdownMs ?? 1000;
    if (![180_000, 900_000].includes(maximumTimeoutMs) || !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > maximumTimeoutMs ||
      !Number.isSafeInteger(this.shutdownMs) || this.shutdownMs < 1 || this.shutdownMs > 5000) throw refused();
  }
  protected available(): boolean {
    try { return !this.stopping && this.origin.current() && this.ownerCurrent(); } catch { return false; }
  }
  protected abstract policy(url: URL, method: string, body: string, headers: Headers): VerifiedHttpPolicy;
  /** One-use, unwritten connections. Proof happens before the native one-second metadata
   * window; responses remain fresh reads. No cached metadata or HTTP connection reuse. */
  protected async prepareMetadataSockets(): Promise<void> {
    if (!this.available() || this.work.size || this.sockets.size) throw refused();
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30_000)]), opened: VerifiedSocket[] = [];
    const task = (async () => {
      try {
        for (let index = 0; index < 2; index++) opened.push(await this.openSocket(signal));
        signal.throwIfAborted(); if (!this.available() || opened.some(record => !this.socketCurrent(record))) throw refused();
        for (const record of opened) {
          this.prepared.add(record); record.expiry = setTimeout(() => record.socket.destroy(), 30_000);
        }
      } catch {
        for (const record of opened) record.socket.destroy(); await Promise.all(opened.map(record => record.closed)); throw refused();
      }
    })().finally(() => { this.work.delete(task); });
    this.work.add(task); return task;
  }
  private takePrepared(): VerifiedSocket | undefined {
    for (const record of this.prepared) {
      this.prepared.delete(record); clearTimeout(record.expiry);
      if (!record.socket.destroyed) return record;
    }
    return undefined;
  }
  busy(): boolean { return this.work.size !== 0; }
  readonly fetch: typeof fetch = async (input, init) => {
    try { return await this.request(input, init); } catch { throw refused(); }
  };
  private async request(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]): Promise<Response> {
    if (!this.available() || this.work.size >= 8 || init?.signal?.aborted ||
      Object.keys(init ?? {}).some(key => !["method", "headers", "body", "redirect", "signal"].includes(key))) throw refused();
    if (typeof input !== "string" && !(input instanceof URL)) throw refused();
    const url = new URL(input), base = `http://127.0.0.1:${this.origin.port}`;
    const method = init?.method ?? "GET";
    if (url.href !== base + url.pathname + url.search || !["GET", "POST", "DELETE"].includes(method) || init?.redirect !== undefined && init.redirect !== "error" ||
      method !== "POST" && init?.body !== undefined || method === "POST" && typeof init?.body !== "string") throw refused();
    const body = typeof init?.body === "string" ? init.body : "";
    if (Buffer.byteLength(body) > LIMIT) throw refused();
    const captured = new Headers(init?.headers);
    if ([...captured.keys()].some(key => !["content-type", "authorization"].includes(key)) ||
      captured.has("content-type") && captured.get("content-type") !== "application/json" || (captured.get("authorization")?.length ?? 0) > 16_384) throw refused();
    const policy = Object.freeze({ ...this.policy(url, method, body, captured) });
    if (![policy.requestBytes, policy.responseBytes].every(value => Number.isSafeInteger(value) && value >= 1 && value <= LIMIT) ||
      !["application/json", "text/event-stream"].includes(policy.responseType) || Buffer.byteLength(body) > policy.requestBytes) throw refused();
    const headers = { "content-type": "application/json", "content-length": Buffer.byteLength(body), connection: "close",
      ...(captured.has("authorization") ? { authorization: captured.get("authorization")! } : {}) };
    const control = new AbortController(), signal = AbortSignal.any([this.lifetime.signal, control.signal, ...(init?.signal ? [init.signal] : [])]);
    const timer = setTimeout(() => control.abort(), this.timeoutMs);
    const task = this.execute(url.pathname + url.search, method, headers, body, policy, signal).finally(() => { clearTimeout(timer); this.work.delete(task); });
    this.work.add(task);
    // Abandon observation promptly, retaining the original proof/helper/socket task until
    // its real settlement. A late proof cannot write, publish or unblock a replacement.
    return new Promise<Response>((resolve, reject) => {
      const abort = () => { signal.removeEventListener("abort", abort); reject(refused()); };
      signal.addEventListener("abort", abort, { once: true });
      void task.then(value => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted || !this.available()) reject(refused()); else resolve(value);
      }, () => { signal.removeEventListener("abort", abort); reject(refused()); });
      if (signal.aborted) abort();
    });
  }

  private async openSocket(signal: AbortSignal): Promise<VerifiedSocket> {
    if (!this.available() || signal.aborted || this.sockets.size >= 8) throw refused();
    const socketOptions = { highWaterMark: 16 * 1024, allowHalfOpen: false };
    const socket = new Socket(socketOptions); socket.on("error", () => {}); socket.pause();
    const cancel = () => socket.destroy();
    const closed = new Promise<void>(resolve => socket.once("close", () => {
      this.sockets.delete(record); this.prepared.delete(record); clearTimeout(record.expiry);
      this.lifetime.signal.removeEventListener("abort", cancel); resolve();
    }));
    const record: VerifiedSocket = { socket, closed, clientPort: 0, serverPort: 0 }; this.sockets.add(record);
    this.lifetime.signal.addEventListener("abort", cancel, { once: true }); signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const clean = () => { socket.removeListener("connect", connected); socket.removeListener("error", failed); socket.removeListener("close", failed); };
        const connected = () => { clean(); resolve(); };
        const failed = () => { clean(); reject(refused()); };
        socket.once("connect", connected); socket.once("error", failed); socket.once("close", failed);
        socket.connect({ host: "127.0.0.1", port: this.origin.port });
      });
      const connection = Object.freeze({ clientPort: socket.localPort!, serverPort: socket.remotePort! });
      if (socket.localAddress !== "127.0.0.1" || socket.remoteAddress !== "127.0.0.1" || !this.available() || signal.aborted ||
        !await this.verify(this.origin, connection, signal)) throw refused();
      record.clientPort = connection.clientPort; record.serverPort = connection.serverPort;
      if (!this.socketCurrent(record) || signal.aborted) throw refused();
      return record;
    } catch (error) { socket.destroy(); await closed; throw error; }
    finally { signal.removeEventListener("abort", cancel); }
  }
  private socketCurrent(record: VerifiedSocket): boolean {
    const socket = record.socket;
    return this.available() && !socket.destroyed && socket.bytesWritten === 0 && socket.readableLength === 0 &&
      socket.localPort === record.clientPort && socket.remotePort === record.serverPort;
  }
  private async execute(path: string, method: string, headers: Record<string, string | number>, body: string, policy: VerifiedHttpPolicy, signal: AbortSignal): Promise<Response> {
    const record = (policy.preparedSocket ? this.takePrepared() : undefined) ?? await this.openSocket(signal);
    const { socket, closed } = record;
    let requestOwner: ClientRequest | undefined, requestClosed: Promise<void> | undefined, collection: Promise<Collected> | undefined;
    const cancel = () => socket.destroy(); signal.addEventListener("abort", cancel, { once: true });
    try {
      if (signal.aborted || !this.socketCurrent(record) || policy.beforeWrite && !policy.beforeWrite()) throw refused();
      const result = await new Promise<Collected>((resolve, reject) => {
        // Do not set agent:false: that creates an Agent which may ignore createConnection.
        // Supplying only createConnection makes Node use this already verified socket.
        const request = httpRequest({ hostname: "127.0.0.1", port: this.origin.port, path, method, headers, maxHeaderSize: 8192,
          createConnection: () => socket }, response => { collection = this.collect(response, policy, signal); void collection.then(resolve, reject); });
        requestOwner = request; requestClosed = new Promise<void>(done => request.once("close", () => done()));
        request.once("error", () => reject(refused()));
        request.once("socket", connected => {
          if (connected !== socket || signal.aborted || !this.available() || policy.beforeWrite && !policy.beforeWrite()) request.destroy();
          else socket.resume(); // HTTP's parser is attached before this event and before queued writes flush.
        });
        if (signal.aborted || !this.available() || policy.beforeWrite && !policy.beforeWrite()) request.destroy(); else request.end(body);
      });
      if (signal.aborted || !this.available()) throw refused();
      return new Response(result.bytes, { status: result.status, statusText: result.status >= 400 ? "Private native request refused" : "",
        headers: { "content-type": result.type, "content-length": String(result.bytes?.length ?? 0) } });
    } finally {
      signal.removeEventListener("abort", cancel); requestOwner?.destroy(); socket.destroy();
      await Promise.all([closed, requestClosed, collection?.then(() => {}, () => {})]);
    }
  }
  private async collect(response: IncomingMessage, policy: VerifiedHttpPolicy, signal: AbortSignal): Promise<Collected> {
    const type = policy.responseType, declared = response.headers["content-length"], status = response.statusCode ?? 0;
    try {
      if (policy.nativeStatuses && (status === 204 || status >= 400 && status <= 599)) return { bytes: null, status, type };
      if (!(status === 200 || policy.nativeStatuses && status === 201) || response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== type ||
        declared !== undefined && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > policy.responseBytes)) throw refused();
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of response) {
        signal.throwIfAborted(); if (!this.available()) throw refused();
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > policy.responseBytes || chunks.length >= FRAGMENTS) throw refused();
        chunks.push(bytes);
      }
      return { bytes: Buffer.concat(chunks, size), status, type };
    } finally { response.destroy(); }
  }
  /** Confirms only this HTTP owner's settlement, never service/GPU completion. */
  async stop(): Promise<boolean> {
    this.stopping = true; this.lifetime.abort();
    for (const record of this.sockets) record.socket.destroy();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.allSettled([...this.work, ...Array.from(this.sockets, record => record.closed)]).then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), this.shutdownMs); })]);
    } finally { clearTimeout(timer); }
  }
}
