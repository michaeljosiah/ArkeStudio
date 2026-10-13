import { ConversationIdSchema, orderedShots, WorldChatContextSchema, type ClientState, type WorldChatContext } from "@arke-studio/contracts";
import type { ProductionConversationProps } from "../components/conversation.js";

export type ChatSurface = {
  key: string; worldId: string; worldName: string; title: string; label: string;
  kind: "world" | "production" | "setup"; entry: WorldChatContext; path: string;
  conversationId?: string; newThread?: boolean; props?: ProductionConversationProps;
};
export const chatKey = (worldId: string, entry: WorldChatContext, conversationId?: string) =>
  `${worldId}:${JSON.stringify(entry)}${conversationId ? ":" + conversationId : ""}`;
export const chatTitle = (entry: WorldChatContext) => entry.kind === "world" ? "World Chat" : entry.kind === "bench" ? "Bench Chat"
  : entry.kind === "shot" ? "Shot Chat" : entry.kind === "stage" ? "Stage Chat" : entry.kind === "takes" ? "Takes Chat" : "Builder Chat";

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
  if (row?.entryContext) { entry = row.entryContext; title = chatTitle(entry); label = `${world.meta.name} / ${row.title}`; }
  const kind = entry.kind === "world" ? "world" : entry.kind === "production-setup" ? "setup" : "production";
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

