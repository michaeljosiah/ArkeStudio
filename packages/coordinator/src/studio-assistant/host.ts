import { join } from "node:path";
import { createHash } from "node:crypto";
import { STUDIO_ASSISTANT_LIMITS, normalizeSpeechText, type HarnessAdapter, type StudioAssistantCommand, type StudioAssistantResponse } from "@arke-studio/contracts";
import { splitForSpeech } from "../voice/split.js";
import type { SessionInput } from "../harness/session-files.js";
import type { TransportRequester } from "../transport.js";
import { studioDiagnosticEvidence, type StudioEvidenceSources } from "./evidence.js";
import { HarnessStudioModelRunner, type StudioModelPort } from "./runner.js";
import { StudioAssistantService } from "./service.js";
import { FileStudioConversationStore } from "./store.js";

export interface StudioAssistantHostOptions {
  /** Trusted host seam, never a renderer/model command. */
  model?: StudioModelPort;
  destination?(model: string, provider: string): { local: boolean; identity: string } | null;
  responseMs?: number;
}
interface Client { pending: number; seen: Set<string>; unwatch?: () => void; detach(): void }
const result = (status: "ok" | "accepted" | "refused" | "unconfirmed", reason: Extract<StudioAssistantResponse, { type: "result" }>["reason"] = null,
  threadId: string | null = null, runId: string | null = null): StudioAssistantResponse => ({ type: "result", status, reason, threadId, runId });

/** App-owned private RPC. Observation timeouts do not prove an operation did not happen;
 * uncertain work stays reachable and consumes admission until its actual settlement. */
