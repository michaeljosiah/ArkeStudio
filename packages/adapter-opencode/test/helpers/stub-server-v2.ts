import { createServer, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";

/**
 * A scripted OpenCode v2 stand-in serving the measured 0.0.0-next-17444 surface: Basic-auth
 * challenge on every route, `{ data, location }` envelopes, deep-object location queries,
 * inbox-shaped prompts with durable msg_ ids, session-scoped pending permissions, and an SSE
 * stream with `: heartbeat` comments. Hermetic — the suite runs without a real harness or a
 * model key, and the auth path is exercised rather than assumed (issue 327 §11).
 */

export interface CapturedV2Request {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  authorized: boolean;
}

export const STUB_V2_PASSWORD = "stub-secret";

export class StubOpenCodeV2 {
  private server: Server | null = null;
  port = 0;
  readonly requests: CapturedV2Request[] = [];
  private sseClients = new Set<ServerResponse>();
  private sessionCounter = 0;
  private turnCounter = 0;
  /** Every wire message id ever accepted — ids are durable and globally unique (measured). */
  readonly promptIds = new Set<string>();
  /** Pending permission asks by session — served by the session-scoped route only. */
  readonly pendingPermissions = new Map<string, Array<{ id: string; action: string; resources: string[]; save?: string[] }>>();
  /** What GET /api/session/:id/message replays, newest first, per session. */
  readonly messagesBySession = new Map<string, unknown[]>();
  /** Extra latency on the first health answer — the server-global warm-up switch. */
  coldHealthMs = 0;
  /** Answer the next GET .../message with a 503 — the completion-fetch blip switch. */
  failNextMessageFetch = false;
  private healthAnswered = false;
  /** The location echoed on session create; null echoes the requested one honestly. */
  echoLocation: string | null = null;
  models: Array<{ id: string; providerID: string; name?: string; limit?: { context?: number; input?: number } }> = [];
  defaultModel: { id: string; providerID: string } | null = null;

  private authorized(header: string | undefined): boolean {
    const expected = "Basic " + Buffer.from(`opencode:${STUB_V2_PASSWORD}`).toString("base64");
    return header === expected;
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
      const query: Record<string, string> = {};
      for (const [k, v] of url.searchParams) query[k] = v;
      const authorized = this.authorized(req.headers.authorization);

      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString("utf8")));
      req.on("end", () => {
        const parsed = body ? (JSON.parse(body) as unknown) : undefined;
        this.requests.push({ method: req.method ?? "", path: url.pathname, query, body: parsed, authorized });

        // The measured posture: no credentials, no route — the event stream included.
        if (!authorized) {
          res.writeHead(401, { "Content-Type": "text/plain" }).end("Unauthorized");
          return;
        }

        const locationDir = query["location[directory]"];
        const envelope = (data: unknown, directory?: string) =>
          JSON.stringify({ data, ...(directory !== undefined ? { location: { directory } } : {}) });

        if (url.pathname === "/api/health") {
          const respond = () =>
            res
              .writeHead(200, { "Content-Type": "application/json" })
              .end(JSON.stringify({ healthy: true, version: "0.0.0-next-17444", pid: 4242 }));
          if (!this.healthAnswered && this.coldHealthMs > 0) {
            this.healthAnswered = true;
            setTimeout(respond, this.coldHealthMs);
            return;
          }
          this.healthAnswered = true;
          respond();
          return;
        }

        if (url.pathname === "/api/event") {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
          res.write(`data: ${JSON.stringify({ id: "evt_stub_hello", type: "server.connected", data: {} })}\n\n`);
          res.write(": heartbeat\n\n");
          this.sseClients.add(res);
          res.on("close", () => this.sseClients.delete(res));
          return;
        }

        if (url.pathname === "/api/session" && req.method === "POST") {
          const requested = (parsed as { location?: { directory?: string } } | undefined)?.location?.directory;
          const id = `ses_stub_${++this.sessionCounter}`;
          const directory = this.echoLocation ?? requested;
          res.writeHead(200, { "Content-Type": "application/json" }).end(
            envelope({
              id,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              cost: 0,
              ...(directory !== undefined ? { location: { directory } } : {}),
            }),
          );
          return;
        }

        let m = /^\/api\/session\/([^/]+)\/agent$/.exec(url.pathname);
        if (m && req.method === "POST") {
          res.writeHead(204).end();
          return;
        }
        m = /^\/api\/session\/([^/]+)\/model$/.exec(url.pathname);
        if (m && req.method === "POST") {
          const model = (parsed as { model?: unknown } | undefined)?.model;
          if (typeof model === "string") {
            // Measured: the API wants a ModelRef object; the string form is config grammar.
            res
              .writeHead(400, { "Content-Type": "application/json" })
              .end(JSON.stringify({ _tag: "InvalidRequestError", message: `Expected Model.Ref, got ${JSON.stringify(model)}` }));
            return;
          }
          res.writeHead(204).end();
          return;
        }

        m = /^\/api\/session\/([^/]+)\/prompt$/.exec(url.pathname);
        if (m && req.method === "POST") {
          const sessionId = m[1]!;
          const prompt = parsed as { id?: string; text?: string } | undefined;
          const id = prompt?.id;
          if (typeof id === "string" && !id.startsWith("msg_")) {
            res
              .writeHead(400, { "Content-Type": "application/json" })
              .end(JSON.stringify({ _tag: "InvalidRequestError", message: `Expected a string starting with "msg_", got ${JSON.stringify(id)}`, kind: "Payload" }));
            return;
          }
          if (typeof id === "string") {
            if (this.promptIds.has(id)) {
              res
                .writeHead(409, { "Content-Type": "application/json" })
                .end(JSON.stringify({ _tag: "ConflictError", message: `Prompt message ID conflicts with an existing durable record: ${id}`, resource: id }));
              return;
            }
            this.promptIds.add(id);
          }
          res.writeHead(200, { "Content-Type": "application/json" }).end(
            envelope({
              id: id ?? `msg_stub_${Date.now().toString(36)}`,
              sessionID: sessionId,
              type: "user",
              payload: { text: prompt?.text ?? "" },
              delivery: "steer",
            }),
          );
          return;
        }

        m = /^\/api\/session\/([^/]+)\/interrupt$/.exec(url.pathname);
        if (m && req.method === "POST") {
          res.writeHead(204).end();
          return;
        }

        m = /^\/api\/session\/([^/]+)\/message$/.exec(url.pathname);
        if (m && req.method === "GET") {
          if (this.failNextMessageFetch) {
            this.failNextMessageFetch = false;
            res.writeHead(503).end();
            return;
          }
          const rows = this.messagesBySession.get(m[1]!) ?? [];
          res
            .writeHead(200, { "Content-Type": "application/json" })
            .end(JSON.stringify({ data: rows, cursor: { previous: "p", next: "n" } }));
          return;
        }

        m = /^\/api\/session\/([^/]+)\/permission$/.exec(url.pathname);
        if (m && req.method === "GET") {
          const pending = this.pendingPermissions.get(m[1]!) ?? [];
          res.writeHead(200, { "Content-Type": "application/json" }).end(envelope(pending));
          return;
        }

        m = /^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/.exec(url.pathname);
        if (m && req.method === "POST") {
          const [, sessionId, requestId] = m;
          const reply = (parsed as { reply?: string } | undefined)?.reply ?? "once";
          const remaining = (this.pendingPermissions.get(sessionId!) ?? []).filter((p) => p.id !== requestId);
          this.pendingPermissions.set(sessionId!, remaining);
          res.writeHead(204).end();
          // Confirmation arrives only on the stream, exactly like the real server.
          this.emit({
            id: `evt_stub_${Date.now().toString(36)}`,
            type: "permission.replied",
            data: { sessionID: sessionId, requestID: requestId, reply },
          });
          return;
        }

        // The GLOBAL pending listing answers empty even when a session-scoped ask is pending —
        // the measured beta behavior the resync leg must not trust (issue 327 §6).
        if (url.pathname === "/api/permission/request" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" }).end(envelope([], locationDir));
          return;
        }

        if (url.pathname === "/api/model" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" }).end(envelope(this.models, locationDir));
          return;
        }
        if (url.pathname === "/api/model/default" && req.method === "GET") {
          if (this.defaultModel === null) {
            res.writeHead(503).end();
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" }).end(envelope(this.defaultModel, locationDir));
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

  /** Push one v2 SSE frame to every connected stream consumer. */
  emit(event: unknown): void {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.sseClients) client.write(line);
  }

  /** An SSE comment heartbeat, exactly as the real server sends every 15s. */
  emitHeartbeat(): void {
    for (const client of this.sseClients) client.write(": heartbeat\n\n");
  }

  get streamCount(): number {
    return this.sseClients.size;
  }

  private eventId(): string {
    return `evt_stub_${++this.turnCounter}_${Date.now().toString(36)}`;
  }

  /**
   * Script a successful turn as measured: step start, text deltas, execution.succeeded — and
   * park the finished assistant message where the completion fetch will find it.
   */
  emitTurn(sessionId: string, text: string): void {
    const messageId = `msg_stub_turn_${++this.turnCounter}`;
    this.messagesBySession.set(sessionId, [
      {
        id: messageId,
        type: "assistant",
        time: { created: 1, completed: 2 },
        content: [{ type: "text", text }],
      },
      { id: "msg_stub_switch", type: "agent-switched", agent: "scene-writer" },
    ]);
    this.emit({ id: this.eventId(), type: "session.execution.started", data: { sessionID: sessionId } });
    const half = Math.ceil(text.length / 2);
    for (const delta of [text.slice(0, half), text.slice(half)].filter((s) => s.length > 0)) {
      this.emit({
        id: this.eventId(),
        type: "session.text.delta",
        data: { sessionID: sessionId, assistantMessageID: messageId, delta },
      });
    }
    this.emit({ id: this.eventId(), type: "session.execution.succeeded", data: { sessionID: sessionId } });
  }

  /** Script a held tool call: input streams, the call is recorded unexecuted, the ask fires. */
  emitHeldToolCall(sessionId: string, permissionId: string, command: string): void {
    const callId = `call_stub_${++this.turnCounter}`;
    this.emit({
      id: this.eventId(),
      type: "session.tool.input.started",
      data: { sessionID: sessionId, id: callId, name: "shell" },
    });
    this.emit({
      id: this.eventId(),
      type: "session.tool.called",
      data: { sessionID: sessionId, id: callId, input: { command }, executed: false },
    });
    this.pendingPermissions.set(sessionId, [
      ...(this.pendingPermissions.get(sessionId) ?? []),
      { id: permissionId, action: "shell", resources: [command], save: ["echo *"] },
    ]);
    this.emit({
      id: this.eventId(),
      type: "permission.asked",
      data: { id: permissionId, sessionID: sessionId, action: "shell", resources: [command], save: ["echo *"] },
    });
  }

  lastRequest(pathPattern: RegExp): CapturedV2Request | undefined {
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
