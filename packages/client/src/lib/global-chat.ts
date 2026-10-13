import { ConversationIdSchema, orderedShots, WorldChatContextSchema, WorldChatSubjectSchema, type ClientState, type WorldChatContext } from "@arke-studio/contracts";
import type { ProductionConversationProps } from "../components/conversation.js";

export type ChatSurface = {
  key: string; worldId: string; worldName: string; title: string; label: string;
  kind: "world" | "production" | "setup"; entry: WorldChatContext; path: string;
  conversationId?: string; newThread?: boolean; props?: ProductionConversationProps;
  scopeMissing?: boolean;
};
export const chatKey = (worldId: string, entry: WorldChatContext, conversationId?: string) =>
  `${worldId}:${JSON.stringify(entry)}${conversationId ? ":" + conversationId : ""}`;
export const chatSubjectKey = (value: ChatSurface) => JSON.stringify([value.entry, value.props?.subject,
  value.props?.dock?.subjectPrefix, value.props?.dock?.about]);
export const chatKind = (entry: WorldChatContext): ChatSurface["kind"] => entry.kind === "production-setup" ? "setup"
  : entry.kind === "bench" || "productionId" in entry ? "production" : "world";
export const chatTitle = (entry: WorldChatContext) => chatKind(entry) === "world" ? "World Chat" : entry.kind === "bench" ? "Bench Chat"
  : entry.kind === "shot" ? "Shot Chat" : entry.kind === "stage" ? "Stage Chat" : entry.kind === "takes" ? "Takes Chat" : "Builder Chat";

