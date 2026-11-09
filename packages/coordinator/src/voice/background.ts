import { newId, voiceBackgroundTerminal, voiceBackgroundTransition, VOICE_BACKGROUND_SCHEMA_VERSION,
  type ConversationId, type MessageId, type RunId, type TurnId, type VoiceBackgroundOperation, type WorldChatCheckReceipt } from "@arke-studio/contracts";
import { WorldChatStore, conversationDir } from "../world-chat/store.js";
import { foldConversation } from "../world-chat/fold.js";
import type { WorldStore } from "../world/store.js";

export interface VoiceBackgroundContext {
  worldId: string; conversationId: ConversationId; runId: RunId; turnId: TurnId;
  model: string; variant?: string;
}
export interface VoiceBackgroundResult { text: string; receipts: WorldChatCheckReceipt[] }
interface Active {
  value: VoiceBackgroundOperation; store: WorldStore; chat: WorldChatStore;
  control: AbortController; tail: Promise<void>;
}

/** Bounded read-only work in existing conversation journals, never a second job queue. */
export class VoiceBackgroundOwner {
  private readonly active = new Map<string, Active>();
  private readonly starting = new Map<string, Promise<VoiceBackgroundOperation>>();
  private readonly work = new Set<Promise<void>>();
  private stopping = false;
  constructor(private readonly deps: {
    withStore<T>(worldId: string, work: (store: WorldStore) => Promise<T>): Promise<T>;
    execute(store: WorldStore, operation: VoiceBackgroundOperation, context: VoiceBackgroundContext, signal: AbortSignal): Promise<VoiceBackgroundResult>;
    changed?(worldId: string, conversationId: ConversationId): Promise<void>;
    now?: () => string;
  }) {}
  private now(): string { return this.deps.now?.() ?? new Date().toISOString(); }
  private async read(store: WorldStore, id: ConversationId): Promise<VoiceBackgroundOperation[]> {
    await store.assertOwnership();
    const chat = new WorldChatStore(conversationDir(store.dir, id));
    const { events, problems } = await chat.read();
    const meta = await chat.readMeta();
    const folded = foldConversation(id, meta?.createdAt ?? this.now(), events);
    if (!meta || problems.length || folded.problems.length) throw new Error("Reopen a healthy conversation to use background work.");
    const operations = folded.view.voiceOperations ?? [];
    if (operations.some(row => row.worldId !== store.worldId)) throw new Error("The retained background lookup belongs to another world.");
    return operations;
  }
  private async update(active: Active, change: (old: VoiceBackgroundOperation) => VoiceBackgroundOperation | null,
    receipts?: WorldChatCheckReceipt[]): Promise<void> {
    const work = active.tail.then(async () => {
      const next = change(active.value); if (!next) return;
      if (!voiceBackgroundTransition(active.value, next)) throw new Error("Invalid background lookup transition.");
      await active.store.assertOwnership();
      const terminal = voiceBackgroundTerminal(next) && !voiceBackgroundTerminal(active.value);
      const text = next.status === "completed" ? `Background lookup ${next.id}: ${next.result}`
        : next.status === "cancelled" ? `Background lookup ${next.id} stopped.`
          : `Background lookup ${next.id} did not finish. No automatic retry was made.`;
      const result = await active.chat.append({ type: "voice.operation", operation: next,
        ...(terminal ? { message: { id: newId("msg") as MessageId, turnId: next.turnId, role: "studio" as const,
          text, attachmentIds: [], createdAt: next.updatedAt }, ...(receipts ? { receipts: receipts.slice(0, 32) } : {}) } : {}),
      }, { at: next.updatedAt, ...(terminal ? { requestId: `voice-outcome/${next.id}` } : {}) });
      active.value = result.envelope.event.type === "voice.operation" ? result.envelope.event.operation : next;
    });
    active.tail = work;
    await work;
  }
  start(context: VoiceBackgroundContext, request: string): Promise<VoiceBackgroundOperation> {
    request = request.trim();
    if (!request || request.length > 1500 || this.stopping) return Promise.reject(new Error("Background lookup is unavailable."));
    const key = JSON.stringify([context.worldId, context.conversationId, context.runId, request]);
    const existing = this.starting.get(key); if (existing) return existing;
    const running = [...this.active.values()].find(row => row.value.worldId === context.worldId && row.value.conversationId === context.conversationId
      && row.value.initiatingRunId === context.runId && row.value.request === request);
    if (running) return Promise.resolve(running.value);
    if (this.active.size + this.starting.size >= 2) return Promise.reject(new Error("Two background lookups are already running. Wait or cancel one."));
    const starting = this.admit(context, request).finally(() => this.starting.delete(key));
    this.starting.set(key, starting);
    return starting;
  }
  private admit(context: VoiceBackgroundContext, request: string): Promise<VoiceBackgroundOperation> {
    let acknowledge!: (operation: VoiceBackgroundOperation) => void, refuse!: (error: unknown) => void;
    const admitted = new Promise<VoiceBackgroundOperation>((resolve, reject) => { acknowledge = resolve; refuse = reject; });
    const work = this.deps.withStore(context.worldId, async store => {
      if (this.stopping || store.worldId !== context.worldId) throw new Error("Background lookup is stopping.");
      const previous = await this.read(store, context.conversationId);
      const duplicate = previous.find(row => row.initiatingRunId === context.runId && row.request === request);
      if (duplicate) { acknowledge(duplicate); return; }
      if (previous.length >= 200) throw new Error("Start another conversation before adding more background lookups.");
      const chat = new WorldChatStore(conversationDir(store.dir, context.conversationId));
      const log = await chat.read();
      if (!log.events.some(row => row.event.type === "turn.started" && row.event.run.id === context.runId
        && row.event.run.turnId === context.turnId)) throw new Error("The initiating spoken turn is unavailable.");
      await store.ensureSchemaVersion(VOICE_BACKGROUND_SCHEMA_VERSION, "voice-background");
      const value: VoiceBackgroundOperation = { id: newId("vop"), worldId: context.worldId, conversationId: context.conversationId,
        initiatingRunId: context.runId, turnId: context.turnId, model: context.model, ...(context.variant ? { variant: context.variant } : {}),
        request, status: "requested", createdAt: this.now(), updatedAt: this.now() };
      const active: Active = { value, store, chat, control: new AbortController(), tail: Promise.resolve() };
      this.active.set(value.id, active);
      try {
        await store.assertOwnership();
        await chat.append({ type: "voice.operation", operation: value }, { at: value.createdAt });
        acknowledge(value); // Flushed intent before dispatch; never await the worker in the tool call.
        await this.update(active, old => old.status !== "requested" ? null : ({ ...old, status: "running", updatedAt: this.now() }));
        await this.deps.changed?.(context.worldId, context.conversationId).catch(() => {});
        if (this.stopping || active.value.status === "cancel-requested") active.control.abort();
        let result: VoiceBackgroundResult | undefined;
        try { active.control.signal.throwIfAborted(); result = await this.deps.execute(store, value, context, active.control.signal); }
        catch { /* Static outcome below; no native error or tool content enters diagnostics. */ }
        await this.update(active, old => voiceBackgroundTerminal(old) ? null : ({ ...old,
          status: active.control.signal.aborted ? "cancelled" : result ? "completed" : "failed", updatedAt: this.now(),
          ...(result && !active.control.signal.aborted ? { result: result.text } : {}),
        }), result?.receipts);
        await this.deps.changed?.(context.worldId, context.conversationId).catch(() => {});
      } finally { this.active.delete(value.id); }
    }).catch(refuse).finally(() => this.work.delete(work));
    this.work.add(work);
    return admitted;
  }
  async list(worldId: string, id: ConversationId): Promise<VoiceBackgroundOperation[]> {
    return this.deps.withStore(worldId, async store => {
      if (store.worldId !== worldId) throw new Error("The background lookup world changed.");
      const rows = await this.read(store, id);
      for (const row of rows) {
        if (voiceBackgroundTerminal(row) || this.active.has(row.id)) continue;
        const active: Active = { value: row, store, chat: new WorldChatStore(conversationDir(store.dir, id)),
          control: new AbortController(), tail: Promise.resolve() };
        // A prior process may have sent the cloud request. Retain unknown; never replay it.
        await this.update(active, old => ({ ...old, status: "unknown", updatedAt: this.now() }));
      }
      return this.read(store, id);
    });
  }
  async cancel(worldId: string, id: ConversationId, operationId: string): Promise<VoiceBackgroundOperation | null> {
    const active = this.active.get(operationId);
    if (!active || active.value.worldId !== worldId || active.value.conversationId !== id)
      return (await this.list(worldId, id)).find(row => row.id === operationId) ?? null;
    await this.update(active, old => voiceBackgroundTerminal(old) || old.status === "cancel-requested" ? null
      : ({ ...old, status: "cancel-requested", updatedAt: this.now() }));
    if (!voiceBackgroundTerminal(active.value)) active.control.abort();
    return active.value;
  }
  async markSpeechAttempted(worldId: string, id: ConversationId, operationId: string): Promise<VoiceBackgroundOperation | null> {
    return this.deps.withStore(worldId, async store => {
      if (store.worldId !== worldId) throw new Error("The background lookup world changed.");
      const row = (await this.read(store, id)).find(row => row.id === operationId);
      if (!row || row.status !== "completed" || row.speechAttempted) return null;
      const next = { ...row, speechAttempted: true, updatedAt: this.now() };
      await store.assertOwnership();
      const result = await new WorldChatStore(conversationDir(store.dir, id)).append({ type: "voice.operation", operation: next },
        { at: next.updatedAt, requestId: `voice-speech/${row.id}` });
      return result.deduplicated ? null : next;
    });
  }
  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([...this.active.values()].map(async active => {
      try { await this.cancel(active.value.worldId, active.value.conversationId, active.value.id); }
      finally { active.control.abort(); }
    }));
    await Promise.allSettled(this.work);
  }
}
