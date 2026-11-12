import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import type { ClientMessage } from "@arke-studio/contracts";
import { useTalkItThrough } from "../src/lib/talk-it-through.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { GlobalChatContext } from "../src/components/global-chat-context.js";
import { GlobalChatController } from "../src/lib/global-chat.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { developLayoutFixture } from "./develop-layout-fixture.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
const state = developLayoutFixture(), worldId = state.world!.meta.worldId, source = `/w/${worldId}/bible`;
const ID = "cv_01J8F0000000000000000000C9", context = { kind: "sheet" as const, sheetKind: "character" as const, sheetId: "maren-kest" };
let root: Root | null = null;
afterEach(async () => { await act(async () => root?.unmount()); root = null; __setBridgeForTest(null); dom.document.body.innerHTML = ""; });
async function mount() {
  const sent: ClientMessage[] = [], owner = new GlobalChatController(), container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container); root = createRoot(container);
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send: json => { sent.push(JSON.parse(json)); } } satisfies ArkeBridge);
  function Entry() {
    const { talk, starting } = useTalkItThrough(worldId), location = useLocation(), navigate = useNavigate();
    return <><p data-path>{location.pathname}</p><button disabled={starting} onClick={() => talk("Maren", context)}>Talk</button><button onClick={() => navigate(`/w/${worldId}/timeline`)}>Leave</button></>;
  }
  await act(async () => { __setStateForTest(state, { connection: "open" }); root!.render(<GlobalChatContext.Provider value={owner}><MemoryRouter initialEntries={[source]}><Entry /></MemoryRouter></GlobalChatContext.Provider>); });
  const click = async (label: string) => { await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === label)!.click()); };
  const request = () => sent.find((message): message is Extract<ClientMessage, { kind: "world-chat-create" }> => message.kind === "world-chat-create")!.requestId;
  const reply = async (requestId = request()) => { await act(async () => __applyEventForTest({ type: "world-chat.create-result", at: "2026-10-13T20:00:00.000Z", worldId, requestId, conversationId: ID })); };
  const publish = async () => { const next = structuredClone(state); next.world!.conversations.push({ ...next.world!.conversations[0]!, id: ID, entryContext: context }); await act(async () => __setStateForTest(next, { connection: "open" })); };
  return { owner, click, reply, publish, path: () => container.querySelector('[data-path]')!.textContent };
}
test("Talk it through waits for its matching identity and summary, then explicitly selects that context", async () => {
  const h = await mount(); await h.click("Talk"); assert.equal(h.path(), source, "the retained old workspace is not this result");
  await h.reply("unrelated"); assert.equal(h.path(), source); await h.reply(); assert.equal(h.path(), source, "the new summary has not arrived");
  await h.publish(); assert.equal(h.path(), `/w/${worldId}/chat/${ID}`);
  assert.equal(h.owner.getSnapshot().selected?.conversationId, ID); assert.equal(h.owner.getSnapshot().selected?.kind, "world");
});
test("a contextual result cannot redirect a page deliberately left while creation was pending", async () => {
  const h = await mount(); await h.click("Talk"); await h.click("Leave"); await h.reply(); await h.publish();
  assert.equal(h.path(), `/w/${worldId}/timeline`);
});
test("disconnect frees a contextual start without replaying its uncertain create", async () => {
  const h = await mount(); await h.click("Talk"); await act(async () => __setStateForTest(state, { connection: "closed" }));
  await act(async () => __setStateForTest(state, { connection: "open" })); await h.reply(); await h.publish(); assert.equal(h.path(), source);
});
