import { SocketWriter } from "./socket-writer.js";
import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import type { ReadStream } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  ClientMessageSchema,
  FrameSchema,
  jobSummary,
  type ClientMessage,
  type ClientState,
  type DomainEvent,
  type Frame,
  type StudioAssistantResponse,
} from "@arke-studio/contracts";

/**
 * The coordinator transport (SPEC-001 §2.5, R-3): ordered, monotonically sequenced,
 * schema-validated frames — one snapshot, then events and private requester replies. Sequence numbers are per connection.
 * A reconnecting client sends its last-seen sequence and receives a fresh snapshot; partial
 * replay is deliberately not offered (D4).
 */


/** The job and ledger history a snapshot was measured against: what the window held before it. */
interface HistoryBase {
  jobs?: ClientState["app"]["jobs"];
  ledger?: ClientState["app"]["ledger"];
}

interface Connection {
  lifetime: AbortController;
  requester: TransportRequester;
  writer: SocketWriter;
  retainHistory: boolean;
  jobs?: ClientState["app"]["jobs"];
  ledger?: ClientState["app"]["ledger"];
  socket: WebSocket;
  seq: number;
  helloed: boolean;
  initialising: boolean;
  refused: boolean;
  pending: ClientMessage[];
}

/** Captured authenticated socket only. Never serialize or expose to world/model tools. */
export interface TransportRequester {
  readonly signal: AbortSignal;
  /** True means handed to the bounded writer, not acknowledged delivery or execution. */
  reply(requestId: string, response: StudioAssistantResponse): boolean;
}

export interface TransportAuth {
  /** A fresh 32-byte capability, supplied by the host; never included in snapshots or logs. */
  token: string;
  allowedOrigins: readonly string[];
}

/** Host-only media ownership. Release follows descriptor closure, including aborted reads. */
export interface ResolvedMediaFile {
  path: string;
  contentType: string;
  downloadName?: string;
  release?: () => void;
}

export interface TransportOptions {
  auth: TransportAuth;
  getSnapshot(): ClientState;
  /** Transient state that must be replayed after a fresh snapshot, such as held permissions. */
  getInitialEvents?(): DomainEvent[];
  /** Reconcile durable state before a new or reconnecting renderer receives its snapshot. */
  beforeInitialSnapshot?(): Promise<void>;
  /** Client → coordinator messages, after the hello. */
  onMessage?: (msg: ClientMessage, requester?: TransportRequester) => void;
  /** Somewhere for the transport to say what it dropped; silence is the default, not the goal. */
  log?: (line: string) => void;
  /**
   * Read-only media for the renderer (design-fidelity pass): resolve a GET path like
   * `/media/<world-slug>/<world-relative-file>` to an absolute file, or null to 404. The
   * resolver owns path-traversal guarding; the transport owns nothing but the plumbing.
   */
  serveFile?: (urlPath: string) => Promise<ResolvedMediaFile | null>;
}

/**
 * `Range: bytes=…` against a known size.
 *
 * Returns null for "no range asked, send it whole", `"unsatisfiable"` for a 416, or the inclusive
 * byte window. Only the single-range forms a media element actually sends are honoured — the
 * multipart form exists in the RFC and no browser uses it for video.
 */
export function parseByteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;
  // `bytes=-N` is the LAST n bytes, not "from zero to n" — the one form that reads backwards.
  if (rawStart === "") {
    const wanted = Number(rawEnd);
    if (wanted <= 0) return "unsatisfiable";
    return { start: Math.max(0, size - wanted), end: size - 1 };
  }
  const start = Number(rawStart);
  if (start >= size) return "unsatisfiable";
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return "unsatisfiable";
  return { start, end };
}

export class Transport {
  private readonly mediaReads = new Set<ReadStream>();
  private wss: WebSocketServer | null = null;
  private http: Server | null = null;
  private readonly connections = new Set<Connection>();
  private readonly initialisations = new Set<Promise<void>>();

  constructor(private readonly opts: TransportOptions) {
    if (!/^[a-f0-9]{64}$/.test(opts.auth.token)) throw new Error("transport requires a 32-byte session capability");
    if (opts.auth.allowedOrigins.includes("*")) throw new Error("transport origins must be explicit");
  }