/** Presentation only. Coordinator identities, workspace state and decision authorities stay in the store. */
export class GlobalChatController {
  private listeners = new Set<() => void>();
  private snapshot: Snapshot = { open: false, selected: null, revision: 0, stopCapture: 0, phase: "idle", switching: false };
  private registrations = new Map<string, { surface: ChatSurface; host: HTMLElement }>();
  private values = new Map<string, Map<string, unknown>>();
  private conversationIds = new Map<string, string>();
  private listedConversations = new Map<string, ReadonlySet<string>>();
  private pending: ChatSurface | null = null;
  private dictations = new Map<string, { key: string; deliver(text: string): void }>();
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
          entry, kind: entry.kind === "world" ? "world" : entry.kind === "production-setup" ? "setup" : "production",
          ...(conversationId.success ? { conversationId: conversationId.data } : {}), newThread: saved.selected.newThread === true } };
        if (conversationId.success) this.conversationIds.set(saved.selected.key, conversationId.data);
        for (const [key, id] of Object.entries(saved.conversationIds ?? {})) if (typeof id === "string" && ConversationIdSchema.safeParse(id).success) this.conversationIds.set(key, id);
        for (const [key, draft] of Object.entries(saved.drafts ?? {})) if (typeof draft === "string") this.values.set(key, new Map([["draft", draft]]));
        for (const [key, fields] of Object.entries(saved.choices ?? {})) {
          if (!fields || typeof fields !== "object") continue;
          const value = fields as { model?: unknown; variants?: unknown; omitted?: unknown };
          if (!this.values.has(key)) this.values.set(key, new Map());
          const values = this.values.get(key)!;
          if (typeof value.model === "string") values.set("languageModel", value.model);
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
    this.persist(); for (const listener of this.listeners) listener();
  }
  private persist() {
    const selected = this.snapshot.selected;
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify({ version: 1, open: this.snapshot.open,
      selected: selected ? { ...selected, props: undefined } : null,
      conversationIds: Object.fromEntries(this.conversationIds),
      choices: Object.fromEntries([...this.values].map(([key, fields]) => [key, { model: fields.get("languageModel"), variants: fields.get("variants"), omitted: fields.get("omittedAttachments") instanceof Set ? [...fields.get("omittedAttachments") as Set<string>] : undefined }])),
      drafts: Object.fromEntries([...this.values].map(([key, values]) => [key, values.get("draft") ?? ""])) })); } catch { /* Disk-full/private browsing must not drop an in-memory draft. */ }
  }
  setCurrent(surface: ChatSurface | null) { this.current = surface; }
  register(surface: ChatSurface, host: HTMLElement) {
    this.registrations.set(surface.key, { surface, host });
    if (this.snapshot.selected?.key === surface.key) this.changed({ selected: { ...surface, conversationId: this.snapshot.selected.conversationId, newThread: this.snapshot.selected.newThread } });
    else if (!this.snapshot.selected && this.snapshot.phase === "idle") this.select(surface);
    return () => { if (this.registrations.get(surface.key)?.host === host) { this.registrations.delete(surface.key); this.changed(); } };
  }
  refresh(surface: ChatSurface, host: HTMLElement) {
    this.registrations.set(surface.key, { surface, host });
    if (this.snapshot.selected?.key === surface.key) this.changed({ selected: { ...surface, conversationId: this.snapshot.selected.conversationId, newThread: this.snapshot.selected.newThread } });
  }
  forPage = () => this.current ? [...this.registrations.values()].findLast(row => row.surface.path === this.current!.path)?.surface ?? this.registrations.get(this.current.key)?.surface ?? this.current : null;
  host = () => this.snapshot.selected ? this.registrations.get(this.snapshot.selected.key)?.host ?? null : null;
  open(surface = this.forPage()) {
    if (surface) this.select(surface);
    this.changed({ open: true });
  }
  close() { this.pending = null; this.changed({ open: false, stopCapture: this.snapshot.stopCapture + 1, switching: false }); }
  stopDictation() { this.changed({ stopCapture: this.snapshot.stopCapture + 1 }); }
  reconcileConversations(worldId: string, ids: ReadonlySet<string>) {
    const before = this.listedConversations.get(worldId);
    this.listedConversations.set(worldId, ids);
    // A workspace can arrive before its summary. Only a removed known row proves deletion.
    if (!before) return;
    const removed = new Set([...before].filter(id => !ids.has(id)));
    for (const [key, id] of this.conversationIds) if (key.startsWith(worldId + ":") && removed.has(id)) {
      this.conversationIds.delete(key); this.values.delete(`${worldId}:conversation:${id}`);
    }
    const selected = this.snapshot.selected;
    if (!selected || selected.worldId !== worldId || !selected.conversationId || !removed.has(selected.conversationId)) return;
    const entry = { kind: "world" as const };
    this.select({ key: chatKey(worldId, entry), worldId, worldName: selected.worldName, label: selected.worldName,
      title: "World Chat", kind: "world", entry, path: selected.path, newThread: true });
  }
  startNew(surface: ChatSurface) {
    if (this.snapshot.phase !== "idle") { this.pending = { ...surface, newThread: true, conversationId: undefined }; this.changed({ switching: true, stopCapture: this.snapshot.stopCapture + 1 }); return; }
    const key = chatKey(surface.worldId, surface.entry);
    this.conversationIds.delete(key); this.values.delete(key);
    this.pending = null;
    this.changed({ selected: { ...surface, key, newThread: true, conversationId: undefined }, open: true, switching: false });
  }
  select(surface: ChatSurface) {
    if (surface.newThread) { this.startNew(surface); return; }
    if (this.snapshot.selected?.key !== surface.key && this.snapshot.phase !== "idle") {
      this.pending = surface; this.changed({ switching: true, stopCapture: this.snapshot.stopCapture + 1 }); return;
    }
    const conversationId = surface.conversationId ?? this.conversationIds.get(surface.key);
    if (conversationId) this.conversationIds.set(surface.key, conversationId);
    this.pending = null; this.changed({ selected: { ...surface, ...(conversationId ? { conversationId } : {}) }, switching: false });
  }
  reportConversation(key: string, conversationId: string | null) {
    const selected = this.snapshot.selected;
    if (selected?.key !== key || !conversationId || selected.conversationId === conversationId) return;
    const existing = this.values.get(this.valueKey(key));
    this.conversationIds.set(key, conversationId);
    const target = this.valueKey(key);
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
    if (phase === "idle" && this.pending) this.select(this.pending);
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
}

/** Non-secret window-local presentation cache; no credentials, world entities or file bytes. */
export function createGlobalChatController(): GlobalChatController {
  let storage: Storage | undefined;
  try { storage = typeof window === "undefined" ? undefined : window.sessionStorage; } catch { /* Optional tab storage. */ }
  return new GlobalChatController(storage);
}
