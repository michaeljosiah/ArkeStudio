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
  /** Paths advertised at /doc — tests override to simulate under-capable servers. */
  docPaths: string[] = [
    "/api/health",
    "/api/event",
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
        if (url.pathname === "/api/event") {
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
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
