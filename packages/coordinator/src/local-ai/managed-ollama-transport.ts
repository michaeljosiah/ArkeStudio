import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { isSupervisedProcessOrigin, type SupervisedProcessOrigin } from "../supervisor.js";
import { windowsConnectionOrigin } from "./windows-connection-origin.js";

const LIMIT = 1024 ** 2, FRAGMENTS = 16_384;
const refused = () => new Error("The managed private connection could not be verified or completed.");
interface Options {
  origin: SupervisedProcessOrigin;
  /** Captured service selection/install/shutdown fence, in addition to direct child identity. */
  current(): boolean;
  /** Trusted native/test port. The default refuses platforms without qualified native proof. */
  verify?: typeof windowsConnectionOrigin;
  timeoutMs?: number;
  shutdownMs?: number;
}

/** Finite private Ollama transport for the bounded Studio provider bridge (SPEC-061).
 * Connect first, verify that exact socket, then send. No fetch pool, redirect, proxy, DNS,
 * reconnect or retry may substitute a different socket after proof. HTTP completion/cleanup
 * never confirms native inference completion or releases GPU ownership. */
export class ManagedOllamaTransport {
  private readonly origin: SupervisedProcessOrigin;
  private readonly current: () => boolean;
  private readonly verify: typeof windowsConnectionOrigin;
  private readonly timeoutMs: number;
  private readonly shutdownMs: number;
  private readonly lifetime = new AbortController();
  private readonly work = new Set<Promise<Response>>();
  private stopping = false;

  constructor(options: Options) {
    if (!isSupervisedProcessOrigin(options.origin)) throw refused();
    this.origin = options.origin; this.current = options.current; this.verify = options.verify ?? windowsConnectionOrigin;
    this.timeoutMs = options.timeoutMs ?? 180_000; this.shutdownMs = options.shutdownMs ?? 1000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 180_000 ||
      !Number.isSafeInteger(this.shutdownMs) || this.shutdownMs < 1 || this.shutdownMs > 5000) throw refused();
  }
  private available(): boolean {
    try { return !this.stopping && this.origin.current() && this.current(); } catch { return false; }
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
    const metadata = method === "GET" && url.pathname === "/api/tags" || method === "POST" && url.pathname === "/api/show";
    const generate = method === "POST" && url.pathname === "/v1/chat/completions";
    if (url.href !== base + url.pathname || !metadata && !generate || init?.redirect !== undefined && init.redirect !== "error" ||
      method === "GET" && init?.body !== undefined || method === "POST" && typeof init?.body !== "string") throw refused();
    const body = typeof init?.body === "string" ? init.body : "";
    if (Buffer.byteLength(body) > (generate ? LIMIT : 4096)) throw refused();
    const captured = new Headers(init?.headers);
    if ([...captured.keys()].some(key => !["content-type", "authorization"].includes(key)) ||
      captured.has("content-type") && captured.get("content-type") !== "application/json" || (captured.get("authorization")?.length ?? 0) > 16_384) throw refused();
    const headers = { "content-type": "application/json", "content-length": Buffer.byteLength(body), connection: "close",
      ...(captured.has("authorization") ? { authorization: captured.get("authorization")! } : {}) };
    const control = new AbortController(), signal = AbortSignal.any([this.lifetime.signal, control.signal, ...(init?.signal ? [init.signal] : [])]);
    const timer = setTimeout(() => control.abort(), this.timeoutMs);
    const task = this.execute(url.pathname, method, headers, body, generate, signal).finally(() => { clearTimeout(timer); this.work.delete(task); });
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

  private async execute(path: string, method: string, headers: Record<string, string | number>, body: string, generate: boolean, signal: AbortSignal): Promise<Response> {
    const socketOptions = { highWaterMark: 16 * 1024, allowHalfOpen: false };
    const socket = new Socket(socketOptions); socket.on("error", () => {}); socket.pause();
    const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
    let requestOwner: ClientRequest | undefined, requestClosed: Promise<void> | undefined, collection: Promise<Buffer> | undefined;
    const cancel = () => socket.destroy(); signal.addEventListener("abort", cancel, { once: true });
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
      if (signal.aborted || !this.available() || socket.destroyed || socket.bytesWritten !== 0 || socket.readableLength !== 0 ||
        socket.localPort !== connection.clientPort || socket.remotePort !== connection.serverPort) throw refused();
      const bytes = await new Promise<Buffer>((resolve, reject) => {
        // Do not set agent:false: that creates an Agent which may ignore createConnection.
        // Supplying only createConnection makes Node use this already verified socket.
        const request = httpRequest({ hostname: "127.0.0.1", port: this.origin.port, path, method, headers, maxHeaderSize: 8192,
          createConnection: () => socket }, response => { collection = this.collect(response, generate, signal); void collection.then(resolve, reject); });
        requestOwner = request; requestClosed = new Promise<void>(done => request.once("close", () => done()));
        request.once("error", () => reject(refused()));
        request.once("socket", connected => {
          if (connected !== socket || signal.aborted || !this.available()) request.destroy();
          else socket.resume(); // HTTP's parser is attached before this event and before queued writes flush.
        });
        if (signal.aborted || !this.available()) request.destroy(); else request.end(body);
      });
      if (signal.aborted || !this.available()) throw refused();
      return new Response(bytes, { status: 200, headers: { "content-type": generate ? "text/event-stream" : "application/json", "content-length": String(bytes.length) } });
    } finally {
      signal.removeEventListener("abort", cancel); requestOwner?.destroy(); socket.destroy();
      await Promise.all([closed, requestClosed, collection?.then(() => {}, () => {})]);
    }
  }
  private async collect(response: IncomingMessage, generate: boolean, signal: AbortSignal): Promise<Buffer> {
    const type = generate ? "text/event-stream" : "application/json", declared = response.headers["content-length"];
    try {
      if (response.statusCode !== 200 || response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== type ||
        declared !== undefined && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > LIMIT)) throw refused();
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of response) {
        signal.throwIfAborted(); if (!this.available()) throw refused();
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > LIMIT || chunks.length >= FRAGMENTS) throw refused();
        chunks.push(bytes);
      }
      return Buffer.concat(chunks, size);
    } finally { response.destroy(); }
  }
  /** Confirms only this HTTP owner's settlement, never service/GPU completion. */
  async stop(): Promise<boolean> {
    this.stopping = true; this.lifetime.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.allSettled(this.work).then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), this.shutdownMs); })]);
    } finally { clearTimeout(timer); }
  }
}