  private authenticated(token: unknown): boolean {
    return typeof token === "string" && /^[a-f0-9]{64}$/.test(token)
      && timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(this.opts.auth.token, "hex"));
  }

  private allowedOrigin(origin: string | undefined): boolean {
    // Native clients need no Origin, but still need the capability. Browsers must name an
    // explicitly allowed origin. Electron uses file:// for WS and null for file-page fetches.
    // CORS is not authentication.
    return origin === undefined || this.opts.auth.allowedOrigins.includes(origin);
  }

  /** Bind to loopback on the given port (0 → allocated); resolves with the actual port. */
  async start(port = 0, host = "127.0.0.1"): Promise<number> {
    if (this.wss) throw new Error("transport already started");
    const server = createServer((req, res) => {
      void (async () => {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Vary", "Origin");
        res.setHeader("Referrer-Policy", "no-referrer");
        let url: URL;
        try { url = new URL(req.url ?? "/", "http://127.0.0.1"); }
        catch { res.writeHead(400).end(); return; }
        const token = req.headers.authorization?.replace(/^Bearer /, "") ?? url.searchParams.get("token");
        if (!this.authenticated(token) || !this.allowedOrigin(req.headers.origin)) {
          this.opts.log?.("refused unauthenticated media request");
          res.writeHead(401).end("session authentication required");
          return;
        }
        if (req.headers.origin !== undefined) res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
        if (req.method === "HEAD" && url.pathname === "/session") {
          res.writeHead(204, { "X-Arke-Session": "authenticated", "Cache-Control": "no-store" }).end();
          return;
        }
        if (req.method !== "GET" || !req.url || !this.opts.serveFile) {
          res.writeHead(404).end();
          return;
        }
        let hit: ResolvedMediaFile | null = null;
        let file: FileHandle | undefined;
        let stream: ReadStream | undefined;
        let handedOff = false;
        let released = false;
        const release = (): void => {
          if (released) return;
          released = true;
          try { hit?.release?.(); } catch { this.opts.log?.("media ownership release failed"); }
        };
        const disconnected = (): void => { stream?.destroy(); };
        res.once("close", disconnected);
        try {
          hit = await this.opts.serveFile(decodeURIComponent(url.pathname));
          if (!hit) {
            res.writeHead(404).end();
            return;
          }
          /*
           * Ranges, because a `<video>` cannot seek without them (SPEC-013 R-14's cut is watched
           * here). Served whole, the element reports `seekable` as empty and silently refuses
           * every `currentTime` assignment — playback works, scrubbing does not, and nothing
           * anywhere says why.
           */
          if (res.destroyed || this.http !== server) return;
          file = await open(hit.path, "r");
          const info = await file.stat();
          if (!info.isFile()) throw new Error("media is not a regular file");
          if (res.destroyed || this.http !== server) return;
          const size = info.size;
          // Kit grids and boards are overwritten in place on recompile — never cache.
          const headers: Record<string, string> = {
            "Content-Type": hit.contentType,
            ...(hit.downloadName ? { "Content-Disposition": "attachment; filename*=UTF-8" + String.fromCharCode(39, 39) + encodeURIComponent(hit.downloadName) } : {}),
            "Cache-Control": "no-store",
            "Accept-Ranges": "bytes",
          };
          const asked = parseByteRange(req.headers.range, size);
          if (asked === "unsatisfiable") {
            res.writeHead(416, { ...headers, "Content-Range": `bytes */${size}` }).end();
            return;
          }
          stream =
            asked === null
              ? (res.writeHead(200, { ...headers, "Content-Length": String(size) }), file.createReadStream({ autoClose: false }))
              : (res.writeHead(206, {
                  ...headers,
                  "Content-Range": `bytes ${asked.start}-${asked.end}/${size}`,
                  "Content-Length": String(asked.end - asked.start + 1),
                }),
                file.createReadStream({ start: asked.start, end: asked.end, autoClose: false }));
          const ownedFile = file;
          this.mediaReads.add(stream);
          stream.once("close", () => {
            this.mediaReads.delete(stream!);
            res.off("close", disconnected);
            if (!res.writableEnded) res.destroy();
            // A failed close leaves ownership unknown. It cannot make this file disposable.
            void ownedFile.close().then(release, () => this.opts.log?.("media descriptor cleanup is unknown"));
          });
          stream.on("error", () => res.destroy());
          stream.once("end", () => stream!.destroy());
          handedOff = true;
          stream.pipe(res);
        } catch {
          if (res.headersSent) res.destroy();
          else if (!res.destroyed) res.writeHead(404).end();
        } finally {
          if (!handedOff) {
            res.off("close", disconnected);
            let closed = true;
            if (file) {
              try { await file.close(); } catch { closed = false; this.opts.log?.("media descriptor cleanup is unknown"); }
            }
            if (closed) release();
          }
        }
      })();
    });
    this.http = server;
    const wss = new WebSocketServer({ server });
    this.wss = wss;
    wss.on("connection", (socket, request) => this.accept(socket, request.headers.origin));
    server.listen(port, host);
    // ws forwards HTTP bind failures as its own error event; consume that forwarded event too.
    await once(wss, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no bound address");
    return address.port;
  }

  private accept(socket: WebSocket, origin: string | undefined): void {
    const writer = new SocketWriter(socket, { label: "coordinator", trace: detail => this.opts.log?.(JSON.stringify(detail)) });
    const lifetime = new AbortController();
    const requester: TransportRequester = { signal: lifetime.signal, reply: (requestId, response) => {
      if (lifetime.signal.aborted || !this.connections.has(conn) || !conn.helloed || conn.refused || socket.readyState !== 1) return false;
      this.sendFrame(conn, { kind: "studio-assistant", seq: ++conn.seq, requestId, response }); return true;
    } };
    const conn: Connection = { socket, writer, lifetime, requester, retainHistory: false, seq: 0, helloed: false, initialising: false, refused: false, pending: [] };
    const refuse = () => {
      conn.refused = true;
      conn.helloed = false;
      lifetime.abort(); conn.pending = [];
      this.opts.log?.("refused unauthenticated WebSocket session");
      socket.close(1008, "session authentication required");
    };
    this.connections.add(conn);
    socket.on("close", () => { lifetime.abort(); writer.dispose(); this.connections.delete(conn); });
    socket.on("error", () => { lifetime.abort(); writer.dispose(); this.connections.delete(conn); });
    if (!this.allowedOrigin(origin)) {
      refuse();
      return;
    }
    socket.on("message", (data) => {
      if (conn.refused) return;
      let msg: ClientMessage;
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(String(data));
      } catch {
        // Bytes that are not JSON are a transport fault; fail loudly rather than guessing.
        socket.close(1002, "malformed client message");
        return;
      }
      // Check before schema parsing: a missing/invalid capability must close, not be treated
      // as harmless version skew. No pipelined command may follow a refused hello.
      const candidate = parsedJson as { kind?: unknown; token?: unknown } | null;
      if ((!conn.helloed && !conn.initialising) || candidate?.kind === "hello") {
        if (candidate?.kind !== "hello" || !this.authenticated(candidate.token)) {
          refuse();
          return;
        }
      }
      try {
        msg = ClientMessageSchema.parse(parsedJson);
      } catch {
        /*
         * Valid JSON that fails the schema is version skew, not corruption (review 2026-08-22):
         * a renderer one build ahead of this coordinator sends a frame this schema has never
         * heard of, and closing the socket made the whole app read as disconnected on one
         * keystroke. The message is dropped and said so; everything else keeps working.
         */
        this.opts.log?.("dropping a client message this build does not understand");
        return;
      }
      if (msg.kind === "hello") {
        // A legacy retry is only for old strict servers. Never downgrade an already
        // negotiated connection or queue another full snapshot behind a slow first one.
        if (conn.initialising || (conn.retainHistory && msg.retainHistory !== true)) return;
        conn.retainHistory = msg.retainHistory === true;
        conn.jobs = undefined; conn.ledger = undefined;
        const sendInitialState = () => {
          if (!this.connections.has(conn) || conn.refused || socket.readyState !== 1) return;
          // Whatever lastSeq the client saw, the answer is a fresh snapshot (D4).
          conn.helloed = true;
          conn.initialising = false;
          this.sendFrame(conn, { kind: "snapshot", seq: ++conn.seq, state: this.opts.getSnapshot() });
          for (const event of this.opts.getInitialEvents?.() ?? []) {
            this.sendFrame(conn, { kind: "event", seq: ++conn.seq, event });
          }
          for (const pending of conn.pending.splice(0)) this.opts.onMessage?.(pending, requester);
        };
        if (this.opts.beforeInitialSnapshot && !conn.helloed) {
          conn.helloed = false;
          conn.initialising = true;
          const initialising = this.opts.beforeInitialSnapshot()
            .then(sendInitialState)
            .catch(() => {
              this.opts.log?.("initial snapshot reconciliation failed");
              if (this.connections.has(conn)) socket.close(1011, "initial state unavailable");
            })
            .finally(() => this.initialisations.delete(initialising));
          this.initialisations.add(initialising);
        } else {
          sendInitialState();
        }
        return;
      }
      if (conn.initialising) {
        // A routed renderer can send open-world immediately after its authenticated hello.
        // Reconciliation is asynchronous; retain those commands until the first snapshot,
        // rather than closing and making every reconnect repeat the same race (issue #976).
        if (conn.pending.length >= 32) {
          conn.refused = true;
          conn.pending = [];
          socket.close(1008, "too many commands before initial state");
        } else conn.pending.push(msg);
        return;
      }
      if (!conn.helloed) {
        socket.close(1002, "expected hello before any other message");
        return;
      }
      this.opts.onMessage?.(msg, requester);
    });
  }

  /**
   * `supersede`: a later snapshot of the same world may replace this one while it waits (see
   * SocketWriter). Only refreshes are sent so; the snapshot answering a hello never is, since
   * every event behind it would otherwise reach a window that has no state yet.
   */
  private sendFrame(conn: Connection, frame: Frame, options: { supersede?: boolean } = {}): void {
    // Validate on the way out — a frame that fails its own schema must never reach a client.
    let outgoing = frame;
    let snapshot: { key: string; base: HistoryBase; keep?: true } | undefined;
    if (frame.kind === "snapshot") {
      const { jobs, ledger } = frame.state.app;
      const key = `world:${frame.state.world?.meta.worldId ?? ""}`;
      // History is left out only when the window already holds it. A waiting snapshot this one
      // replaces never arrives, so what the window holds is what that one was measured against.
      const replaced = options.supersede ? conn.writer.unsentSnapshot(key)?.base as HistoryBase | undefined : undefined;
      const base: HistoryBase = replaced ?? { jobs: conn.jobs, ledger: conn.ledger };
      const retainedHistory: ("jobs" | "ledger")[] = [];
      if (conn.retainHistory && base.jobs === jobs) retainedHistory.push("jobs");
      if (conn.retainHistory && base.ledger === ledger) retainedHistory.push("ledger");
      outgoing = { ...frame, state: { ...frame.state, app: { ...frame.state.app,
        jobs: retainedHistory.includes("jobs") ? [] : conn.retainHistory ? jobs.map(jobSummary) : jobs,
        ledger: retainedHistory.includes("ledger") ? [] : ledger,
      } }, ...(retainedHistory.length ? { retainedHistory } : {}) };
      conn.jobs = jobs; conn.ledger = ledger;
      snapshot = { key, base, ...(options.supersede ? {} : { keep: true as const }) };
    } else if (frame.kind === "event" && conn.retainHistory && (frame.event.type === "job.updated" || frame.event.type === "job.ready")) {
      outgoing = { ...frame, event: { ...frame.event, job: jobSummary(frame.event.job) } };
    }
    conn.writer.send(JSON.stringify(FrameSchema.parse(outgoing)), snapshot !== undefined ? { snapshot } : {});
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
      this.sendFrame(conn, { kind: "snapshot", seq: ++conn.seq, state }, { supersede: true });
      for (const event of this.opts.getInitialEvents?.() ?? []) {
        this.sendFrame(conn, { kind: "event", seq: ++conn.seq, event });
      }
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
    for (const stream of this.mediaReads) stream.destroy();
    for (const conn of this.connections) { conn.lifetime.abort(); conn.writer.dispose({ preserveCloseTimeout: true }); conn.socket.close(1001, "coordinator stopping"); }
    this.connections.clear();
    await Promise.allSettled(this.initialisations);
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
  }
}