export class StudioAssistantHost {
  private readonly closed = new AbortController();
  private readonly clients = new Map<TransportRequester, Client>();
  private readonly work = new Set<Promise<void>>();
  private pending = 0;
  private dictating = false;
  private speech: { requester: TransportRequester; requestId: string; control: AbortController } | null = null;
  constructor(readonly service: StudioAssistantService, private readonly responseMs = 5000,
    private readonly transcribe?: (audio: Uint8Array, contentType: string, signal: AbortSignal) => Promise<string>,
    private readonly readSpeech?: (text: string, expectedVoice: string | undefined, signal: AbortSignal, current: () => boolean) => Promise<{ audio: Uint8Array; voiceId: string }>) {}
  private client(requester: TransportRequester): Client {
    const existing = this.clients.get(requester); if (existing) return existing;
    const abort = () => { state.unwatch?.(); requester.signal.removeEventListener("abort", abort); this.clients.delete(requester); };
    const state: Client = { pending: 0, seen: new Set(), detach: abort }; this.clients.set(requester, state);
    requester.signal.addEventListener("abort", abort, { once: true }); return state;
  }
  async handle(message: StudioAssistantCommand, requester: TransportRequester): Promise<void> {
    if (this.closed.signal.aborted || requester.signal.aborted) return;
    const client = this.client(requester), id = message.requestId, command = message.command;
    if (client.seen.has(id)) { requester.reply(id, result("refused", "invalid")); return; }
    // A bounded volatile duplicate window, not a durable execution/idempotency ledger.
    client.seen.add(id); if (client.seen.size > 64) client.seen.delete(client.seen.values().next().value!);
    if (command.action === "stop-reply-read") {
      const speech = this.speech, own = speech?.requester === requester && speech.requestId === command.readRequestId;
      if (own) speech!.control.abort();
      requester.reply(id, result(own ? "ok" : "refused", own ? null : "invalid")); return;
    }
    if (command.action === "cancel" || command.action === "approve-cloud" || command.action === "unwatch") {
      let accepted = true;
      if (command.action === "unwatch") { client.unwatch?.(); client.unwatch = undefined; }
      else if (command.action === "cancel") accepted = this.service.cancel(command.threadId, command.runId);
      else accepted = this.service.approveCloud(command.threadId, command.runId, command.shareId, command.digest);
      requester.reply(id, result(accepted ? "ok" : "refused", accepted ? null : "invalid")); return;
    }
    if (client.pending >= 2 || this.pending >= 8) { requester.reply(id, result("refused", "busy")); return; }
    if (command.action === "read-reply" && this.speech) { requester.reply(id, result("refused", "busy")); return; }
    const speech = command.action === "read-reply" ? { requester, requestId: id, control: new AbortController() } : null;
    if (speech) this.speech = speech;
    client.pending++; this.pending++;
    const observation = new AbortController(), signal = AbortSignal.any([observation.signal, requester.signal, this.closed.signal, ...(speech ? [speech.control.signal] : [])]);
    let timer: ReturnType<typeof setTimeout> | undefined, abandon!: () => void;
    const abandoned = new Promise<void>(resolve => {
      abandon = () => resolve(); signal.addEventListener("abort", abandon, { once: true });
      timer = setTimeout(() => {
        if (!signal.aborted) requester.reply(id, result("unconfirmed", "timeout"));
        observation.abort();
      }, command.action === "read-reply" ? 50_000 : command.action === "dictate" ? 45_000 : this.responseMs);
    });
    const work = this.execute(message, requester, client, signal).then(response => {
      if (response && !signal.aborted) requester.reply(id, response);
    }, () => { if (!signal.aborted) requester.reply(id, result("unconfirmed", "unavailable")); }).finally(() => {
      client.pending--; this.pending--; this.work.delete(work);
      if (speech && this.speech === speech) this.speech = null;
    });
    this.work.add(work);
    try { await Promise.race([work, abandoned]); }
    finally { clearTimeout(timer); signal.removeEventListener("abort", abandon); }
  }
  private async execute(message: StudioAssistantCommand, requester: TransportRequester, client: Client, signal: AbortSignal): Promise<StudioAssistantResponse | null> {
    // Dictation is a transient local read. It neither depends on writable chat history nor
    // emits the ordinary dictation.result event, which is shared with contextual chats.
    if (message.command.action === "dictate") {
      if (!this.transcribe) return result("refused", "unavailable");
      if (this.dictating) return result("refused", "busy");
      const audio = Buffer.from(message.command.audioBase64, "base64");
      if (!audio.length || audio.length > STUDIO_ASSISTANT_LIMITS.dictationBytes || audio.toString("base64") !== message.command.audioBase64) return result("refused", "invalid");
      signal.throwIfAborted(); this.dictating = true;
      try {
        const text = await this.transcribe(audio, message.command.contentType, signal);
        if (signal.aborted) return null;
        if (typeof text !== "string" || text.length > STUDIO_ASSISTANT_LIMITS.requestChars) return result("refused", "full");
        return { type: "dictation", text };
      } catch { return signal.aborted ? null : result("refused", "unavailable"); }
      finally { this.dictating = false; }
    }
    await this.service.open(); if (signal.aborted) return null;
    const command = message.command;
    if (command.action === "read-reply") {
      if (!this.readSpeech) return result("refused", "unavailable");
      const text = this.service.readableReply(command.threadId, command.messageId);
      if (text === null) return result("refused", "invalid");
      const normalized = normalizeSpeechText(text), source = createHash("sha256").update(normalized).digest("hex");
      const parts = splitForSpeech(normalized, STUDIO_ASSISTANT_LIMITS.speechChunkChars), part = parts[command.part];
      if (!part || parts.length > STUDIO_ASSISTANT_LIMITS.speechParts || command.source && command.source !== source || command.part > 0 && (!command.source || !command.voiceId)) return result("refused", "invalid");
      try {
        const current = () => !signal.aborted && this.service.readableReply(command.threadId, command.messageId) === text;
        const speech = await this.readSpeech(part, command.voiceId, signal, current); signal.throwIfAborted();
        if (!current()) return result("refused", "invalid");
        if (speech.audio.byteLength > STUDIO_ASSISTANT_LIMITS.speechBytes || speech.audio.byteLength < 44 || !speech.voiceId || speech.voiceId.length > 128 || command.voiceId && speech.voiceId !== command.voiceId) return result("refused", "unavailable");
        return { type: "speech", part: command.part, parts: parts.length, source, voiceId: speech.voiceId, format: "wav", audioBase64: Buffer.from(speech.audio).toString("base64") };
      } catch { return signal.aborted ? null : result("refused", "unavailable"); }
    }
    switch (command.action) {
      case "watch":
        client.unwatch?.(); client.unwatch = this.service.subscribe(state => { if (!this.closed.signal.aborted) requester.reply(message.requestId, { type: "state", state }); });
        requester.reply(message.requestId, { type: "state", state: this.service.snapshot() }); return null;
      case "create": { const id = await this.service.createThread(), state = this.service.snapshot(); return id ? result("ok", null, id) : result("refused", state.audit !== "available" ? "unavailable" : state.busy ? "busy" : "full"); }
      case "archive": return await this.service.archive(command.threadId, command.archived) ? result("ok") : result("refused", "invalid");
      case "acknowledge": return await this.service.acknowledgeInterruption(command.threadId, command.runId) ? result("ok") : result("refused", "invalid");
      case "send": {
        const sent = await this.service.send({ threadId: command.threadId, text: command.text, model: command.model,
          ...(command.diagnosticModel ? { diagnosticModel: command.diagnosticModel } : {}) });
        return sent.status === "accepted" ? result("accepted", null, command.threadId, sent.runId) : result("refused", sent.reason);
      }
      default: return result("refused", "invalid");
    }
  }
  stop(): Promise<void> {
    this.closed.abort(); for (const client of this.clients.values()) client.detach();
    return this.service.stop();
  }
}
export function createStudioAssistantHost(deps: { root: string; adapter(): HarnessAdapter | null; sessionInput: SessionInput;
  evidence(): StudioEvidenceSources; now(): number; options?: StudioAssistantHostOptions;
  transcribe?(audio: Uint8Array, contentType: string, signal: AbortSignal): Promise<string>;
  readSpeech?(text: string, expectedVoice: string | undefined, signal: AbortSignal, current: () => boolean): Promise<{ audio: Uint8Array; voiceId: string }> }): StudioAssistantHost {
  const model = deps.options?.model ?? new HarnessStudioModelRunner({ adapter: deps.adapter, sessionInput: deps.sessionInput,
    scratch: join(deps.root, "studio-assistant", "turns"), destination: (model, provider) => deps.options?.destination?.(model, provider) ?? null });
  const service = new StudioAssistantService({ store: new FileStudioConversationStore(join(deps.root, "studio-assistant", "conversations.json")),
    model, now: deps.now, evidence: topic => studioDiagnosticEvidence(topic, deps.evidence(), deps.now()) });
  return new StudioAssistantHost(service, deps.options?.responseMs, deps.transcribe, deps.readSpeech);
}
