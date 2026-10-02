import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { ClientMessageSchema, isRemoteHostCommand, type RemoteCommandRefusal, type ClientMessage } from "@arke-studio/contracts";
import { RemoteDevices } from "./devices.js";
import { openBrowserProof, sealBrowserProof, validBrowserKey } from "./browser-proof.js";

const deviceCookie = "__Host-arke-device";
const pairingCookie = "__Host-arke-pair";
// Match ws's default used by Transport; dictation and large world snapshots are frames too.
const frameLimit = 100 * 1024 * 1024;
// These paths are supplied by the isolated desktop preload after a native selection or
// spool write. Pairing grants Studio access, not arbitrary access to the host filesystem.
// Keep the record exhaustive for every command with these host-path fields.
type HostFileCommand = Extract<ClientMessage, { sourcePath?: string } | { sourcePaths?: (string | null)[] }>;
const hostFileCommands: Record<HostFileCommand["kind"], true> = {
  "world-chat-attach": true, "stage-playblast": true, "conversation-action-stage-playblast-complete": true,
  "upload-artifacts": true, "file-artifact": true, "genesis-attach": true, "import-folder": true,
};
const cookies = (req: IncomingMessage, name: string) =>
  (req.headers.cookie ?? "").split(";").map(part => part.trim()).filter(part => part.startsWith(name + "="));
