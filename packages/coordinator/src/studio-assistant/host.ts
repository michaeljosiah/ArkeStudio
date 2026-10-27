import { join } from "node:path";
import type { HarnessAdapter, StudioAssistantCommand, StudioAssistantResponse } from "@arke-studio/contracts";
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
  constructor(readonly service: StudioAssistantService, private readonly responseMs = 5000) {}
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
    if (command.action === "cancel" || command.action === "approve-cloud" || command.action === "unwatch") {
      let accepted = true;
      if (command.action === "unwatch") { client.unwatch?.(); client.unwatch = undefined; }
      else if (command.action === "cancel") accepted = this.service.cancel(command.threadId, command.runId);
      else accepted = this.service.approveCloud(command.threadId, command.runId, command.shareId, command.digest);
      requester.reply(id, result(accepted ? "ok" : "refused", accepted ? null : "invalid")); return;
    }
    if (client.pending >= 2 || this.pending >= 8) { requester.reply(id, result("refused", "busy")); return; }
    client.pending++; this.pending++;
    const observation = new AbortController(), signal = AbortSignal.any([observation.signal, requester.signal, this.closed.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined, abandon!: () => void;
    const abandoned = new Promise<void>(resolve => {
      abandon = () => resolve(); signal.addEventListener("abort", abandon, { once: true });
      timer = setTimeout(() => {
        if (!signal.aborted) requester.reply(id, result("unconfirmed", "timeout"));
        observation.abort();
      }, this.responseMs);
    });
    const work = this.execute(message, requester, client, signal).then(response => {
      if (response && !signal.aborted) requester.reply(id, response);
    }, () => { if (!signal.aborted) requester.reply(id, result("unconfirmed", "unavailable")); }).finally(() => {
      client.pending--; this.pending--; this.work.delete(work);
    });
    this.work.add(work);
    try { await Promise.race([work, abandoned]); }
    finally { clearTimeout(timer); signal.removeEventListener("abort", abandon); }
  }
  private async execute(message: StudioAssistantCommand, requester: TransportRequester, client: Client, signal: AbortSignal): Promise<StudioAssistantResponse | null> {
    await this.service.open(); if (signal.aborted) return null;
    const command = message.command;
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
  evidence(): StudioEvidenceSources; now(): number; options?: StudioAssistantHostOptions }): StudioAssistantHost {
  const model = deps.options?.model ?? new HarnessStudioModelRunner({ adapter: deps.adapter, sessionInput: deps.sessionInput,
    scratch: join(deps.root, "studio-assistant", "turns"), destination: (model, provider) => deps.options?.destination?.(model, provider) ?? null });
  const service = new StudioAssistantService({ store: new FileStudioConversationStore(join(deps.root, "studio-assistant", "conversations.json")),
    model, now: deps.now, evidence: topic => studioDiagnosticEvidence(topic, deps.evidence(), deps.now()) });
  return new StudioAssistantHost(service, deps.options?.responseMs);
}
