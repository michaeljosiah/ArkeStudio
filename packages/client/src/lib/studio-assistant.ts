import type { StudioAssistantCommand, StudioAssistantResponse, StudioAssistantSnapshot, StudioTextAttachment, PrivateSessionVariant } from "@arke-studio/contracts";
import { STUDIO_ASSISTANT_LIMITS, StudioAssistantCommandSchema, PrivateSessionVariantSchema } from "@arke-studio/contracts";
import { loadStudioDocuments, studioDocumentsFit, studioPastedDocument, type StudioDocumentTrouble } from "./studio-documents.js";

type Command = Exclude<StudioAssistantCommand["command"], { action: "dictate" | "read-reply" }>;
type Reply = Extract<StudioAssistantResponse, { type: "result" }>;
export interface StudioConversationView {
  open: boolean; connected: boolean; fresh: boolean; submitting: boolean; state: StudioAssistantSnapshot | null;
  selected: string | null; draft: string; model: string | undefined; trouble: string | null;
  effort?: { model: string; variant: PrivateSessionVariant };
  attachments: readonly StudioTextAttachment[]; attaching: boolean;
}
const uncertain = (): Reply => ({ type: "result", status: "unconfirmed", reason: "unavailable", threadId: null, runId: null });

/** Private app conversation client. Only observation is restored on reconnect; mutations
 * are never queued/replayed, and no Studio content enters shared app/world state. */
