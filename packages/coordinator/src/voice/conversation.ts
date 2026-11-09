import { once } from "node:events";
import WebSocket from "ws";
import { speakableConversationText, type VoiceConversationCommand, type VoiceConversationResponse } from "@arke-studio/contracts";
import type { TransportRequester } from "../transport.js";

export interface LiveSpeechEndpoint { url: string; headers: Record<string, string> }
export interface VoiceConversationScope {
  signal: AbortSignal;
  current(): boolean;
  voice: string;
  run(text: string, signal: AbortSignal, delta: (text: string) => void): Promise<{ status: string; reply?: string }>;
  refresh(): Promise<void>;
}
interface Session {
  id: string; requester: TransportRequester; control: AbortController; ready: boolean;
  scope?: VoiceConversationScope; socket?: WebSocket; timer?: ReturnType<typeof setInterval>;
  turn?: { id: string; control: AbortController; work: Promise<void> };
  work: Promise<void>;
}

/** One captured requester and conversation. Audio is transient; model/history work
 * stays in the ordinary World Chat runner. No cloud capability crosses to Python. */
export class VoiceConversationHost {
  private active: Session | null = null;
  private stopping = false;
  private readonly work = new Set<Promise<void>>();
  constructor(private readonly deps: {
    endpoint(signal: AbortSignal): Promise<LiveSpeechEndpoint | null>;
    scope(command: Extract<VoiceConversationCommand["command"], { action: "open" }>, signal: AbortSignal): Promise<VoiceConversationScope>;
  }) {}
  private current(session: Session): boolean {
    return !this.stopping && this.active === session && !session.control.signal.aborted && !session.requester.signal.aborted && (!session.scope || session.scope.current());
  }
  private reply(session: Session, response: VoiceConversationResponse): boolean {
    return this.current(session) && session.requester.voice?.(session.id, response) === true;
  }
  private send(session: Session, data: unknown): boolean {
    const socket = session.socket;
    if (!this.current(session) || socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > 256 * 1024) return false;
    socket.send(JSON.stringify(data)); return true;
  }
  private end(session: Session, failed = false): void {
    if (session.control.signal.aborted) return;
    // A content-free terminal reply must still stop capture after another requester
    // changes the shared conversation. Audio/text retain the stricter scope fence.
    if (!session.requester.signal.aborted) session.requester.voice?.(session.id, { type: "state", state: failed ? "failed" : "ended", ...(failed ? { reason: "Voice conversation stopped. Check local speech and the selected model, then start again." } : {}) });
    session.control.abort(); session.turn?.control.abort(); clearInterval(session.timer);
    session.socket?.terminate();
    if (this.active === session) this.active = null;
  }
  handle(message: VoiceConversationCommand, requester: TransportRequester): void {
    if (this.stopping || requester.signal.aborted || !requester.voice) return;
    const command = message.command;
    if (command.action === "open") {
      if (this.active) { requester.voice(message.session, { type: "state", state: "failed", reason: "End the current voice conversation first." }); return; }
      const session: Session = { id: message.session, requester, control: new AbortController(), ready: false, work: Promise.resolve() };
      this.active = session;
      const disconnected = () => this.end(session);
      requester.signal.addEventListener("abort", disconnected, { once: true });
      session.work = this.open(session, command).catch(() => this.end(session, true)).finally(() => {
        requester.signal.removeEventListener("abort", disconnected);
        this.work.delete(session.work);
      });
      this.work.add(session.work); return;
    }
    const session = this.active;
    if (!session || session.id !== message.session || session.requester !== requester) return;
    if (!this.current(session)) { this.end(session); return; }
    if (command.action === "end") { this.end(session); return; }
    if (command.action === "interrupt") {
      session.turn?.control.abort();
      this.send(session, { type: "interrupt" });
      this.reply(session, { type: "interrupted" }); return;
    }
    if (!session.ready) return;
    const audio = Buffer.from(command.audioBase64, "base64");
    if (!audio.length || audio.length % 2 || audio.length > 8192 || audio.toString("base64") !== command.audioBase64 || !this.send(session, { type: "audio", audio: command.audioBase64 })) this.end(session, true);
  }
  private async open(session: Session, command: Extract<VoiceConversationCommand["command"], { action: "open" }>): Promise<void> {
    this.reply(session, { type: "state", state: "starting" });
    const signal = AbortSignal.any([session.control.signal, session.requester.signal, AbortSignal.timeout(15_000)]);
    session.scope = await this.deps.scope(command, signal);
    const endpoint = await this.deps.endpoint(signal);
    if (!this.current(session) || !endpoint) throw new Error("Speech unavailable");
    const url = new URL(endpoint.url);
    if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || url.pathname !== "/live" || url.username || url.password || url.search || url.hash) throw new Error("Invalid private speech endpoint");
    const socket = session.socket = new WebSocket(url, { headers: endpoint.headers, maxPayload: 64 * 1024, handshakeTimeout: 5000, followRedirects: false });
    // Observe failure before awaiting open; an early error cannot escape the owner.
    const closed = new Promise<void>(resolve => {
      socket.once("close", () => { this.end(session, !session.control.signal.aborted); resolve(); });
      socket.on("error", () => this.end(session, true));
    });
    socket.on("message", bytes => {
      try { this.message(session, JSON.parse(String(bytes))); } catch { this.end(session, true); }
    });
    await once(socket, "open", { signal });
    this.send(session, { voice: session.scope.voice, silenceMs: command.silenceMs });
    session.timer = setInterval(() => { if (!this.current(session)) this.end(session); }, 250);
    const readyTimer = setTimeout(() => { if (!session.ready) this.end(session, true); }, 10_000);
    try { await closed; await session.turn?.work; }
    finally { clearTimeout(readyTimer); clearInterval(session.timer); }
  }
  private message(session: Session, message: Record<string, unknown>): void {
    if (!this.current(session)) { this.end(session); return; }
    const type = message.type;
    if (type === "ready") { session.ready = true; this.reply(session, { type: "state", state: "listening" }); }
    else if (type === "state" && ["listening", "thinking", "speaking"].includes(String(message.state))) {
      this.reply(session, { type: "state", state: message.state as "listening" | "thinking" | "speaking" });
    } else if (type === "interrupted") {
      session.turn?.control.abort(); this.reply(session, { type: "interrupted" });
    } else if (type === "audio") {
      const audio = message.audio;
      if (typeof audio !== "string" || audio.length > 11000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio)) throw new Error("Invalid speech audio");
      this.reply(session, { type: "audio", audioBase64: audio });
    } else if (type === "turn") {
      const id = message.turn, text = message.text;
      if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id) || typeof text !== "string" || !text.trim() || text.length > 8000) throw new Error("Invalid speech turn");
      const previous = session.turn;
      previous?.control.abort();
      const control = new AbortController();
      const work = Promise.resolve(previous?.work).then(async () => {
        if (!this.current(session) || control.signal.aborted) return;
        this.reply(session, { type: "text", role: "user", text, final: true });
        const result = await session.scope!.run(text, AbortSignal.any([control.signal, session.control.signal, session.scope!.signal]), delta => {
          if (session.turn?.id !== id || control.signal.aborted || !speakableConversationText(delta)) return;
          const characters = Array.from(delta);
          for (let at = 0; at < characters.length; at += 1024) {
            const text = characters.slice(at, at + 1024).join("");
            this.send(session, { type: "delta", turn: id, text });
            this.reply(session, { type: "text", role: "studio", text, final: false });
          }
        });
        if (session.turn?.id === id && !control.signal.aborted) {
          this.send(session, { type: result.status === "completed" ? "done" : "failed", turn: id });
          if (result.status !== "completed") this.end(session, true);
        }
        await session.scope!.refresh();
      }).catch(() => this.end(session, true));
      session.turn = { id, control, work };
    } else if (type === "turn-ended") {
      const turn = session.turn; if (turn && turn.id === message.turn) turn.control.abort();
    } else if (type === "failed") this.end(session, true);
    else throw new Error("Unknown speech frame");
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.active) this.end(this.active);
    await Promise.allSettled(this.work);
  }
}
