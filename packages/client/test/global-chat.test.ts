import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chatKey, chatSurfaceForPage, GlobalChatController, type ChatSurface } from "../src/lib/global-chat.js";
import { developLayoutFixture, CHAT_ID } from "./develop-layout-fixture.js";

const state = developLayoutFixture(), world = state.world!, root = `/w/${world.meta.worldId}`;
const production = chatSurfaceForPage(state, `${root}/p/saltlight/story`)!;
const cut = chatSurfaceForPage(state, `${root}/p/saltlight/cut`)!;
const worldChat = chatSurfaceForPage(state, root)!;

describe("global Chat keeps presentation separate from conversation authority (224)", () => {
  it("resolves World, Builder, scene, shot, Stage, takes, Generate, Cut, Bench and setup contexts", () => {
    const scene = world.productions.find(p => p.meta.id === "saltlight")!.scenes[0]!;
    assert.equal(worldChat.entry.kind, "world"); assert.equal(production.entry.kind, "production");
    assert.equal(chatSurfaceForPage(state, `${root}/p/saltlight/scenes/${scene.id}`)?.entry.kind, "scene");
    const shot = "shots" in scene ? scene.shots[0]! : null;
    assert.ok(shot);
    for (const view of ["shot", "stage", "takes"]) assert.equal(chatSurfaceForPage(state, `${root}/p/saltlight/scenes/${scene.id}?shot=${shot.id}&view=${view}`)?.entry.kind, view);
    assert.equal(chatSurfaceForPage(state, `${root}/p/saltlight/generate`)?.entry.kind, "generate");
    const generated = chatSurfaceForPage(state, `${root}/p/saltlight/generate?shot=${shot.id}`)!;
    assert.deepEqual(generated.entry, { kind: "generate", productionId: "saltlight", sceneId: scene.id, shotId: shot.id });
    assert.equal(cut.entry.kind, "cut");
    assert.equal(chatSurfaceForPage(state, `${root}/artifacts/bench/session-one`)?.entry.kind, "bench");
    assert.equal(chatSurfaceForPage(state, `${root}/productions/setup/${CHAT_ID}`)?.kind, "setup");
    assert.equal(chatSurfaceForPage(state, "/worlds"), null);
    assert.equal(chatSurfaceForPage(state, "/w/another-world"), null);
    assert.equal(chatSurfaceForPage(state, "/w/%bad"), null);
    const historical = chatSurfaceForPage(state, `${root}/chat/${CHAT_ID}`)!;
    assert.equal(historical.title, "Builder Chat"); assert.equal(historical.entry.kind, "production");
  });
  it("navigation retains the subject and draft until an explicit switch", () => {
    const owner = new GlobalChatController(); owner.setCurrent(production); owner.open();
    owner.setValue(production.key, "draft", "Keep the bells quiet."); owner.reportConversation(production.key, CHAT_ID);
    owner.setCurrent(cut);
    assert.equal(owner.getSnapshot().selected?.entry.kind, "production");
    assert.equal(owner.getSnapshot().selected?.conversationId, CHAT_ID);
    owner.select(cut); owner.setValue(cut.key, "draft", "A slower ending.");
    owner.select(production);
    assert.equal(owner.value(production.key, "draft", ""), "Keep the bells quiet.");
    assert.equal(owner.getSnapshot().selected?.conversationId, CHAT_ID);
    assert.equal(owner.value(cut.key, "draft", ""), "A slower ending.");
  });
  it("two presentations of the same durable thread share its draft", () => {
    const owner = new GlobalChatController(); owner.open(production); owner.reportConversation(production.key, CHAT_ID);
    owner.setValue(production.key, "draft", "A retained draft");
    const history = { ...production, key: chatKey(production.worldId, production.entry, CHAT_ID), conversationId: CHAT_ID };
    owner.open(history);
    assert.equal(owner.value(history.key, "draft", ""), "A retained draft");
  });
  it("contextual sheet conversations keep World Chat and its model rules after history and refresh", () => {
    const contextual = { ...state, world: { ...world, conversations: [{ ...world.conversations[0]!, id: CHAT_ID, entryContext: { kind: "sheet" as const, sheetKind: "character" as const, sheetId: "maren-kest" } }] } };
    const surface = chatSurfaceForPage(contextual, `${root}/chat/${CHAT_ID}`)!;
    assert.equal(surface.kind, "world"); assert.equal(surface.title, "World Chat"); assert.equal(surface.props, undefined);
    let saved = ""; const owner = new GlobalChatController({ getItem: () => saved, setItem: (_key, text) => { saved = text; } }); owner.history(surface);
    const restored = new GlobalChatController({ getItem: () => saved, setItem() {} });
    assert.equal(restored.getSnapshot().selected?.kind, "world"); assert.equal(restored.getSnapshot().selected?.scopeMissing, false);
  });
  it("closed workspace registration preserves a restored selected conversation", () => {
    const owner = new GlobalChatController(); owner.open(production); owner.reportConversation(production.key, CHAT_ID); owner.close();
    owner.setCurrent(cut); owner.register(cut, {} as HTMLElement);
    assert.equal(owner.getSnapshot().selected?.conversationId, CHAT_ID); assert.equal(owner.getSnapshot().selected?.key, production.key);
    owner.open(); assert.equal(owner.getSnapshot().selected?.key, cut.key, "opening from a page explicitly chooses its context");
  });
  it("deletion forgets all aliases and returns to a clean World conversation", () => {
    const owner = new GlobalChatController(); owner.open(production); owner.reportConversation(production.key, CHAT_ID); owner.setValue(production.key, "draft", "Deleted words");
    const history = { ...production, key: chatKey(production.worldId, production.entry, CHAT_ID), conversationId: CHAT_ID };
    owner.open(history); owner.reconcileConversations(production.worldId, new Set([CHAT_ID])); owner.reconcileConversations(production.worldId, new Set());
    assert.equal(owner.getSnapshot().selected?.entry.kind, "world"); assert.equal(owner.getSnapshot().selected?.conversationId, undefined);
    assert.equal(owner.value(history.key, "draft", ""), ""); assert.equal(owner.value(production.key, "draft", ""), "");
  });
  it("the initial snapshot drops a deleted restored thread but permits a loaded workspace awaiting its summary", () => {
    let saved = ""; const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } };
    const original = new GlobalChatController(storage); original.open(production); original.reportConversation(production.key, CHAT_ID);
    const restored = new GlobalChatController(storage), arriving = new GlobalChatController(storage);
    restored.reconcileConversations(production.worldId, new Set());
    assert.equal(restored.getSnapshot().selected?.entry.kind, "world"); assert.equal(restored.getSnapshot().selected?.conversationId, undefined);
    arriving.reconcileConversations(production.worldId, new Set(), CHAT_ID);
    assert.equal(arriving.getSnapshot().selected?.conversationId, CHAT_ID);
  });
  it("a deleted direct route cannot recreate a missing conversation", () => {
    const missing = { ...state, world: { ...world, conversations: [] } };
    const surface = chatSurfaceForPage(missing, `${root}/chat/${CHAT_ID}`)!;
    assert.equal(surface.conversationId, undefined); assert.equal(surface.path, `${root}/chat`);
    const owner = new GlobalChatController(); owner.open({ ...production, path: `${root}/chat/${CHAT_ID}` });
    owner.reportConversation(production.key, CHAT_ID); owner.reconcileConversations(production.worldId, new Set());
    assert.equal(owner.getSnapshot().selected?.path, `${root}/chat`);
    owner.setCurrent(surface); owner.open(); assert.equal(owner.getSnapshot().selected?.conversationId, undefined);
  });
  it("an explicit new conversation leaves the old thread's draft recoverable", () => {
    const owner = new GlobalChatController(); owner.open(production); owner.reportConversation(production.key, CHAT_ID);
    owner.setValue(production.key, "draft", "Keep this in the old conversation"); owner.startNew(production);
    assert.equal(owner.getSnapshot().selected?.conversationId, undefined); assert.equal(owner.getSnapshot().selected?.newThread, true);
    assert.equal(owner.value(production.key, "draft", ""), "");
    owner.open({ ...production, key: chatKey(production.worldId, production.entry, CHAT_ID), conversationId: CHAT_ID });
    assert.equal(owner.value(owner.getSnapshot().selected!.key, "draft", ""), "Keep this in the old conversation");
    owner.startNew(owner.getSnapshot().selected!);
    assert.equal(owner.getSnapshot().selected?.key, production.key, "a new thread opened from history has a restorable unbound key");
  });
  it("close and reopen keep the thread; opening from another page explicitly follows that page", () => {
    const owner = new GlobalChatController(); owner.setCurrent(worldChat); owner.open(); owner.reportConversation(worldChat.key, CHAT_ID);
    owner.close(); owner.open(); assert.equal(owner.getSnapshot().selected?.conversationId, CHAT_ID);
    owner.close(); owner.setCurrent(cut); owner.open(); assert.equal(owner.getSnapshot().selected?.entry.kind, "cut");
  });
  it("a workspace registration supplies the exact selection without rebinding an open chat", () => {
    const owner = new GlobalChatController(); owner.setCurrent(cut); owner.open(production);
    const selection: ChatSurface = { ...cut, props: { ...cut.props!, subject: { kind: "timeline-clip", clipId: "cl_one" as never } } };
    const stop = owner.register(selection, {} as HTMLElement);
    assert.equal(owner.forPage()?.props?.subject?.kind, "timeline-clip");
    assert.equal(owner.getSnapshot().selected?.key, production.key);
    owner.open(); assert.equal(owner.getSnapshot().selected?.props?.subject?.kind, "timeline-clip"); stop();
    assert.equal(owner.getSnapshot().selected?.props?.subject?.kind, "timeline-clip", "leaving the page freezes its selected context");
  });
  it("same-key page candidates cannot replace the retained subject through registration or refresh", () => {
    const owner = new GlobalChatController(); owner.setCurrent(production); owner.open(production);
    owner.setValue(production.key, "draft", "Keep these words");
    const chapter: ChatSurface = { ...production, path: production.path + "/chapter", props: { ...production.props!, subject: { kind: "timeline-clip", clipId: "cl_one" as never } } };
    owner.setCurrent(chapter); const host = {} as HTMLElement; owner.register(chapter, host); owner.refresh(chapter, host);
    assert.equal(owner.getSnapshot().selected?.props?.subject, production.props?.subject);
    assert.equal(owner.getSnapshot().selected?.path, production.path);
    assert.equal(owner.value(production.key, "draft", ""), "Keep these words");
    assert.equal(owner.forPage()?.props?.subject?.kind, "timeline-clip");
    owner.open(); assert.equal(owner.getSnapshot().selected?.props?.subject?.kind, "timeline-clip");
  });
  it("retains a validated structured subject and its send prefix after reload", () => {
    let saved = ""; const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } };
    const prefix = "About clip one: " + "selected words ".repeat(50);
    const surface: ChatSurface = { ...cut, props: { ...cut.props!, subject: { kind: "timeline-clip", clipId: "cl_one" as never }, dock: { title: "Clip", subject: "Clip one", subjectPrefix: prefix, about: "clip one" } } };
    const first = new GlobalChatController(storage); first.open(surface); first.setValue(surface.key, "draft", "These exact words");
    const restored = new GlobalChatController(storage);
    assert.deepEqual(restored.getSnapshot().selected?.props?.subject, surface.props?.subject);
    assert.equal(restored.getSnapshot().selected?.props?.dock?.subjectPrefix, prefix);
    assert.equal(restored.value(surface.key, "draft", ""), "These exact words");
    restored.register(cut, {} as HTMLElement); restored.refresh(cut, {} as HTMLElement);
    assert.deepEqual(restored.getSnapshot().selected?.props?.subject, surface.props?.subject, "a generic page cannot overwrite the restored scope");
  });
  it("pending conversation creation holds a switch until the original opening act is delivered", () => {
    const owner = new GlobalChatController(); owner.open(production); owner.holdOpening(production.key, true);
    owner.setValue(production.key, "opening", { text: "The submitted first line" }); owner.select(cut);
    assert.equal(owner.getSnapshot().selected?.key, production.key); assert.equal(owner.getSnapshot().switching, true);
    owner.phase("idle"); assert.equal(owner.getSnapshot().selected?.key, production.key);
    owner.holdOpening(production.key, false); assert.equal(owner.getSnapshot().selected?.key, cut.key);
    owner.select(production); assert.deepEqual(owner.value(production.key, "opening", null), { text: "The submitted first line" });
  });
  it("history restores each thread's structured scope and prefix in memory and after reload", () => {
    let saved = ""; const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } };
    const scoped: ChatSurface = { ...cut, props: { ...cut.props!, subject: { kind: "timeline-clip", clipId: "cl_one" as never }, dock: { title: "Clip", subject: "Clip", subjectPrefix: "About this clip:" } } };
    const owner = new GlobalChatController(storage); owner.open(scoped); owner.reportConversation(cut.key, CHAT_ID); owner.setValue(cut.key, "draft", "Clip-specific words");
    owner.open(worldChat);
    const history = { ...cut, key: chatKey(cut.worldId, cut.entry, CHAT_ID), conversationId: CHAT_ID };
    owner.history(history); assert.deepEqual(owner.getSnapshot().selected?.props?.subject, scoped.props?.subject);
    assert.equal(owner.getSnapshot().selected?.props?.dock?.subjectPrefix, "About this clip:"); assert.equal(owner.value(history.key, "draft", ""), "Clip-specific words");
    owner.open(worldChat); const restored = new GlobalChatController(storage); restored.history(history);
    assert.deepEqual(restored.getSnapshot().selected?.props?.subject, scoped.props?.subject); assert.equal(restored.value(history.key, "draft", ""), "Clip-specific words");
  });
  it("setup replies remain correlated while a switch is pending and can clear the origin draft across worlds", () => {
    const owner = new GlobalChatController(); owner.open(production); owner.setValue(production.key, "draft", "Sent setup words");
    owner.trackSetupRequest(production.key, "request", "send", "Sent setup words"); owner.select(cut);
    assert.equal(owner.getSnapshot().selected?.key, production.key);
    owner.deliverSetupResult({ requestId: "request" }); assert.equal(owner.value(production.key, "draft", ""), ""); assert.equal(owner.getSnapshot().selected?.key, cut.key);
    owner.open(production); owner.setValue(production.key, "draft", "Another setup line"); owner.trackSetupRequest(production.key, "other", "send", "Another setup line");
    owner.select({ ...worldChat, worldId: "another-world", key: "another-world:world" }); owner.deliverSetupResult({ requestId: "other" });
    assert.equal(owner.value(production.key, "draft", ""), "");
  });
  it("creation binds its origin while another world owns the workspace, and failure frees held switches", () => {
    const owner = new GlobalChatController(); owner.startNew(production);
    owner.setValue(production.key, "draft", "The first line"); owner.setValue(production.key, "opening", { text: "The first line", was: null });
    owner.holdOpening(production.key, true); owner.trackCreateRequest(production.key, "create-origin");
    const other = { ...worldChat, worldId: "another-world", key: "another-world:world" }; owner.select(other);
    owner.deliverCreateResult({ worldId: "another-world", requestId: "create-origin", conversationId: CHAT_ID });
    owner.deliverCreateResult({ worldId: production.worldId, requestId: "create-origin", conversationId: CHAT_ID });
    assert.equal(owner.getSnapshot().selected?.key, other.key);
    owner.open(production); assert.equal(owner.getSnapshot().selected?.conversationId, CHAT_ID);
    assert.deepEqual(owner.value(production.key, "opening", null), { text: "The first line", was: null });
    owner.setValue(production.key, "opening", null); owner.holdOpening(production.key, false);
    const history = { ...production, key: chatKey(production.worldId, production.entry, CHAT_ID), conversationId: CHAT_ID };
    owner.history(history); owner.holdOpening(production.key, true); owner.holdOpening(history.key, false); owner.select(cut);
    assert.equal(owner.getSnapshot().selected?.key, cut.key);
    owner.open(production); owner.select(cut); assert.equal(owner.getSnapshot().selected?.key, cut.key, "the original alias has no stranded hold");
    owner.startNew(production); owner.setValue(production.key, "draft", "Retry these words");
    owner.setValue(production.key, "opening", { text: "Retry these words", was: null }); owner.holdOpening(production.key, true);
    owner.trackCreateRequest(production.key, "lost-create"); owner.select(cut); owner.loseCreates();
    assert.equal(owner.getSnapshot().selected?.key, cut.key); assert.equal(owner.value(production.key, "draft", ""), "Retry these words");
    assert.equal(owner.value(production.key, "opening", "held"), null);
    owner.deliverCreateResult({ worldId: production.worldId, requestId: "lost-create", conversationId: CHAT_ID });
    owner.open(production); assert.equal(owner.getSnapshot().selected?.conversationId, undefined);
  });
  it("a lost transcription releases queued switching and cannot deliver a stale result after reconnect", () => {
    const owner = new GlobalChatController(); owner.open(production); owner.setValue(production.key, "draft", "Typed words");
    owner.queueDictation(production.key, "lost", text => owner.setValue(production.key, "draft", text)); owner.select(cut); owner.loseDictations();
    assert.equal(owner.getSnapshot().selected?.key, cut.key); assert.equal(owner.getSnapshot().phase, "idle");
    owner.deliverDictation("lost", { text: "Late result" }); assert.equal(owner.value(production.key, "draft", ""), "Typed words");
    assert.match(owner.value(production.key, "dictationTrouble", ""), /connection ended/);
  });
  it("an unmounted setup cannot strand a switch after disconnect, and its late answer stays correlated", () => {
    const setup = chatSurfaceForPage(state, `${root}/productions/setup/${CHAT_ID}`)!, owner = new GlobalChatController();
    owner.open(setup); owner.setValue(setup.key, "draft", "Uncertain setup line");
    owner.trackSetupRequest(setup.key, "uncertain", "send", "Uncertain setup line");
    owner.select({ ...worldChat, worldId: "another-world", key: "another-world:world" }); owner.loseSetupRequests();
    assert.equal(owner.value(setup.key, "setupPendingRequest", "held"), null);
    assert.equal(owner.value(setup.key, "draft", ""), "Uncertain setup line");
    owner.open(setup); owner.select(worldChat); assert.equal(owner.getSnapshot().selected?.key, worldChat.key);
    owner.deliverSetupResult({ requestId: "uncertain" }); assert.equal(owner.value(setup.key, "draft", ""), "");
  });
  it("an uncertain create keeps its retry identity across refresh without replaying the act", () => {
    let saved = ""; const storage = { getItem: () => saved, setItem: (_key: string, text: string) => { saved = text; } };
    const owner = new GlobalChatController(storage); owner.startNew(production); owner.setValue(production.key, "draft", "Retry the first line");
    owner.trackCreateRequest(production.key, "same-create-request"); owner.loseCreates();
    const restored = new GlobalChatController(storage);
    assert.equal(restored.value(production.key, "createRequestId", null), "same-create-request");
    assert.equal(restored.value(production.key, "draft", ""), "Retry the first line"); assert.equal(restored.opening(), false);
  });
  it("an old saved draft with unknown scope waits for explicit page adoption", () => {
    const saved = JSON.stringify({ version: 1, open: true, selected: { ...cut, props: undefined }, drafts: { [cut.key]: "Words from before the upgrade" } });
    const owner = new GlobalChatController({ getItem: () => saved, setItem() {} });
    assert.equal(owner.getSnapshot().selected?.scopeMissing, true); assert.equal(owner.value(cut.key, "draft", ""), "Words from before the upgrade");
    owner.setCurrent(cut); owner.register(cut, {} as HTMLElement); owner.refresh(cut, {} as HTMLElement);
    assert.equal(owner.getSnapshot().selected?.scopeMissing, true);
    owner.open(); assert.equal(owner.getSnapshot().selected?.scopeMissing, undefined); assert.equal(owner.value(cut.key, "draft", ""), "Words from before the upgrade");
  });
  it("a same-key page with another subject has no home for the retained composer", () => {
    const owner = new GlobalChatController(); owner.open(production);
    const chapter: ChatSurface = { ...production, path: production.path + "/chapter", props: { ...production.props!, subject: { kind: "timeline-clip", clipId: "cl_one" as never } } };
    owner.register(chapter, {} as HTMLElement); assert.equal(owner.host(), null);
    owner.open(chapter); assert.ok(owner.host());
  });
  it("finishes dictation into the original draft before switching and never sends", () => {
    const owner = new GlobalChatController(); owner.open(production); owner.setValue(production.key, "draft", "Typed words");
    owner.phase("listening"); owner.select(cut);
    assert.equal(owner.getSnapshot().selected?.key, production.key);
    assert.equal(owner.getSnapshot().switching, true); assert.equal(owner.getSnapshot().stopCapture, 1);
    owner.queueDictation(production.key, "dict-one", text => owner.setValue(production.key, "draft", owner.value(production.key, "draft", "") + " " + text));
    owner.deliverDictation("dict-one", { text: "dictated words" });
    assert.equal(owner.value(production.key, "draft", ""), "Typed words dictated words");
    assert.equal(owner.value(cut.key, "draft", ""), ""); assert.equal(owner.getSnapshot().selected?.key, cut.key);
    owner.deliverDictation("dict-one", { text: "duplicate" }); assert.equal(owner.value(production.key, "draft", ""), "Typed words dictated words");
  });
  it("a world switch cannot deliver transcription into the new world's draft", () => {
    const owner = new GlobalChatController(); owner.open(production);
    owner.queueDictation(production.key, "dict-old", text => owner.setValue(production.key, "draft", text));
    const other = { ...production, worldId: "different-world", key: chatKey("different-world", production.entry) };
    owner.setCurrent(other); owner.deliverDictation("dict-old", { text: "old-world words" }); owner.open();
    assert.equal(owner.value(other.key, "draft", ""), ""); assert.equal(owner.value(production.key, "draft", ""), "old-world words");
  });
  it("restores the selected thread and draft after refresh, with storage failure remaining usable", () => {
    let value = ""; const storage = { getItem: () => value, setItem: (_key: string, next: string) => { value = next; } };
    const owner = new GlobalChatController(storage); owner.open(production); owner.reportConversation(production.key, CHAT_ID); owner.setValue(production.key, "draft", "Reload me");
    owner.setValue(production.key, "languageModel", "openai/gpt-5.4"); owner.setValue(production.key, "variants", { "openai/gpt-5.4": "high" });
    owner.setValue(production.key, "omittedAttachments", new Set(["wca_1"]));
    const restored = new GlobalChatController(storage);
    assert.equal(restored.getSnapshot().open, true); assert.equal(restored.getSnapshot().selected?.conversationId, CHAT_ID);
    assert.equal(restored.value(production.key, "draft", ""), "Reload me");
    assert.equal(restored.value(production.key, "languageModel", ""), "openai/gpt-5.4");
    assert.deepEqual(restored.value(production.key, "variants", {}), { "openai/gpt-5.4": "high" });
    assert.deepEqual([...restored.value<ReadonlySet<string>>(production.key, "omittedAttachments", new Set())], ["wca_1"]);
    const broken = new GlobalChatController({ getItem: () => "invalid", setItem: () => { throw Error("quota"); } });
    broken.open(production); broken.setValue(production.key, "draft", "Still editable"); assert.equal(broken.value(production.key, "draft", ""), "Still editable");
  });
});