export class StudioConversationClient {
  private view: StudioConversationView = { open: false, connected: false, fresh: false, submitting: false, state: null, selected: null, draft: "", model: undefined, trouble: null, attachments: [], attaching: false };
  private readonly listeners = new Set<() => void>();
  private readonly drafts = new Map<string, string>();
  private readonly models = new Map<string, string>();
  private readonly efforts = new Map<string, NonNullable<StudioConversationView["effort"]>>();
  private readonly documents = new Map<string, readonly StudioTextAttachment[]>();
  private loadingDocuments = false;
  private watchId: string | null = null;
  private selectingNew = false;
  private connectionEpoch = 0;
  private aside = false;
  private dictation: { id: string; resolve(text: string | null): void; timer: ReturnType<typeof setTimeout> } | null = null;
  private speech: { id: string; finish(value: Extract<StudioAssistantResponse, { type: "speech" }> | null): void; timer: ReturnType<typeof setTimeout> } | null = null;
  private readonly pending = new Map<string, { resolve(reply: Reply): void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly wire: { send(message: StudioAssistantCommand): boolean; id(): string }, private readonly timeoutMs = 7000, private readonly documentReadMs = 30_000) {}
  getSnapshot = (): StudioConversationView => this.view;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private change(patch: Partial<StudioConversationView>): void { this.view = { ...this.view, ...patch }; for (const listener of this.listeners) listener(); }
  setConnected(connected: boolean): void {
    if (this.view.connected === connected) return;
    this.connectionEpoch++;
    if (!connected) this.stopSpeech(false);
    if (this.dictation) { clearTimeout(this.dictation.timer); this.dictation.resolve(null); this.dictation = null; }
    this.watchId = null;
    if (!connected) { for (const request of this.pending.values()) { clearTimeout(request.timer); request.resolve(uncertain()); } this.pending.clear(); }
    this.change({ connected, fresh: false }); if (connected && this.view.open) this.watch();
  }
  open = (): void => { this.aside = false; this.change({ open: true }); if (this.view.connected) this.watch(); };
  close = (): void => {
    this.aside = false;
    this.stopSpeech();
    this.connectionEpoch++;
    if (this.dictation) { clearTimeout(this.dictation.timer); this.dictation.resolve(null); this.dictation = null; }
    if (this.watchId && this.view.connected) this.wire.send({ kind: "studio-assistant", requestId: this.wire.id(), command: { action: "unwatch" } });
    this.watchId = null; this.change({ open: false, fresh: false });
  };
  /** Activity takes the dialog's place for a moment (turn 239's fixture): the dialog closes for it and
   * comes back, draft and all, when Activity closes over the same page. Opening or closing Studio
   * meanwhile, or leaving through one of Activity's links, ends the return. */
  stepAside = (): void => { if (!this.view.open) return; this.close(); this.aside = true; };
  comeBack = (samePage: boolean): void => { if (this.aside && samePage) this.open(); this.aside = false; };
  private watch(): void {
    const requestId = this.wire.id(); this.watchId = requestId;
    if (!this.wire.send({ kind: "studio-assistant", requestId, command: { action: "watch" } })) { this.watchId = null; this.change({ fresh: false, trouble: "Studio is disconnected. Your draft is retained." }); }
  }
  receive(frame: { requestId: string; response: StudioAssistantResponse }): void {
    if (frame.requestId === this.speech?.id) {
      const pending = this.speech; this.speech = null; clearTimeout(pending.timer);
      pending.finish(frame.response.type === "speech" ? frame.response : null); return;
    }
    if (frame.requestId === this.dictation?.id) {
      const pending = this.dictation; this.dictation = null; clearTimeout(pending.timer);
      pending.resolve(frame.response.type === "dictation" ? frame.response.text : null); return;
    }
    if (frame.requestId === this.watchId) {
      if (frame.response.type === "state") {
        const state = frame.response.state;
        const selected = this.view.selected && state.threads.some(thread => thread.id === this.view.selected) ? this.view.selected
          : this.selectingNew || this.view.draft.length > 0 || this.view.attachments.length > 0 ? null : state.threads.findLast(thread => !thread.archived)?.id ?? null;
        // A close/navigation never retargets the draft. Restored history has no implicit send.
        if (selected !== this.view.selected) this.drafts.set(this.view.selected ?? "new", this.view.draft);
        this.change({ state, fresh: true, selected, model: this.models.get(selected ?? "new"), effort: this.efforts.get(selected ?? "new"), draft: selected === this.view.selected ? this.view.draft : this.drafts.get(selected ?? "new") ?? "", attachments: this.documents.get(selected ?? "new") ?? [], trouble: null });
      } else this.change({ fresh: false, trouble: "Studio history is unavailable. Your draft is retained." });
      return;
    }
    if (frame.response.type !== "result") return;
    const request = this.pending.get(frame.requestId); if (!request) return;
    clearTimeout(request.timer); this.pending.delete(frame.requestId); request.resolve(frame.response);
  }
  draft = (value: string): void => { if (!this.view.selected) this.selectingNew = true; this.drafts.set(this.view.selected ?? "new", value); this.change({ draft: value }); };
  pickModel = (model: string | undefined): void => {
    const key = this.view.selected ?? "new";
    if (model) this.models.set(key, model); else this.models.delete(key);
    if (model !== this.view.model) this.efforts.delete(key);
    this.change({ model, effort: this.efforts.get(key) });
  };
  pickEffort = (model: string, variant: string): void => {
    const parsed = PrivateSessionVariantSchema.safeParse(variant); if (!parsed.success) return;
    const effort = { model, variant: parsed.data }; this.efforts.set(this.view.selected ?? "new", effort); this.change({ effort });
  };
  select = (id: string | null): void => {
    if (id && !this.view.state?.threads.some(thread => thread.id === id && !thread.archived)) return;
    this.stopSpeech();
    this.selectingNew = id === null;
    this.drafts.set(this.view.selected ?? "new", this.view.draft);
    this.change({ selected: id, model: this.models.get(id ?? "new"), effort: this.efforts.get(id ?? "new"), draft: this.drafts.get(id ?? "new") ?? "", attachments: this.documents.get(id ?? "new") ?? [], trouble: null });
  };
  removeDocument = (id: string): void => {
    const key = this.view.selected ?? "new", next = this.view.attachments.filter(row => row.id !== id);
    this.documents.set(key, next); this.change({ attachments: next });
  };
  attachText = async (text: string): Promise<readonly StudioDocumentTrouble[]> => {
    if (!this.canAttach()) return [{ name: "Pasted text", reason: "Wait until Studio is ready to attach documents." }];
    const document = studioPastedDocument(text, crypto.randomUUID());
    if (!document || !this.appendDocuments(this.view.selected, [document])) return [{ name: "Pasted text", reason: "The pasted text exceeds the document or request limit." }];
    return [];
  };
  private canAttach(): boolean { return this.view.open && this.view.connected && this.view.fresh && !this.view.submitting && !this.loadingDocuments && !this.view.state?.busy &&
    this.view.state?.audit === "available" && (!this.view.selected || !!this.view.state.threads.find(row => row.id === this.view.selected && !row.archived && !row.pending)); }
  private appendDocuments(target: string | null, documents: readonly StudioTextAttachment[]): boolean {
    if (target && !this.view.state?.threads.some(row => row.id === target && !row.archived && !row.pending)) return false;
    const key = target ?? "new", next = [...this.documents.get(key) ?? [], ...documents];
    if (!studioDocumentsFit(this.drafts.get(key) ?? "", next)) return false;
    if (!target) this.selectingNew = true;
    this.documents.set(key, next); if (this.view.selected === target) this.change({ attachments: next }); return true;
  }
  documentPickerTarget(): (files: readonly File[]) => Promise<readonly StudioDocumentTrouble[]> {
    const target = this.view.selected, epoch = this.connectionEpoch;
    if (!target) this.selectingNew = true;
    return files => this.connectionEpoch === epoch && this.view.selected === target ? this.attachFiles(files)
      : Promise.resolve([{ name: "Documents", reason: "The conversation changed while choosing documents. Choose them again in the intended conversation." }]);
  }
  attachFiles = async (files: readonly File[]): Promise<readonly StudioDocumentTrouble[]> => {
    if (!this.canAttach()) return [{ name: "Documents", reason: "Wait until Studio is ready to attach documents." }];
    if (files.length > STUDIO_ASSISTANT_LIMITS.attachments) return [{ name: "Documents", reason: "Choose up to four text documents at a time." }];
    const target = this.view.selected, epoch = this.connectionEpoch, existing = this.view.attachments;
    if (!target) this.selectingNew = true;
    this.loadingDocuments = true; this.change({ attaching: true });
    let abandoned = false, timer: ReturnType<typeof setTimeout> | undefined;
    const work = loadStudioDocuments([...files], existing, () => crypto.randomUUID(), () => !abandoned && epoch === this.connectionEpoch && this.view.open && this.view.connected).then(result => {
      if (abandoned || epoch !== this.connectionEpoch || !this.view.open || !this.view.connected) return [];
      if (result.documents.length && !this.appendDocuments(target, result.documents)) return [{ name: "Documents", reason: "The draft changed or its documents exceed the request limit. Attach them again after reviewing it." }];
      return this.view.selected === target ? result.trouble : [];
    }, () => [{ name: "Documents", reason: "The selected documents could not be read." }]).finally(() => {
      clearTimeout(timer); this.loadingDocuments = false; this.change({ attaching: false });
    });
    // An abandoned File read remains owned until actual settlement; it cannot append late
    // or admit overlapping reads. Closing/reconnecting invalidates its captured destination.
    return Promise.race([work, new Promise<readonly StudioDocumentTrouble[]>(resolve => {
      timer = setTimeout(() => { abandoned = true; resolve([{ name: "Documents", reason: "Reading the documents timed out. Studio is waiting for that read to finish." }]); }, this.documentReadMs);
    })]);
  };
  private stopSpeech(send = this.view.connected): void {
    const pending = this.speech; if (!pending) return;
    this.speech = null; clearTimeout(pending.timer); pending.finish(null);
    if (send) this.wire.send({ kind: "studio-assistant", requestId: this.wire.id(), command: { action: "stop-reply-read", readRequestId: pending.id } });
  }
  async readReplyPart(threadId: string, messageId: string, part: number, signal: AbortSignal,
    previous?: { source?: string; voiceId: string }): Promise<Extract<StudioAssistantResponse, { type: "speech" }> | null> {
    const epoch = this.connectionEpoch, expected = previous ? { ...previous } : undefined;
    if (signal.aborted || !this.view.open || !this.view.connected || !this.view.fresh || this.view.selected !== threadId || this.speech) return null;
    const parsed = StudioAssistantCommandSchema.safeParse({ kind: "studio-assistant", requestId: this.wire.id(), command: {
      action: "read-reply", threadId, messageId, part, ...expected } });
    if (!parsed.success) return null;
    const response = await new Promise<Extract<StudioAssistantResponse, { type: "speech" }> | null>(resolve => {
      const id = parsed.data.requestId, abort = () => { if (this.speech?.id === id) this.stopSpeech(); };
      const finish = (value: Extract<StudioAssistantResponse, { type: "speech" }> | null) => { signal.removeEventListener("abort", abort); resolve(value); };
      const timer = setTimeout(abort, 55_000); this.speech = { id, finish, timer };
      signal.addEventListener("abort", abort, { once: true });
      if (!this.wire.send(parsed.data)) this.stopSpeech(false);
    });
    return signal.aborted || this.connectionEpoch !== epoch || !this.view.open || !this.view.connected || this.view.selected !== threadId || response?.part !== part ||
      expected && (expected.source !== undefined && response?.source !== expected.source || response?.voiceId !== expected.voiceId) ? null : response;
  }
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
    const text = this.view.draft, before = this.view.selected, epoch = this.connectionEpoch, attachments = this.view.attachments.map(row => ({ ...row })), signature = JSON.stringify(attachments);
    const effort = this.view.effort, modelChoice = this.view.model, variant = effort?.model === model ? effort.variant : undefined;
    if (!text.trim() || !studioDocumentsFit(text, attachments) || !model || this.view.submitting || this.dictation || this.loadingDocuments) return false;
    this.stopSpeech(); this.change({ submitting: true });
    try {
    let threadId = before;
    if (!threadId) {
      const created = await this.request({ action: "create" }); if (created.status !== "ok" || !created.threadId) return false;
      threadId = created.threadId;
      if (this.connectionEpoch !== epoch || !this.view.open || this.view.selected !== before || this.view.draft !== text || this.view.model !== modelChoice || this.view.effort !== effort || JSON.stringify(this.view.attachments) !== signature) return false;
      this.selectingNew = false; this.drafts.set(threadId, text);
      this.documents.set(threadId, attachments);
      if (this.view.model) this.models.set(threadId, this.view.model);
      if (effort) this.efforts.set(threadId, effort);
      this.change({ selected: threadId });
    }
    const sent = await this.request({ action: "send", threadId, model, text, ...(variant !== undefined ? { variant } : {}), ...(attachments.length ? { attachments } : {}) });
    if (sent.status !== "accepted") return false;
    if (before === null && this.drafts.get("new") === text) this.drafts.set("new", "");
    if (before === null && JSON.stringify(this.documents.get("new") ?? []) === signature) this.documents.delete("new");
    if (JSON.stringify(this.documents.get(threadId) ?? []) === signature) {
      this.documents.delete(threadId); if (this.view.selected === threadId) this.change({ attachments: [] });
    }
    // Do not erase new typing or another selected thread while the receipt was in flight.
    if (this.drafts.get(threadId) === text) { this.drafts.set(threadId, ""); if (this.view.selected === threadId) this.change({ draft: "" }); }
    return true;
    } finally { this.change({ submitting: false }); }
  }
  dispose(): void { this.setConnected(false); this.listeners.clear(); }
}
