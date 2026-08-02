import { createServer, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";

/**
 * A scripted OpenCode stand-in serving the probed /api surface: health, doc, session create,
 * prompt, interrupt, and an SSE event stream tests can push frames into. Hermetic — the
 * adapter suite runs without a real harness or a model key.
 */

export interface CapturedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

export class StubOpenCode {
  private server: Server | null = null;
  port = 0;
  readonly requests: CapturedRequest[] = [];
  private sseClients = new Set<ServerResponse>();
  private sessionCounter = 0;
  /** What /config/providers answers with; null makes the endpoint absent (older servers). */
  configProviders: { providers: Array<{ id: string; models: Record<string, { name?: string }> }>; default?: Record<string, string> } | null = null;
  /** What /api/model answers with; null makes it absent. */
  apiModels: Array<{ id: string; providerID: string; name?: string; status?: string }> | null = null;
  /** Paths advertised at /doc — tests override to simulate under-capable servers. */
  docPaths: string[] = [
    "/api/health",
    "/api/event",
    "/global/event",
    "/api/session",
    "/api/session/{sessionID}/prompt",
    "/api/session/{sessionID}/interrupt",
    "/api/session/{sessionID}/permission/{requestID}/reply",
    "/api/model",
  ];

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
      const query: Record<string, string> = {};
      for (const [k, v] of url.searchParams) query[k] = v;

      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString("utf8")));
      req.on("end", () => {
        const parsed = body ? (JSON.parse(body) as unknown) : undefined;
        this.requests.push({ method: req.method ?? "", path: url.pathname, query, body: parsed });

        if (url.pathname === "/api/health" || url.pathname === "/global/health") {
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
          return;
        }
        if (url.pathname === "/doc") {
          const paths = Object.fromEntries(this.docPaths.map((p) => [p, {}]));
          res
            .writeHead(200, { "Content-Type": "application/json" })
            .end(JSON.stringify({ info: { version: "9.9.9-stub" }, paths }));
          return;
        }
        if (url.pathname === "/global/event" && this.globalEventStatus !== null) {
          res.writeHead(this.globalEventStatus).end();
          return;
        }
        if (url.pathname === "/api/event" || url.pathname === "/global/event" || url.pathname === "/event") {
          this.streamPaths.push(url.pathname);
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
          });
          res.write(": connected\n\n");
          this.sseClients.add(res);
          // req "close" fires on message completion in modern Node; the socket's death is the
          // response's close event.
          res.on("close", () => this.sseClients.delete(res));
          return;
        }
        if (url.pathname === "/api/session" && req.method === "POST") {
          const id = `ses_stub_${++this.sessionCounter}`;
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data: { id } }));
          return;
        }
        if (/^\/session\/[^/]+\/message$/.test(url.pathname) && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(this.replayMessages));
          return;
        }
        if (/^\/session\/[^/]+\/prompt_async$/.test(url.pathname)) {
          res.writeHead(204).end();
          return;
        }
        if (/^\/api\/session\/[^/]+\/prompt$/.test(url.pathname)) {
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({}));
          return;
        }
        if (/^\/api\/session\/[^/]+\/interrupt$/.test(url.pathname)) {
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({}));
          return;
        }
        if (/^\/api\/session\/[^/]+\/permission\/[^/]+\/reply$/.test(url.pathname)) {
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({}));
          return;
        }
        if (url.pathname === "/config/providers" && this.configProviders) {
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(this.configProviders));
          return;
        }
        if (url.pathname === "/api/model" && this.apiModels) {
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data: this.apiModels }));
          return;
        }
        res.writeHead(404).end();
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    this.port = address.port;
    this.server = server;
  }

  baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Push one SSE frame to every connected stream consumer. */
  emit(event: unknown): void {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.sseClients) client.write(line);
  }

  /** How many stream consumers are attached right now — a reconnect is one more of these. */
  get streamCount(): number {
    return this.sseClients.size;
  }

  /**
   * Go silent without hanging up: the socket stays open, no bytes ever arrive again. This is
   * what a restarted harness leaves behind, and what a reader waits on forever unless something
   * decides the silence has gone on too long.
   */
  stallStreams(): void {
    for (const client of this.sseClients) {
      client.socket?.pause();
      this.stalled.add(client);
    }
    this.sseClients.clear();
  }

  /** Held so stop() can destroy them — a paused socket would otherwise outlive the server. */
  private stalled = new Set<ServerResponse>();

  /** What GET /session/:id/message replays — how a reconnecting adapter learns what it missed. */
  replayMessages: unknown[] = [];

  /** Force /global/event to answer this status instead of streaming (null = stream normally). */
  globalEventStatus: number | null = null;
  /** Which stream endpoints were actually attached, in order. */
  readonly streamPaths: string[] = [];

  private turnCounter = 0;

  /** Script a full assistant turn for a session: text, a canon check, then idle. */
  emitTurn(sessionId: string, text: string): void {
    const messageId = `msg_${++this.turnCounter}_${Date.now().toString(36)}`;
    const callId = `call_${this.turnCounter}`;
    void callId;
    this.emit({
      payload: {
        type: "message.updated",
        properties: { info: { id: messageId, sessionID: sessionId, role: "assistant", tokens: { input: 100, output: 50 } } },
      },
    });
    this.emit({
      payload: {
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: sessionId,
            messageID: messageId,
            type: "tool",
            tool: "arke-world_search_canon",
            callID: `call_${this.turnCounter}`,
            state: { status: "running", input: { query: "tide calling" } },
          },
        },
      },
    });
    this.emit({
      payload: {
        type: "message.part.updated",
        properties: { part: { sessionID: sessionId, messageID: messageId, type: "text", text } },
      },
    });
    this.emit({ payload: { type: "session.idle", properties: { sessionID: sessionId } } });
  }

  lastRequest(pathPattern: RegExp): CapturedRequest | undefined {
    return [...this.requests].reverse().find((r) => pathPattern.test(r.path));
  }

  async stop(): Promise<void> {
    for (const client of this.sseClients) client.end();
    this.sseClients.clear();
    for (const client of this.stalled) client.socket?.destroy();
    this.stalled.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
