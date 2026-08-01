import { once } from "node:events";
import { createReadStream } from "node:fs";
import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  ClientMessageSchema,
  FrameSchema,
  type ClientMessage,
  type ClientState,
  type DomainEvent,
  type Frame,
} from "@arke-studio/contracts";

/**
 * The coordinator transport (SPEC-001 §2.5, R-3): ordered, monotonically sequenced,
 * schema-validated frames — one snapshot, then events. Sequence numbers are per connection.
 * A reconnecting client sends its last-seen sequence and receives a fresh snapshot; partial
 * replay is deliberately not offered (D4).
 */

interface Connection {
  socket: WebSocket;
  seq: number;
  helloed: boolean;
}

export interface TransportOptions {
  getSnapshot(): ClientState;
  /** Client → coordinator messages, after the hello. */
  onMessage?: (msg: ClientMessage) => void;
  /**
   * Read-only media for the renderer (design-fidelity pass): resolve a GET path like
   * `/media/<world-slug>/<world-relative-file>` to an absolute file, or null to 404. The
   * resolver owns path-traversal guarding; the transport owns nothing but the plumbing.
   */
  serveFile?: (urlPath: string) => Promise<{ path: string; contentType: string } | null>;
}

export class Transport {
  private wss: WebSocketServer | null = null;
  private http: Server | null = null;
  private readonly connections = new Set<Connection>();

  constructor(private readonly opts: TransportOptions) {}

  /** Bind to loopback on the given port (0 → allocated); resolves with the actual port. */
  async start(port = 0, host = "127.0.0.1"): Promise<number> {
    if (this.wss) throw new Error("transport already started");
    const server = createServer((req, res) => {
      void (async () => {
        // Loopback-only server; the renderer's dev origin differs, so CORS opens reads.
        res.setHeader("Access-Control-Allow-Origin", "*");
        if (req.method !== "GET" || !req.url || !this.opts.serveFile) {
          res.writeHead(404).end();
          return;
        }
        try {
          const hit = await this.opts.serveFile(decodeURIComponent(req.url.split("?")[0] ?? ""));
          if (!hit) {
            res.writeHead(404).end();
            return;
          }
          // Kit grids and boards are overwritten in place on recompile — never cache.
          res.writeHead(200, { "Content-Type": hit.contentType, "Cache-Control": "no-store" });
          const stream = createReadStream(hit.path);
          stream.on("error", () => res.destroy());
          stream.pipe(res);
        } catch {
          res.writeHead(404).end();
        }
      })();
    });
    this.http = server;
    const wss = new WebSocketServer({ server });
    this.wss = wss;
    wss.on("connection", (socket) => this.accept(socket));
    server.listen(port, host);
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no bound address");
    return address.port;
  }

  private accept(socket: WebSocket): void {
    const conn: Connection = { socket, seq: 0, helloed: false };
    this.connections.add(conn);
    socket.on("message", (data) => {
      let msg: ClientMessage;
      try {
        msg = ClientMessageSchema.parse(JSON.parse(String(data)));
      } catch {
        // A malformed message is a client bug; fail loudly rather than guessing.
        socket.close(1002, "malformed client message");
        return;
      }
      if (msg.kind === "hello") {
        // Whatever lastSeq the client saw, the answer is a fresh snapshot (D4).
        conn.helloed = true;
        this.sendFrame(conn, { kind: "snapshot", seq: ++conn.seq, state: this.opts.getSnapshot() });
        return;
      }
      if (!conn.helloed) {
        socket.close(1002, "expected hello before any other message");
        return;
      }
      this.opts.onMessage?.(msg);
    });
    socket.on("close", () => this.connections.delete(conn));
    socket.on("error", () => this.connections.delete(conn));
  }

  private sendFrame(conn: Connection, frame: Frame): void {
    // Validate on the way out — a frame that fails its own schema must never reach a client.
    conn.socket.send(JSON.stringify(FrameSchema.parse(frame)));
  }

  /** Push one event to every helloed connection, sequenced per connection. */
  broadcast(event: DomainEvent): void {
    for (const conn of this.connections) {
      if (!conn.helloed) continue;
      this.sendFrame(conn, { kind: "event", seq: ++conn.seq, event });
    }
  }

  /** Re-send the full snapshot to every helloed connection (e.g. after open-world). */
  broadcastSnapshot(): void {
    const state = this.opts.getSnapshot();
    for (const conn of this.connections) {
      if (!conn.helloed) continue;
      this.sendFrame(conn, { kind: "snapshot", seq: ++conn.seq, state });
    }
  }

  connectionCount(): number {
    return this.connections.size;
  }

  async stop(): Promise<void> {
    const wss = this.wss;
    if (!wss) return;
    this.wss = null;
    const http = this.http;
    this.http = null;
    for (const conn of this.connections) conn.socket.close(1001, "coordinator stopping");
    this.connections.clear();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
  }
}
