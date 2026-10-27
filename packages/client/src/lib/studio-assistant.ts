import type { StudioAssistantCommand, StudioAssistantResponse, StudioAssistantSnapshot } from "@arke-studio/contracts";
import { STUDIO_ASSISTANT_LIMITS, StudioAssistantCommandSchema } from "@arke-studio/contracts";

type Command = StudioAssistantCommand["command"];
type Reply = Extract<StudioAssistantResponse, { type: "result" }>;
export interface StudioConversationView {
  open: boolean; connected: boolean; fresh: boolean; submitting: boolean; state: StudioAssistantSnapshot | null;
  selected: string | null; draft: string; model: string | undefined; trouble: string | null;
}
const uncertain = (): Reply => ({ type: "result", status: "unconfirmed", reason: "unavailable", threadId: null, runId: null });

/** Private app conversation client. Only observation is restored on reconnect; mutations
 * are never queued/replayed, and no Studio content enters shared app/world state. */
export class StudioConversationClient {
  private view: StudioConversationView = { open: false, connected: false, fresh: false, submitting: false, state: null, selected: null, draft: "", model: undefined, trouble: null };
  private readonly listeners = new Set<() => void>();
  private readonly drafts = new Map<string, string>();
  private readonly models = new Map<string, string>();
  private watchId: string | null = null;
  private selectingNew = false;
  private connectionEpoch = 0;
  private dictation: { id: string; resolve(text: string | null): void; timer: ReturnType<typeof setTimeout> } | null = null;
  private readonly pending = new Map<string, { resolve(reply: Reply): void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly wire: { send(message: StudioAssistantCommand): boolean; id(): string }, private readonly timeoutMs = 7000) {}
  getSnapshot = (): StudioConversationView => this.view;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private change(patch: Partial<StudioConversationView>): void { this.view = { ...this.view, ...patch }; for (const listener of this.listeners) listener(); }
  setConnected(connected: boolean): void {
    if (this.view.connected === connected) return;
    this.connectionEpoch++;
    if (this.dictation) { clearTimeout(this.dictation.timer); this.dictation.resolve(null); this.dictation = null; }
    this.watchId = null;
    if (!connected) { for (const request of this.pending.values()) { clearTimeout(request.timer); request.resolve(uncertain()); } this.pending.clear(); }
    this.change({ connected, fresh: false }); if (connected && this.view.open) this.watch();
  }
  open = (): void => { this.change({ open: true }); if (this.view.connected) this.watch(); };
  close = (): void => {
    this.connectionEpoch++;
    if (this.dictation) { clearTimeout(this.dictation.timer); this.dictation.resolve(null); this.dictation = null; }
    if (this.watchId && this.view.connected) this.wire.send({ kind: "studio-assistant", requestId: this.wire.id(), command: { action: "unwatch" } });
    this.watchId = null; this.change({ open: false, fresh: false });
  };
  private watch(): void {
    const requestId = this.wire.id(); this.watchId = requestId;
    if (!this.wire.send({ kind: "studio-assistant", requestId, command: { action: "watch" } })) { this.watchId = null; this.change({ fresh: false, trouble: "Studio is disconnected. Your draft is retained." }); }
  }
  receive(frame: { requestId: string; response: StudioAssistantResponse }): void {
    if (frame.requestId === this.dictation?.id) {
      const pending = this.dictation; this.dictation = null; clearTimeout(pending.timer);
      pending.resolve(frame.response.type === "dictation" ? frame.response.text : null); return;
    }
    if (frame.requestId === this.watchId) {
      if (frame.response.type === "state") {
        const state = frame.response.state;
        const selected = this.view.selected && state.threads.some(thread => thread.id === this.view.selected) ? this.view.selected
          : this.selectingNew || this.view.draft.length > 0 ? null : state.threads.findLast(thread => !thread.archived)?.id ?? null;
        // A close/navigation never retargets the draft. Restored history has no implicit send.
        if (selected !== this.view.selected) this.drafts.set(this.view.selected ?? "new", this.view.draft);
        this.change({ state, fresh: true, selected, model: this.models.get(selected ?? "new"), draft: selected === this.view.selected ? this.view.draft : this.drafts.get(selected ?? "new") ?? "", trouble: null });
      } else this.change({ fresh: false, trouble: "Studio history is unavailable. Your draft is retained." });
      return;
    }
    if (frame.response.type !== "result") return;
    const request = this.pending.get(frame.requestId); if (!request) return;
    clearTimeout(request.timer); this.pending.delete(frame.requestId); request.resolve(frame.response);
  }
  draft = (value: string): void => { if (!this.view.selected) this.selectingNew = true; this.drafts.set(this.view.selected ?? "new", value); this.change({ draft: value }); };
  pickModel = (model: string | undefined): void => { if (model) this.models.set(this.view.selected ?? "new", model); else this.models.delete(this.view.selected ?? "new"); this.change({ model }); };
  select = (id: string | null): void => {
    if (id && !this.view.state?.threads.some(thread => thread.id === id && !thread.archived)) return;
    this.selectingNew = id === null;
    this.drafts.set(this.view.selected ?? "new", this.view.draft);
    this.change({ selected: id, model: this.models.get(id ?? "new"), draft: this.drafts.get(id ?? "new") ?? "", trouble: null });
  };
  /** Capture the draft destination when the microphone opens. A later thread selection cannot
   * redirect its words, and close/reconnect/cancel never submits or replays the recording. */
  dictationTarget(): (audioBase64: string, contentType: string, signal: AbortSignal) => Promise<boolean> {
    const target = this.view.selected, epoch = this.connectionEpoch;
    if (!target) this.selectingNew = true;
    return async (audioBase64, contentType, signal) => {
      if (signal.aborted || !this.view.connected || !this.view.fresh || !this.view.open || this.connectionEpoch !== epoch || this.dictation) return false;
      const command = { action: "dictate", audioBase64, contentType };
      const parsed = StudioAssistantCommandSchema.safeParse({ kind: "studio-assistant", requestId: this.wire.id(), command });
      if (!parsed.success) return false;
      const text = await new Promise<string | null>(resolve => {
        const id = parsed.data.requestId;
        const cancel = () => {
          if (this.dictation?.id !== id) return;
          clearTimeout(this.dictation.timer); this.dictation = null; finish(null);
        };
        const finish = (text: string | null) => { signal.removeEventListener("abort", cancel); resolve(text); };
        const timer = setTimeout(cancel, 50_000);
        this.dictation = { id, resolve: finish, timer }; signal.addEventListener("abort", cancel, { once: true });
        if (!this.wire.send(parsed.data)) cancel();
      });
      if (signal.aborted || !text?.trim() || !this.view.open || !this.view.connected || this.connectionEpoch !== epoch) return false;
      const thread = target && this.view.state?.threads.find(row => row.id === target);
      if (target && (!thread || thread.archived)) return false;
      const key = target ?? "new", current = this.drafts.get(key) ?? "";
      const next = current ? current + " " + text : text;
      if (next.length > STUDIO_ASSISTANT_LIMITS.requestChars) return false;
      this.drafts.set(key, next);
      if (this.view.selected === target) this.change({ draft: next });
      return true;
    };
  }
  async request(command: Command): Promise<Reply> {
    if (!this.view.connected || !this.view.fresh) return { type: "result", status: "refused", reason: "unavailable", threadId: null, runId: null };
    if (this.pending.size >= 4) return { type: "result", status: "refused", reason: "busy", threadId: null, runId: null };
    const requestId = this.wire.id();
    const response = await new Promise<Reply>(resolve => {
      const timer = setTimeout(() => { this.pending.delete(requestId); resolve({ ...uncertain(), reason: "timeout" }); }, this.timeoutMs);
      this.pending.set(requestId, { resolve, timer });
      if (!this.wire.send({ kind: "studio-assistant", requestId, command })) { clearTimeout(timer); this.pending.delete(requestId); resolve(uncertain()); }
    });
    if (response.status === "unconfirmed") this.change({ trouble: "That request is unconfirmed. Review the current conversation before trying again. Your draft is retained." });
    else if (response.status === "refused") this.change({ trouble: response.reason === "busy" ? "Studio is still working. Your draft is retained." : "Studio could not accept that request. Review its current state before continuing." });
    return response;
  }
  async send(model: string): Promise<boolean> {
    const text = this.view.draft, before = this.view.selected; if (!text.trim() || text.length > STUDIO_ASSISTANT_LIMITS.requestChars || !model || this.view.submitting || this.dictation) return false;
    this.change({ submitting: true });
    try {
    let threadId = before;
    if (!threadId) {
      const created = await this.request({ action: "create" }); if (created.status !== "ok" || !created.threadId) return false;
      threadId = created.threadId;
      if (this.view.selected !== before || this.view.draft !== text) return false;
      this.selectingNew = false; this.drafts.set(threadId, text);
      if (this.view.model) this.models.set(threadId, this.view.model);
      this.change({ selected: threadId });
    }
    const sent = await this.request({ action: "send", threadId, model, text });
    if (sent.status !== "accepted") return false;
    if (before === null && this.drafts.get("new") === text) this.drafts.set("new", "");
    // Do not erase new typing or another selected thread while the receipt was in flight.
    if (this.view.selected === threadId && this.view.draft === text) this.draft("");
    return true;
    } finally { this.change({ submitting: false }); }
  }
  dispose(): void { this.setConnected(false); this.listeners.clear(); }
}