function cookie(req: IncomingMessage, name: string): string | undefined {
  const values = cookies(req, name);
  return values.length === 1 ? values[0]!.slice(name.length + 1) : undefined;
}
/** What a remote refusal was, in words a log reader can act on and never a credential. */
export type RemoteTrace = (kind: string, detail: Record<string, unknown>) => void;
const setCookie = (name: string, value: string, seconds: number) =>
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${seconds}`;
const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml",
  ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2", ".mp4": "video/mp4", ".ico": "image/x-icon" };

export function remotePage(html: string, origin: string): string {
  const policy = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; ` +
    `media-src 'self' blob:; object-src 'self'; frame-src 'self'; font-src 'self' data:; connect-src 'self' data: blob: ${origin.replace(/^https:/, "wss:")}; base-uri 'self'; form-action 'self'`;
  return html.replace(/(<meta\s+http-equiv="Content-Security-Policy"\s+content=")[^"]*("\s*\/?>)/, `$1${policy}$2`)
    .replace("</head>", '<meta name="arke-remote" content="true" /><link rel="manifest" href="/manifest.webmanifest" /><meta name="mobile-web-app-capable" content="yes" /><meta name="apple-mobile-web-app-capable" content="yes" /></head>');
}

/** A same-origin browser gateway. Only the host knows the coordinator capability; a paired
 * browser authenticates each connection/media request with its own HttpOnly cookie instead. */
export class RemoteGateway {
  private server = createServer((req, res) => { void this.handle(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500).end("Remote access is temporarily unavailable."); else res.destroy();
  }); });
  private wss = new WebSocketServer({ noServer: true, maxPayload: frameLimit,
    handleProtocols: protocols => protocols.has("arke-remote") ? "arke-remote" : false });
  private clients = new Map<WebSocket, { proof: string; upstream: WebSocket }>();
  private transfers = new Map<ServerResponse, { proof: string; cancel: () => void }>();
  private sweep: ReturnType<typeof setInterval> | undefined;
  private closing = false;
  private attempts: number[] = [];
  private root = "";
  private origin: URL;
  private traced = new Map<string, number>();
  constructor(private readonly options: { origin: string; clientDirectory: string; devices: RemoteDevices;
    session: { port: number; token: string }; trace?: RemoteTrace }) {
    this.origin = new URL(options.origin);
    if (this.origin.protocol !== "https:" || this.origin.origin !== options.origin) throw new Error("Remote access requires an exact HTTPS origin.");
    this.server.requestTimeout = 15_000;
    this.server.headersTimeout = 10_000;
    this.server.on("upgrade", (req, socket, head) => {
      const keys = (req.headers["sec-websocket-protocol"] ?? "").split(",").map(part => part.trim()).filter(part => part.startsWith("arke-browser."));
      const key = keys.length === 1 ? keys[0]!.slice(13) : undefined;
      const proof = openBrowserProof(cookie(req, deviceCookie), key, this.origin.origin);
      if (this.closing || req.url !== "/" || !this.accepts(req) || req.headers.origin !== this.origin.origin || !options.devices.authenticate(proof)) {
        this.refused("socket", () => this.closing ? "closing" : req.url !== "/" ? "path" : !this.accepts(req) ? this.forbidden(req)
          : req.headers.origin !== this.origin.origin ? "origin" : this.unpaired(req, key));
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); return;
      }
      this.wss.handleUpgrade(req, socket, head, client => this.connect(client, proof!));
    });
  }
  // A phone that lands on pairing, or on "Not answering", left no other record of why: each
  // answer below is a different repair (re-pair, the address, the browser's storage), so the
  // reason is named. Once a minute per reason keeps a polling phone from filling the log. `at` is
  // a fixed word, never the request's own path, and the map is emptied before it can grow large.
  private refused(at: "socket" | "session" | "remote" | "page", reason: () => string): void {
    if (!this.options.trace) return;
    const why = reason(), key = at + ":" + why, now = Date.now();
    if ((this.traced.get(key) ?? 0) > now - 60_000) return;
    if (this.traced.size >= 256) this.traced.clear();
    this.traced.set(key, now);
    this.options.trace("remote.refused", { at, why });
  }
  private forbidden(req: IncomingMessage): string {
    return req.headers.host !== this.origin.host ? "another address" : req.headers.origin && req.headers.origin !== this.origin.origin
      ? "another origin" : "cross-site request";
  }
  private unpaired(req: IncomingMessage, key: unknown): string {
    const count = cookies(req, deviceCookie).length;
    if (count === 0) return "no device cookie";
    if (count > 1) return "more than one device cookie";
    if (!validBrowserKey(key)) return "no browser key";
    if (!openBrowserProof(cookie(req, deviceCookie), key, this.origin.origin)) return "cookie sealed with another browser key";
    return "device not paired: revoked, expired or never approved";
  }
  async start(port = 8793): Promise<number> {
    this.root = await realpath(this.options.clientDirectory);
    await stat(resolve(this.root, "index.html"));
    this.server.listen(port, "127.0.0.1");
    await once(this.server, "listening");
    this.sweep = setInterval(() => this.recheckDevices(), 1000);
    this.sweep.unref();
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Remote access did not start.");
    return address.port;
  }
  private accepts(req: IncomingMessage, shellVisit = false): boolean {
    return req.headers.host === this.origin.host && (!req.headers.origin || req.headers.origin === this.origin.origin)
      && (req.headers["sec-fetch-site"] !== "cross-site" || shellVisit);
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    const url = new URL(req.url ?? "/", this.origin);
    // Android Chrome marks every launch from another app as cross-site: a home-screen shortcut,
    // a scanned QR code, a link in a message. A reload repeats the original verdict, so refusing
    // those left the phone on a bare 403 until the address was typed in again. A top-level visit
    // to the app shell is safe to admit: the shell is public and unframeable, the SameSite=Strict
    // cookies do not ride on the cross-site visit, and everything the page does next is same-origin.
    const shellVisit = (req.method === "GET" || req.method === "HEAD") && req.headers["sec-fetch-mode"] === "navigate"
      && req.headers["sec-fetch-dest"] === "document" && !/^\/(remote|media|genesis-media)\//.test(url.pathname);
    if (this.closing || !this.accepts(req, shellVisit)) {
      if (!this.closing) this.refused(url.pathname.startsWith("/remote/") ? "remote" : "page", () => this.forbidden(req));
      res.writeHead(403).end(); return;
    }
    if (url.origin !== this.origin.origin) { res.writeHead(403).end(); return; }
    const browserKey = req.headers["x-arke-browser-key"];
    const proof = openBrowserProof(cookie(req, deviceCookie), browserKey, this.origin.origin);
    const authenticated = this.options.devices.authenticate(proof);
    if (!authenticated && url.pathname === "/remote/session") this.refused("session", () => this.unpaired(req, browserKey));
    if (url.pathname === "/remote/device" && req.method === "GET") {
      if (!authenticated) { res.writeHead(401).end(); return; }
      const device = this.options.devices.list().find(row => row.id === authenticated);
      if (!device) { res.writeHead(401).end(); return; }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ name: device.name, pairedAt: device.createdAt, expiresAt: device.expiresAt })); return;
    }
    if (url.pathname === "/remote/session" && req.method === "GET") {
      const seconds = this.options.devices.cookieMaxAge(proof);
      if (seconds !== null) res.setHeader("Set-Cookie", setCookie(deviceCookie, sealBrowserProof(proof!, browserKey as string, this.origin.origin), seconds));
      res.writeHead(seconds !== null ? 204 : 401).end(); return;
    }
    if (url.pathname === "/remote/pair" && req.method === "POST") {
      if (req.headers.origin !== this.origin.origin || req.headers["content-type"] !== "application/json" || !validBrowserKey(browserKey)) { res.writeHead(403).end(); return; }
      this.attempts = this.attempts.filter(at => at > Date.now() - 60_000);
      if (this.attempts.length >= 30) { res.writeHead(429).end(); return; }
      this.attempts.push(Date.now());
      let body = "";
      for await (const chunk of req) { body += chunk.toString(); if (Buffer.byteLength(body) > 1024) { res.writeHead(413).end(); return; } }
      let input: { code?: unknown; name?: unknown };
      try { input = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      if (!input || typeof input.code !== "string" || typeof input.name !== "string" || input.name.length > 60) { res.writeHead(400).end(); return; }
      const pending = this.options.devices.request(input.code, input.name);
      if (!pending) { res.writeHead(403).end("This pairing code is invalid or expired."); return; }
      res.setHeader("Set-Cookie", setCookie(pairingCookie, sealBrowserProof(pending, browserKey, this.origin.origin), 300));
      res.writeHead(202).end(); return;
    }
    if (url.pathname === "/remote/pair" && req.method === "GET") {
      const pending = openBrowserProof(cookie(req, pairingCookie), browserKey, this.origin.origin) ?? "";
      const state = this.options.devices.poll(pending);
      if (state === "approved") res.setHeader("Set-Cookie", [setCookie(deviceCookie, sealBrowserProof(pending, browserKey as string, this.origin.origin), this.options.devices.cookieMaxAge(pending) ?? 0), setCookie(pairingCookie, "", 0)]);
      res.writeHead(state === "approved" ? 204 : state === "pending" ? 202 : 410).end(); return;
    }
    if (/^\/(media|genesis-media)\//.test(url.pathname)) {
      if (!authenticated) { res.writeHead(401).end(); return; }
      if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
      // Imported HTML/SVG is user content, not application script. Sharing the page origin
      // must not let a viewed artifact issue authenticated Studio commands.
      res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; frame-ancestors 'self'");
      res.setHeader("X-Frame-Options", "SAMEORIGIN");
      url.searchParams.delete("token");
      const upstream = httpRequest({ hostname: "127.0.0.1", port: this.options.session.port,
        path: url.pathname + url.search, method: req.method,
        headers: { Authorization: "Bearer " + this.options.session.token, ...(req.headers.range ? { Range: req.headers.range } : {}) } }, response => {
        if (this.closing || !this.options.devices.authenticate(proof)) { response.destroy(); res.destroy(); return; }
        const status = response.statusCode ?? 502;
        // Never forward redirects or upstream cookies; a redirect could move a media load out
        // of the authorized endpoint. The coordinator's range headers are preserved.
        if (status >= 300 && status < 400) { response.destroy(); res.writeHead(502).end(); return; }
        for (const header of ["content-type", "content-length", "content-range", "accept-ranges"]) {
          const value = response.headers[header]; if (value !== undefined) res.setHeader(header, value);
        }
        res.writeHead(status); response.pipe(res);
        response.on("error", () => res.destroy());
      });
      this.transfers.set(res, { proof: proof!, cancel: () => { upstream.destroy(); res.destroy(); } });
      res.on("close", () => { this.transfers.delete(res); upstream.destroy(); });
      upstream.on("error", () => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); });
      upstream.setTimeout(30_000, () => upstream.destroy());
      upstream.end(); return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
    let path: string;
    try {
      const requested = decodeURIComponent(url.pathname);
      if (requested.includes("\\") || requested.includes("\0") || requested.endsWith(".map")) throw new Error("invalid path");
      path = await realpath(resolve(this.root, "." + (requested === "/" ? "/index.html" : requested)));
      if (!path.startsWith(this.root + sep) || !(await stat(path)).isFile()) throw new Error("invalid path");
    } catch { res.writeHead(404).end(); return; }
    res.setHeader("Content-Type", mime[extname(path)] ?? "application/octet-stream");
    if (req.method === "HEAD") { res.writeHead(200).end(); return; }
    if (path === resolve(this.root, "index.html")) res.end(remotePage(await readFile(path, "utf8"), this.origin.origin));
    else { const stream = createReadStream(path); stream.on("error", () => res.destroy()); res.on("close", () => stream.destroy()); stream.pipe(res); }
  }
  private connect(client: WebSocket, proof: string): void {
    const upstream = new WebSocket(`ws://127.0.0.1:${this.options.session.port}`, { maxPayload: frameLimit, handshakeTimeout: 10_000 });
    this.clients.set(client, { proof, upstream });
    const id = this.options.devices.authenticate(proof);
    const device = this.options.devices.list().find(row => row.id === id)?.name ?? id;
    this.options.trace?.("remote.socket", { event: "open", device });
    const pending: string[] = [];
    let pendingBytes = 0;
    const refuse = () => {
      // A phone that left before Studio answered is not a refusal; only a revocation is.
      if (client.readyState === WebSocket.OPEN) {
        this.options.trace?.("remote.socket", { event: "refused", device, why: this.closing ? "closing" : "device no longer paired" });
      }
      client.close(1008, "session authentication required"); upstream.terminate();
    };
    const check = () => !this.closing && !!this.options.devices.authenticate(proof);
    upstream.on("open", () => {
      if (!check() || client.readyState !== WebSocket.OPEN) { refuse(); return; }
      upstream.send(JSON.stringify({ kind: "hello", token: this.options.session.token }));
      for (const message of pending.splice(0)) upstream.send(message);
    });
    client.on("message", raw => {
      if (!check()) { refuse(); return; }
      let input: unknown;
      try { input = JSON.parse(raw.toString()); } catch { client.close(1002); return; }
      const parsed = ClientMessageSchema.safeParse(input);
      if (!parsed.success) {
        // Dropped, as the coordinator drops it (transport.ts): valid JSON that fails the schema is
        // version skew or one screen's bad field. Closing the socket here sent the phone into a
        // reconnect, a fresh snapshot and the same command again, and the world kept reloading.
        // It is never forwarded either way. The command and field are named, never their values.
        const kind = (input as { kind?: unknown } | null)?.kind;
        const field = parsed.error.issues[0]?.path.join(".").slice(0, 120) ?? "";
        this.refused("socket", () => `dropped ${typeof kind === "string" ? kind.slice(0, 60) : "a command"} (${field})`);
        return;
      }
      if (Object.hasOwn(hostFileCommands, parsed.data.kind) || isRemoteHostCommand(parsed.data)) {
        const refusal = { kind: "command-refused", refused: "host-only", command: parsed.data.kind } as RemoteCommandRefusal;
        client.send(JSON.stringify(refusal)); return;
      }
      if (parsed.data.kind === "hello") return;
      // A decision names a stored card, not its effect. Impose this after parsing so the peer
      // cannot omit it; the lifecycle resolves the authoritative kind before approval or replay.
      const message = JSON.stringify(parsed.data.kind === "conversation-action-decide"
        ? { ...parsed.data, hostActions: "refuse" } : parsed.data);
      if (upstream.readyState === WebSocket.OPEN) upstream.send(message);
      else if (pending.length < 32 && (pendingBytes += Buffer.byteLength(message)) <= frameLimit) pending.push(message);
      else client.close(1008, "too many pending commands");
    });
    upstream.on("message", raw => {
      if (!check()) { refuse(); return; }
      if (client.readyState === WebSocket.OPEN) {
        if (client.bufferedAmount > frameLimit) { client.terminate(); return; }
        client.send(raw.toString());
      }
    });
    upstream.on("error", () => client.close(1011, "Studio is unavailable"));
    upstream.on("close", () => { if (client.readyState === WebSocket.OPEN) client.close(1012, "Studio is restarting"); });
    client.on("error", () => upstream.terminate());
    client.on("close", (code, reason) => {
      this.options.trace?.("remote.socket", { event: "closed", device, code, reason: reason.toString().slice(0, 80) });
      this.clients.delete(client); upstream.terminate();
    });
  }
  recheckDevices(): void {
    for (const [client, { proof, upstream }] of this.clients) if (client.readyState === WebSocket.OPEN && !this.options.devices.authenticate(proof)) {
      this.options.trace?.("remote.socket", { event: "refused", why: "device no longer paired" });
      client.close(1008, "session authentication required"); upstream.terminate();
    }
    for (const transfer of this.transfers.values()) if (!this.options.devices.authenticate(transfer.proof)) transfer.cancel();
  }
  async stop(): Promise<void> {
    this.closing = true;
    clearInterval(this.sweep);
    for (const [client, { upstream }] of this.clients) { client.terminate(); upstream.terminate(); }
    for (const transfer of this.transfers.values()) transfer.cancel();
    this.wss.close();
    const closed = new Promise<void>((resolve, reject) => this.server.close(error => error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()));
    this.server.closeAllConnections();
    await closed;
  }
}
