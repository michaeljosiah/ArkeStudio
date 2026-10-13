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
  it("an explicit new conversation leaves the old thread's draft recoverable", () => {
    const owner = new GlobalChatController(); owner.open(production); owner.reportConversation(production.key, CHAT_ID);
    owner.setValue(production.key, "draft", "Keep this in the old conversation"); owner.startNew(production);
    assert.equal(owner.getSnapshot().selected?.conversationId, undefined); assert.equal(owner.getSnapshot().selected?.newThread, true);
    assert.equal(owner.value(production.key, "draft", ""), "");
    owner.open({ ...production, key: chatKey(production.worldId, production.entry, CHAT_ID), conversationId: CHAT_ID });
    assert.equal(owner.value(owner.getSnapshot().selected!.key, "draft", ""), "Keep this in the old conversation");
  });
  it("close and reopen keep the thread; opening from another page explicitly follows that page", () => {
    const owner = new GlobalChatController(); owner.setCurrent(worldChat); owner.open(); owner.reportConversation(worldChat.key, CHAT_ID);
    owner.close(); owner.open(); assert.equal(owner.getSnapshot().selected?.conversationId, CHAT_ID);
    owner.close(); owner.setCurrent(cut); owner.open(); assert.equal(owner.getSnapshot().selected?.entry.kind, "cut");
  });
  it("a workspace registration supplies the exact selection without rebinding an open chat", () => {
    const owner = new GlobalChatController(); owner.setCurrent(cut); owner.open(production);
    const selection: ChatSurface = { ...cut, props: { ...cut.props!, subject: { kind: "timeline-clip", clipId: "clip-one" as never } } };
    const stop = owner.register(selection, {} as HTMLElement);
    assert.equal(owner.forPage()?.props?.subject?.kind, "timeline-clip");
    assert.equal(owner.getSnapshot().selected?.key, production.key);
    owner.open(); assert.equal(owner.getSnapshot().selected?.props?.subject?.kind, "timeline-clip"); stop();
    assert.equal(owner.getSnapshot().selected?.props?.subject?.kind, "timeline-clip", "leaving the page freezes its selected context");
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
    const restored = new GlobalChatController(storage);
    assert.equal(restored.getSnapshot().open, true); assert.equal(restored.getSnapshot().selected?.conversationId, CHAT_ID);
    assert.equal(restored.value(production.key, "draft", ""), "Reload me");
    assert.equal(restored.value(production.key, "languageModel", ""), "openai/gpt-5.4");
    assert.deepEqual(restored.value(production.key, "variants", {}), { "openai/gpt-5.4": "high" });
    const broken = new GlobalChatController({ getItem: () => "invalid", setItem: () => { throw Error("quota"); } });
    broken.open(production); broken.setValue(production.key, "draft", "Still editable"); assert.equal(broken.value(production.key, "draft", ""), "Still editable");
  });
});
