import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const LIMIT = 1024 ** 2, FRAGMENTS = 16_384;
interface BridgeOptions {
  /** Captured trusted completion route, never a renderer/model-provided URL. */
  upstream: string; requestBody: string; model: string; upstreamKey?: string;
  fetch?: typeof fetch; timeoutMs?: number; shutdownMs?: number;
}

/** Candidate private native transport. Its finite response reaches OpenCode only after
 * upstream collection is bounded. Production activation still requires managed-origin,
 * payload/spend/profile and native lifecycle qualification; loopback alone proves none. */
export class StudioProviderBridge {
  private readonly options: Readonly<BridgeOptions>;
  private readonly upstream: URL;
  private readonly body: Buffer;
  private readonly key = randomBytes(32).toString("hex");
  private readonly auth = Buffer.from(`Bearer ${this.key}`);
  private readonly lifetime = new AbortController();
  private readonly work = new Set<Promise<void>>();
  private readonly server = createServer({ maxHeaderSize: 8192 }, (request, response) => this.handle(request, response));
  private opening: Promise<{ baseURL: string; apiKey: string; identity: string }> | null = null;
  private closed: Promise<void> | null = null;
  private sealed = false;
  private stopping = false;
  private approved = false;
  private submitted = false;
  private metadata = 0;
  constructor(options: BridgeOptions) {
    this.options = Object.freeze({ ...options });
    this.upstream = new URL(options.upstream);
    if (this.upstream.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(this.upstream.hostname) || this.upstream.pathname !== "/v1" ||
      this.upstream.username || this.upstream.password || this.upstream.search || this.upstream.hash || options.upstream !== this.upstream.origin + "/v1") throw new Error("Private upstream is not a captured literal loopback route.");
    if (!options.model || options.model.length > 512 || options.requestBody.length > LIMIT || Buffer.byteLength(options.requestBody) > LIMIT ||
      options.upstreamKey !== undefined && (options.upstreamKey.length > 16_384 || /[\r\n]/.test(options.upstreamKey))) throw new Error("Private bridge input exceeds its bounds.");
    this.body = Buffer.from(options.requestBody);
    this.server.requestTimeout = 10_000; this.server.headersTimeout = 5000; this.server.maxConnections = 8;
    this.server.on("clientError", (_error, socket) => socket.destroy());
    this.server.on("error", () => { this.stopping = true; this.lifetime.abort(); this.server.closeAllConnections(); });
  }
  start(): Promise<{ baseURL: string; apiKey: string; identity: string }> {
    if (this.stopping || this.sealed) return Promise.reject(new Error("Private bridge is stopped."));
    return this.opening ??= new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.removeListener("error", reject);
        const address = this.server.address();
        if (this.stopping || this.sealed || !address || typeof address === "string") { reject(new Error("Private bridge stopped during startup.")); return; }
        const baseURL = `http://127.0.0.1:${address.port}/v1`;
        resolve(Object.freeze({ baseURL, apiKey: this.key,
          identity: createHash("sha256").update(JSON.stringify([baseURL, this.upstream.href, this.key, this.body.toString("utf8")])).digest("hex") }));
      });
    });
  }
  /** Trusted host gate for this already sealed request, after its normal one-use review. */
  approve(): boolean { if (this.stopping || this.sealed || this.submitted) return false; this.approved = true; return true; }
  /** Refuse new work while retaining the listener address and any already-sent completion.
   * The native writer may still hold this URL; only its final retirement permits stop(). */
  seal(): void { this.sealed = true; }
  busy(): boolean { return this.work.size > 0; }
  private refuse(request: IncomingMessage, response: ServerResponse, status: number): void {
    response.writeHead(status, { connection: "close", "content-type": "text/plain" });
    response.end("Private request refused."); response.once("finish", () => request.destroy());
  }
  private handle(request: IncomingMessage, response: ServerResponse): void {
    response.on("error", () => request.destroy());
    const auth = Buffer.from(typeof request.headers.authorization === "string" ? request.headers.authorization : "");
    if (this.stopping || this.sealed || auth.length !== this.auth.length || !timingSafeEqual(auth, this.auth)) { this.refuse(request, response, 401); return; }
    const generate = request.method === "POST" && request.url === "/v1/chat/completions";
    const metadata = request.method === "GET" && request.url === "/api/tags" || request.method === "POST" && request.url === "/api/show";
    if (!generate && !metadata) { this.refuse(request, response, 404); return; }
    if (generate && (!this.approved || this.submitted) || metadata && this.metadata >= 4) { this.refuse(request, response, 409); return; }
    if (generate) this.submitted = true; else this.metadata++;
    const task = this.execute(request, response, generate).catch(() => {
      if (!response.destroyed) { if (!response.headersSent) response.writeHead(502, { connection: "close", "content-type": "text/plain" }); response.end("Private response refused."); }
    }).finally(() => { this.work.delete(task); if (metadata) this.metadata--; });
    this.work.add(task);
  }
  private async requestBytes(request: IncomingMessage, limit: number): Promise<Buffer> {
    const declared = request.headers["content-length"];
    if (declared !== undefined && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > limit)) throw new Error("Private request exceeds its bound.");
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > limit || chunks.length >= FRAGMENTS) throw new Error("Private request exceeds its bound.");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, size);
  }
  private async responseBytes(response: Response): Promise<Buffer> {
    const declared = response.headers.get("content-length"), reader = response.body?.getReader();
    if (!reader) throw new Error("Private response has no body.");
    let size = 0, complete = false; const chunks: Buffer[] = [];
    try {
      if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > LIMIT)) throw new Error("Private response exceeds its bound.");
      for (;;) {
        const next = await reader.read(); if (next.done) { complete = true; break; }
        size += next.value.byteLength;
        if (size > LIMIT || chunks.length >= FRAGMENTS) throw new Error("Private response exceeds its bound.");
        chunks.push(Buffer.from(next.value));
      }
      return Buffer.concat(chunks, size);
    } finally {
      try { if (!complete) await reader.cancel(); } finally { reader.releaseLock(); }
    }
  }
  private async execute(request: IncomingMessage, response: ServerResponse, generate: boolean): Promise<void> {
    const control = new AbortController(), signal = AbortSignal.any([this.lifetime.signal, control.signal]);
    const timer = setTimeout(() => control.abort(), this.options.timeoutMs ?? (generate ? 180_000 : 5000));
    const cancel = () => request.destroy(); signal.addEventListener("abort", cancel, { once: true });
    const disconnected = () => { if (!response.writableFinished) control.abort(); };
    response.once("close", disconnected);
    try {
      const body = await this.requestBytes(request, generate ? LIMIT : 4096); signal.throwIfAborted();
      if (this.sealed) throw new Error("Private bridge is sealed.");
      if (generate && !body.equals(this.body)) throw new Error("Private request changed.");
      if (!generate && request.method === "POST") {
        const input = JSON.parse(body.toString("utf8"));
        if (!input || input.model !== this.options.model || Object.keys(input).some(key => !["model", "verbose"].includes(key)) || input.verbose !== undefined && typeof input.verbose !== "boolean") throw new Error("Private metadata request changed.");
      }
      const upstream = await (this.options.fetch ?? fetch)(this.upstream.origin + (generate ? "/v1/chat/completions" : request.url!), {
        method: request.method, headers: { "content-type": "application/json", ...(this.options.upstreamKey ? { authorization: `Bearer ${this.options.upstreamKey}` } : {}) },
        ...(request.method === "POST" ? { body: generate ? this.body.toString("utf8") : JSON.stringify({ model: this.options.model, verbose: false }) } : {}), redirect: "error", signal,
      });
      if (upstream.status !== 200 || upstream.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== (generate ? "text/event-stream" : "application/json")) {
        await upstream.body?.cancel(); throw new Error("Private response refused.");
      }
      const bytes = await this.responseBytes(upstream); signal.throwIfAborted();
      if (this.stopping || response.destroyed) return;
      await new Promise<void>(resolve => {
        const done = () => { response.removeListener("finish", done); response.removeListener("close", done); resolve(); };
        response.once("finish", done); response.once("close", done);
        response.writeHead(200, { "content-type": generate ? "text/event-stream" : "application/json", "content-length": bytes.length, connection: "close" }); response.end(bytes);
      });
    } finally { clearTimeout(timer); signal.removeEventListener("abort", cancel); response.removeListener("close", disconnected); }
  }
  /** Observation is bounded; a pending body/cancel owner remains reachable and refuses
   * replacement. HTTP cleanup is not proof that native inference/GPU memory has stopped. */
  async stop(): Promise<boolean> {
    this.seal(); this.stopping = true; this.lifetime.abort();
    this.closed ??= (async () => {
      await this.opening?.catch(() => {});
      if (!this.server.listening) return;
      await new Promise<void>(resolve => { this.server.close(() => resolve()); this.server.closeAllConnections(); });
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.all([this.closed, ...this.work]).then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), this.options.shutdownMs ?? 1000); })]);
    } finally { clearTimeout(timer); }
  }
}