/** A kept-mounted sheet or CSS-hidden home must not release a body-level composer. */
function chatHostVisible(host: HTMLElement): boolean {
  if (host.isConnected === false || host.closest?.('[hidden],dialog:not([open]),[aria-hidden="true"]')) return false;
  const view = host.ownerDocument?.defaultView;
  for (let node: HTMLElement | null = host; node; node = node.parentElement) {
    const style = typeof view?.getComputedStyle === "function" ? view.getComputedStyle(node) : node.style;
    if (style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse") return false;
  }
  return true;
}

/** Route fallback; mounted workspace registrations supply their exact per-turn selection. */
export function chatSurfaceForPage(state: ClientState | null, path: string): ChatSurface | null {
  const world = state?.world;
  if (!world) return null;
  let route: string[];
  try { route = path.split(/[?#]/)[0]!.split("/").filter(Boolean).map(decodeURIComponent); } catch { return null; }
  if (route[0] !== "w" || route[1] !== world.meta.worldId) return null;
  let entry: WorldChatContext = { kind: "world" }, title = "World Chat", label = world.meta.name;
  let conversationId: string | undefined;
  if (route[2] === "chat") conversationId = route[3];
  const production = route[2] === "p" ? world.productions.find(p => p.meta.id === route[3]) : undefined;
  if (production) {
    entry = { kind: "production", productionId: production.meta.id }; title = "Builder Chat";
    label += " / " + production.meta.title;
    const scene = production.scenes.find(s => s.id === route[5]);
    const query = new URLSearchParams(path.split("?")[1] ?? "");
    const shotId = route[6] === "shots" ? route[7] : query.get("shot") ?? undefined;
    const shot = scene ? orderedShots(scene).find(s => s.id === shotId) : undefined;
    if (route[4] === "cut") { entry = { kind: "cut", productionId: production.meta.id }; label += " / Cut"; }
    else if (route[4] === "generate") {
      const shots = production.scenes.flatMap(s => orderedShots(s));
      const generatedShot = shots.find(s => s.id === query.get("shot")) ?? shots[0];
      const generatedScene = generatedShot ? production.scenes.find(s => orderedShots(s).some(shot => shot.id === generatedShot.id)) : undefined;
      entry = { kind: "generate", productionId: production.meta.id, ...(generatedScene && generatedShot ? { sceneId: generatedScene.id, shotId: generatedShot.id } : {}) };
      label += ` / Generate${generatedShot ? " / Shot " + generatedShot.number : ""}`;
    }
    else if (scene && shot) {
      const kind = query.get("view") === "stage" || route[8] === "stage" ? "stage" : query.get("view") === "takes" ? "takes" : "shot";
      entry = { kind, productionId: production.meta.id, sceneId: scene.id, shotId: shot.id };
      title = kind === "stage" ? "Stage Chat" : kind === "takes" ? "Takes Chat" : "Shot Chat";
      label += ` / Shot ${shot.number}`;
    } else if (scene) { entry = { kind: "scene", productionId: production.meta.id, sceneId: scene.id }; label += ` / Scene ${scene.number}`; }
    else if (route[4] === "episodes" && route[5]) {
      const episode = production.episodes.find(e => e.id === route[5]);
      if (episode) { entry = { kind: "episode", productionId: production.meta.id, episodeId: episode.id }; label += ` / Episode ${episode.order}`; }
    }
  } else if (route[2] === "artifacts" && route[3] === "bench" && route[4]) {
    entry = { kind: "bench", sessionId: route[4] }; title = "Bench Chat"; label += " / Bench";
  } else if (route[2] === "productions" && route[3] === "setup" && ConversationIdSchema.safeParse(route[4]).success) {
    entry = { kind: "production-setup", setupId: route[4]! }; title = "Builder Chat"; label += " / New production";
  }
  const row = conversationId ? world.conversations.find(c => c.id === conversationId) : undefined;
  if (conversationId && !row) { conversationId = undefined; path = `/w/${world.meta.worldId}/chat`; }
  if (row?.entryContext) { entry = row.entryContext; title = chatTitle(entry); label = `${world.meta.name} / ${row.title}`; }
  const kind = chatKind(entry);
  return { key: chatKey(world.meta.worldId, entry, conversationId), worldId: world.meta.worldId,
    worldName: world.meta.name, title, label, kind, entry, path,
    ...(conversationId ? { conversationId } : {}),
    ...(kind === "production" ? { props: conversationProps(world.meta.worldId, entry) } : {}) };
}

export function conversationProps(worldId: string, entry: WorldChatContext): ProductionConversationProps {
  const productionId = "productionId" in entry ? entry.productionId : undefined;
  return { worldId, productionId, entry, placeholder: "Ask Arke…", emptyLine: "Start this conversation with Arke.",
    pointsEmpty: "Nothing understood yet.", dock: { title: "Arke", subject: "", conversationFirst: true } };
}

type Snapshot = { open: boolean; selected: ChatSurface | null; revision: number; stopCapture: number; phase: "idle" | "listening" | "transcribing"; switching: boolean };
type ChatStorage = Pick<Storage, "getItem" | "setItem">;
const STORAGE_KEY = "arke.global-chat.v1";
function savedScope(surface: ChatSurface) {
  const props = surface.props;
  return props ? { subject: props.subject, dock: props.dock ? { title: props.dock.title, subject: props.dock.subject,
    subjectPrefix: props.dock.subjectPrefix, about: props.dock.about, subjectLine: props.dock.subjectLine } : undefined } : undefined;
}
function restoreScope(worldId: string, entry: WorldChatContext, raw: unknown): ProductionConversationProps | undefined {
  if (!raw || typeof raw !== "object" || chatKind(entry) !== "production") return undefined;
  const value = raw as { subject?: unknown; dock?: Record<string, unknown> };
  const subject = WorldChatSubjectSchema.safeParse(value.subject), props = conversationProps(worldId, entry);
  if (value.subject !== undefined && !subject.success) return undefined;
  if (subject.success) props.subject = subject.data;
  if (value.dock && typeof value.dock === "object" && typeof value.dock.title === "string" && typeof value.dock.subject === "string") {
    props.dock = { title: value.dock.title.slice(0, 500), subject: value.dock.subject.slice(0, 500), conversationFirst: true };
    for (const field of ["subjectPrefix", "about", "subjectLine"] as const) {
      const text = value.dock[field];
      if (text !== undefined && (typeof text !== "string" || text.length > 5_000)) return undefined;
      if (typeof text === "string") props.dock[field] = text;
    }
  }
  return props;
}
function restoredSurface(raw: unknown): ChatSurface | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as ChatSurface & { scope?: unknown }, parsed = WorldChatContextSchema.safeParse(value.entry);
  if (typeof value.worldId !== "string" || !parsed.success || ![chatKey(value.worldId, parsed.data), chatKey(value.worldId, parsed.data, value.conversationId)].includes(value.key)) return null;
  if (value.conversationId !== undefined && !ConversationIdSchema.safeParse(value.conversationId).success) return null;
  const props = restoreScope(value.worldId, parsed.data, value.scope);
  return { key: value.key, worldId: value.worldId, worldName: String(value.worldName ?? "World"), title: String(value.title ?? "Chat"), label: String(value.label ?? ""), path: String(value.path ?? ""),
    entry: parsed.data, kind: chatKind(parsed.data),
    conversationId: value.conversationId, props, scopeMissing: chatKind(parsed.data) === "production" && (value.scopeMissing === true || !props) };
}

/** Presentation only. Coordinator identities, workspace state and decision authorities stay in the store. */
export class GlobalChatController {
  private listeners = new Set<() => void>();
  private snapshot: Snapshot = { open: false, selected: null, revision: 0, stopCapture: 0, phase: "idle", switching: false };
  private registrations = new Map<string, { surface: ChatSurface; host: HTMLElement }>();
  private values = new Map<string, Map<string, unknown>>();
  private conversationIds = new Map<string, string>();
  private listedConversations = new Map<string, ReadonlySet<string>>();
  private pending: ChatSurface | null = null;
  private openings = new Set<string>();
  private dictations = new Map<string, { key: string; deliver(text: string): void }>();
  private retained = new Map<string, ChatSurface>();
  private setupRequests = new Map<string, { key: string; operation: string; text?: string }>();
  private createRequests = new Map<string, { key: string; surface: ChatSurface }>();
  current: ChatSurface | null = null;
  constructor(private storage?: ChatStorage) {
    try {
      const saved = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "null");
      if (saved?.version === 1 && typeof saved.open === "boolean" && typeof saved.selected?.worldId === "string" &&
        WorldChatContextSchema.safeParse(saved.selected?.entry).success &&
        [chatKey(saved.selected.worldId, saved.selected.entry), chatKey(saved.selected.worldId, saved.selected.entry, saved.selected.conversationId)].includes(saved.selected?.key)) {
        const entry = WorldChatContextSchema.parse(saved.selected.entry);
        const conversationId = ConversationIdSchema.safeParse(saved.selected.conversationId);
        this.snapshot = { ...this.snapshot, open: saved.open, selected: {
          key: saved.selected.key, worldId: saved.selected.worldId, worldName: String(saved.selected.worldName ?? "World"),
          title: String(saved.selected.title ?? "Chat"), label: String(saved.selected.label ?? ""), path: String(saved.selected.path ?? ""),
          entry, props: restoreScope(saved.selected.worldId, entry, saved.selected.scope),
          scopeMissing: chatKind(entry) === "production" && (saved.selected.scopeMissing === true || !restoreScope(saved.selected.worldId, entry, saved.selected.scope)),
          kind: chatKind(entry),
          ...(conversationId.success ? { conversationId: conversationId.data } : {}), newThread: saved.selected.newThread === true } };
        if (conversationId.success) this.conversationIds.set(saved.selected.key, conversationId.data);
        for (const raw of Object.values(saved.retained ?? {})) {
          const surface = restoredSurface(raw);
          if (surface?.conversationId) this.retained.set(`${surface.worldId}:${surface.conversationId}`, surface);
        }
        if (this.snapshot.selected?.conversationId) this.retained.set(`${this.snapshot.selected.worldId}:${this.snapshot.selected.conversationId}`, this.snapshot.selected);
        for (const [key, id] of Object.entries(saved.conversationIds ?? {})) if (typeof id === "string" && ConversationIdSchema.safeParse(id).success) this.conversationIds.set(key, id);
        for (const [key, draft] of Object.entries(saved.drafts ?? {})) if (typeof draft === "string") this.values.set(key, new Map([["draft", draft]]));
        for (const [key, fields] of Object.entries(saved.choices ?? {})) {
          if (!fields || typeof fields !== "object") continue;
          const value = fields as { model?: unknown; variants?: unknown; omitted?: unknown; createRequestId?: unknown };
          if (!this.values.has(key)) this.values.set(key, new Map());
          const values = this.values.get(key)!;
          if (typeof value.model === "string") values.set("languageModel", value.model);
          if (typeof value.createRequestId === "string" && value.createRequestId.length > 0 && value.createRequestId.length <= 200) values.set("createRequestId", value.createRequestId);
          if (value.variants && typeof value.variants === "object" && Object.values(value.variants).every(v => typeof v === "string")) values.set("variants", value.variants);
          if (Array.isArray(value.omitted) && value.omitted.every(id => typeof id === "string")) values.set("omittedAttachments", new Set(value.omitted));
        }
      }
    } catch { /* Unavailable browser storage leaves session-local presentation working. */ }
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private changed(patch: Partial<Snapshot> = {}) {
    this.snapshot = { ...this.snapshot, ...patch, revision: this.snapshot.revision + 1 };
    const selected = this.snapshot.selected;
    if (selected?.conversationId) this.retained.set(`${selected.worldId}:${selected.conversationId}`, selected);
    this.persist(); for (const listener of this.listeners) listener();
  }
  private persist() {
    const selected = this.snapshot.selected;
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify({ version: 1, open: this.snapshot.open,
      selected: selected ? { ...selected, props: undefined, scope: savedScope(selected) } : null,
      retained: Object.fromEntries([...this.retained].map(([key, surface]) => [key, { ...surface, props: undefined, scope: savedScope(surface) }])),
      conversationIds: Object.fromEntries(this.conversationIds),
      choices: Object.fromEntries([...this.values].map(([key, fields]) => [key, { model: fields.get("languageModel"), variants: fields.get("variants"), createRequestId: fields.get("createRequestId"), omitted: fields.get("omittedAttachments") instanceof Set ? [...fields.get("omittedAttachments") as Set<string>] : undefined }])),
      drafts: Object.fromEntries([...this.values].map(([key, values]) => [key, values.get("draft") ?? ""])) })); } catch { /* Disk-full/private browsing must not drop an in-memory draft. */ }
  }
  setCurrent(surface: ChatSurface | null) { this.current = surface; }
  register(surface: ChatSurface, host: HTMLElement) {
    this.registrations.set(surface.key, { surface, host });
    if (!this.snapshot.selected && this.snapshot.phase === "idle") this.select(surface);
    else this.changed();
    return () => { if (this.registrations.get(surface.key)?.host === host) { this.registrations.delete(surface.key); this.changed(); } };
  }
  refresh(surface: ChatSurface, host: HTMLElement) {
    const previous = this.registrations.get(surface.key)?.surface;
    this.registrations.set(surface.key, { surface, host });
    const selected = this.snapshot.selected;
    // Revisions/decisions for the retained context remain live. A page candidate cannot
    // replace its route, entry, structured subject or the subject prefixed to a send.
    if (selected?.key === surface.key && selected.path === surface.path && chatSubjectKey(selected) === chatSubjectKey(surface) && selected.props !== surface.props) {
      this.changed({ selected: { ...selected, props: surface.props } });
    } else if (!previous || previous.path !== surface.path || chatSubjectKey(previous) !== chatSubjectKey(surface)) this.changed();
  }
  forPage = () => this.current ? [...this.registrations.values()].findLast(row => row.surface.path === this.current!.path)?.surface ?? this.registrations.get(this.current.key)?.surface ?? this.current : null;
  host = () => {
    const selected = this.snapshot.selected, registered = selected ? this.registrations.get(selected.key) : undefined;
    return selected && registered?.surface.path === selected.path && chatSubjectKey(registered.surface) === chatSubjectKey(selected) &&
      chatHostVisible(registered.host) ? registered.host : null;
  };
  open(surface = this.forPage()) {
    if (surface) this.select(surface);
    this.changed({ open: true });
  }
  close() { this.pending = null; this.changed({ open: false, stopCapture: this.snapshot.stopCapture + 1, switching: false }); }
  stopDictation() { this.changed({ stopCapture: this.snapshot.stopCapture + 1 }); }
  reconcileConversations(worldId: string, ids: ReadonlySet<string>, loadedId?: string | null) {
    const before = this.listedConversations.get(worldId);
    this.listedConversations.set(worldId, ids);
    // The first complete snapshot validates cached identities from the previous window. A
    // currently loaded workspace may precede its new summary, so retain that arrival.
    const known = before ?? new Set([...this.conversationIds].filter(([key]) => key.startsWith(worldId + ":")).map(([, id]) => id));
    const removed = new Set([...known].filter(id => !ids.has(id) && (before !== undefined || id !== loadedId)));
    for (const id of removed) { this.retained.delete(`${worldId}:${id}`); this.openings.delete(`${worldId}:conversation:${id}`); }
    for (const [key, id] of this.conversationIds) if (key.startsWith(worldId + ":") && removed.has(id)) {
      this.conversationIds.delete(key); this.values.delete(`${worldId}:conversation:${id}`);
    }
    const selected = this.snapshot.selected;
    if (!selected || selected.worldId !== worldId || !selected.conversationId || !removed.has(selected.conversationId)) return;
    const entry = { kind: "world" as const };
    this.select({ key: chatKey(worldId, entry), worldId, worldName: selected.worldName, label: selected.worldName,
      title: "World Chat", kind: "world", entry, path: `/w/${worldId}/chat`, newThread: true });
  }
  startNew(surface: ChatSurface) {
    if (this.snapshot.phase !== "idle" || this.opening()) { this.pending = { ...surface, newThread: true, conversationId: undefined }; this.changed({ switching: true, stopCapture: this.snapshot.stopCapture + 1 }); return; }
    const key = chatKey(surface.worldId, surface.entry);
    this.conversationIds.delete(key); this.values.delete(key);
    this.pending = null;
    this.changed({ selected: { ...surface, key, newThread: true, conversationId: undefined }, open: true, switching: false });
  }
  select(surface: ChatSurface) {
    if (surface.newThread) { this.startNew(surface); return; }
    const selected = this.snapshot.selected;
    if (selected && (selected.key !== surface.key || chatSubjectKey(selected) !== chatSubjectKey(surface)) &&
      (this.snapshot.phase !== "idle" || selected.worldId === surface.worldId && this.opening())) {
      this.pending = surface; this.changed({ switching: true, stopCapture: this.snapshot.stopCapture + 1 }); return;
    }
    const conversationId = surface.conversationId ?? this.conversationIds.get(surface.key);
    if (conversationId) this.conversationIds.set(surface.key, conversationId);
    this.pending = null; this.changed({ selected: { ...surface, ...(conversationId ? { conversationId } : {}) }, switching: false });
  }
  history(surface: ChatSurface, open = true) {
    const previous = surface.conversationId ? this.retained.get(`${surface.worldId}:${surface.conversationId}`) : undefined;
    this.select(previous ? { ...previous, key: surface.key, conversationId: surface.conversationId, newThread: false } : surface);
    if (open) this.changed({ open: true });
  }
  reportConversation(key: string, conversationId: string | null) {
    const selected = this.snapshot.selected;
    if (selected?.key !== key || !conversationId || selected.conversationId === conversationId) return;
    const previousKey = this.valueKey(key), existing = this.values.get(previousKey);
    this.conversationIds.set(key, conversationId);
    const target = this.valueKey(key);
    if (this.openings.delete(previousKey)) this.openings.add(target);
    if (existing && !this.values.has(target)) this.values.set(target, existing);
    this.values.delete(key);
    this.changed({ selected: { ...selected, conversationId, newThread: false } });
  }
  private valueKey(key: string) { const id = this.conversationIds.get(key); return id ? `${key.split(":")[0]}:conversation:${id}` : key; }
  value<T>(key: string, name: string, initial: T): T { const wanted = this.valueKey(key); return (this.values.get(wanted)?.has(name) ? this.values.get(wanted)!.get(name) : initial) as T; }
  setValue<T>(key: string, name: string, value: T) {
    const wanted = this.valueKey(key);
    if (!this.values.has(wanted)) this.values.set(wanted, new Map()); this.values.get(wanted)!.set(name, value); this.changed();
  }
  phase(phase: Snapshot["phase"]) {
    if (phase === this.snapshot.phase) return;
    this.changed({ phase });
    if (phase === "idle" && this.pending && !this.opening()) this.select(this.pending);
  }
  holdOpening(key: string, held: boolean) {
    const wanted = this.valueKey(key);
    if (this.openings.has(wanted) === held) return;
    if (held) this.openings.add(wanted); else this.openings.delete(wanted);
    this.changed();
    if (!held && this.pending && this.snapshot.phase === "idle") this.select(this.pending);
  }
  opening = () => this.openings.has(this.valueKey(this.snapshot.selected?.key ?? ""));
  trackCreateRequest(key: string, requestId: string) {
    const surface = this.snapshot.selected;
    if (surface?.key !== key) return;
    this.createRequests.set(requestId, { key, surface });
    this.setValue(key, "createRequestId", requestId); this.setValue(key, "creationTrouble", null);
  }
  deliverCreateResult(result: { requestId: string; worldId: string; conversationId?: string; detail?: string }) {
    const request = this.createRequests.get(result.requestId);
    if (!request || request.surface.worldId !== result.worldId) return;
    this.createRequests.delete(result.requestId);
    if (this.value(request.key, "createRequestId", "") !== result.requestId) return;
    if (!result.conversationId) { this.failCreate(request.key, result.detail); return; }
    const previousKey = this.valueKey(request.key), existing = this.values.get(previousKey);
    this.conversationIds.set(request.key, result.conversationId);
    if (this.openings.delete(previousKey)) this.openings.add(this.valueKey(request.key));
    if (existing) this.values.set(this.valueKey(request.key), existing);
    this.values.delete(request.key);
    const surface = { ...request.surface, conversationId: result.conversationId, newThread: false };
    this.retained.set(`${result.worldId}:${result.conversationId}`, surface);
    this.changed(this.snapshot.selected?.key === request.key ? { selected: surface } : {});
  }
  private failCreate(key: string, detail?: string) {
    const opening = this.value<{ files?: readonly { name: string }[]; act?: { kind: string; files?: readonly { name: string }[] }; onAttached?: (refusals: readonly { name: string; reason: string }[]) => void } | null>(key, "opening", null);
    const reason = detail ?? "The connection ended before creation returned. Your draft is retained; send again after reconnecting.";
    const refusals = (opening?.files ?? opening?.act?.files ?? []).map(file => ({ name: file.name, reason }));
    if (opening?.act?.kind === "note") refusals.push({ name: "pasted-note.txt", reason });
    if (opening?.act) this.setValue(key, "worldAttachmentTrouble", refusals);
    opening?.onAttached?.(refusals);
    this.setValue(key, "opening", null); this.setValue(key, "creationTrouble", reason); this.holdOpening(key, false);
  }
  loseCreates() {
    const requests = [...this.createRequests.values()]; this.createRequests.clear();
    for (const request of requests) this.failCreate(request.key);
  }
  queueDictation(key: string, requestId: string, deliver: (text: string) => void) {
    this.dictations.set(requestId, { key, deliver }); this.phase("transcribing");
  }
  deliverDictation(requestId: string, result: { text?: string | null; error?: string | null }) {
    const pending = this.dictations.get(requestId); if (!pending) return;
    this.dictations.delete(requestId); if (result.text) pending.deliver(result.text);
    if (result.error) this.setValue(pending.key, "dictationTrouble", result.error);
    if (!this.dictations.size) this.phase("idle");
  }
  loseDictations() {
    if (!this.dictations.size && this.snapshot.phase === "idle") return;
    for (const pending of this.dictations.values()) this.setValue(pending.key, "dictationTrouble", "The connection ended before dictation returned. Your typed draft is retained; dictate again.");
    this.dictations.clear(); this.changed({ stopCapture: this.snapshot.stopCapture + 1 }); this.phase("idle");
  }
  trackSetupRequest(key: string, requestId: string, operation: string, text?: string) {
    this.setupRequests.set(requestId, { key, operation, text });
    this.setValue(key, "setupLastRequestId", requestId);
    if (operation === "send") this.setValue(key, "setupLastSendId", requestId);
    this.setValue(key, "setupPendingRequest", { requestId, operation }); this.holdOpening(key, true);
  }
  loseSetupRequests() {
    for (const [requestId, request] of this.setupRequests) {
      if (this.value<{ requestId: string } | null>(request.key, "setupPendingRequest", null)?.requestId !== requestId) continue;
      this.setValue(request.key, "setupPendingRequest", null);
      this.setValue(request.key, "setupFailure", "The connection ended before the answer arrived. Your draft is retained. Check the conversation before sending again.");
      this.holdOpening(request.key, false);
    }
    // Retain correlation for a late answer; a newer request's IDs prevent it from clearing
    // a different send. Disconnect never replays an uncertain operation automatically.
  }
  deliverSetupResult(result: { requestId?: string; detail?: string }) {
    if (!result.requestId) return;
    const request = this.setupRequests.get(result.requestId); if (!request) return;
    this.setupRequests.delete(result.requestId);
    if (this.value(request.key, request.operation === "send" ? "setupLastSendId" : "setupLastRequestId", "") !== result.requestId) return;
    if (!result.detail && request.operation === "send" && this.value(request.key, "draft", "") === request.text) this.setValue(request.key, "draft", "");
    this.setValue(request.key, "setupFailure", result.detail ?? null);
    if (this.value<{ requestId: string } | null>(request.key, "setupPendingRequest", null)?.requestId === result.requestId) {
      this.setValue(request.key, "setupPendingRequest", null); this.holdOpening(request.key, false);
    }
  }
}

/** Window-local presentation cache for drafts and selected subjects; no credentials or media bytes. */
export function createGlobalChatController(): GlobalChatController {
  let storage: Storage | undefined;
  try { storage = typeof window === "undefined" ? undefined : window.sessionStorage; } catch { /* Optional tab storage. */ }
  return new GlobalChatController(storage);
}
