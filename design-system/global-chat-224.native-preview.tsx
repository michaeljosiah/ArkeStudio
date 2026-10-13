// Design fixture only: render the existing page and reuse its mounted conversation.
// Commands terminate at an in-memory bridge. No coordinator, model or microphone is contacted.
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryRouter } from "react-router";
import { App } from "../packages/client/src/App";
import { __setBridgeForTest, __setStateForTest, __connectionStatusForTest } from "../packages/client/src/lib/store";
import { developLayoutFixture } from "../packages/client/test/develop-layout-fixture";

const state = developLayoutFixture();
// Illustrative catalogue, taken from the existing model-picker test fixture, not live availability.
state.app.harnessInfo = { generation: "v2", source: "path", version: "design fixture", beta: false };
state.app.harnessModels = [
 { id: "gpt-5.4", provider: "openai", providerName: "OpenAI", displayName: "GPT-5.4", tools: true, reasoning: true, inputModalities: ["text", "image"], inputTokenLimit: 400_000, variants: { names: ["low", "medium", "high", "xhigh"], default: "medium" } },
 { id: "claude-sonnet", provider: "anthropic", displayName: "Claude Sonnet 5.5", tools: true, inputModalities: ["text", "image"] },
 { id: "fledge", provider: "opencode", providerName: "OpenCode Zen", displayName: "Fledge Alpha Free", tools: true, inputModalities: ["text"], cost: { inputPerMTok: 0, outputPerMTok: 0 } },
];
const commands: unknown[] = [];
const designEvents: unknown[] = [];
for (const name of ["mousedown", "wheel", "keydown"]) document.addEventListener(name, event => designEvents.push({name, at:performance.now(), target:(event.target as HTMLElement)?.className}),true);
new MutationObserver(() => { const count=document.querySelectorAll('.fy-mchip__menu').length; if ((designEvents.at(-1) as {menus?:number})?.menus!==count) designEvents.push({menus:count,at:performance.now()}); }).observe(document.body,{subtree:true,childList:true});
// Preserve their native appearance without invoking actual media capabilities in a design file.
document.addEventListener("click", event => {
 const b = (event.target as Element).closest('button[aria-label="Attach images, documents and audio"],button[aria-label="Dictate"],button[aria-label="Send"]');
 if (b) { event.preventDefault(); event.stopImmediatePropagation(); }
}, true);
document.addEventListener("drop", event => { event.preventDefault(); event.stopImmediatePropagation(); }, true);
document.addEventListener("paste", event => { if (event.clipboardData?.files.length) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
const bridge = { connect() {}, send(raw: string) { commands.push(JSON.parse(raw)); }, subscribe() { return () => {}; }, coordinatorHttpBase: () => location.origin };
Object.assign(window, { arke: bridge, nativeDesignCommands: commands, nativeDesignEvents: designEvents });
__setBridgeForTest(bridge);
__setStateForTest(state);
__connectionStatusForTest("open");
const renderer = createRoot(document.getElementById("root")!);
flushSync(() => renderer.render(<MemoryRouter initialEntries={[`/w/${state.world!.meta.worldId}/p/saltlight/story`]}><App /></MemoryRouter>));

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const ready = async () => { await wait(450); await document.fonts.ready; };
let host: HTMLElement | null = null, slot: Comment | null = null, original: HTMLElement | null = null;
let trigger: HTMLButtonElement | null = null;
async function setMode(mode: string) {
 await ready();
 if (mode === "existing") {
  if (original && slot) { slot.replaceWith(original); slot = null; }
  host?.remove(); host = null; trigger?.remove(); trigger = null;
  document.body.removeAttribute("data-global-design");
  return;
 }
 if (!trigger) {
  trigger = document.createElement("button"); trigger.className = "fy-iconbtn";
  trigger.setAttribute("aria-label", "Chat"); trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("data-native-chat-trigger", "");
  trigger.title = "Chat";
  trigger.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 11a9 9 0 0 1-9 9H3l2-5a9 9 0 1 1 16-4Z"/></svg>';
  document.querySelector(".fy-titlebar__side--right")?.prepend(trigger);
  trigger.onclick = () => setMode(host ? "closed" : "proposed");
 }
 if (mode === "closed") {
  if (original && slot) { slot.replaceWith(original); slot = null; }
  host?.remove(); host = null; trigger.setAttribute("aria-expanded", "false");
  document.body.removeAttribute("data-global-design"); trigger.focus(); return;
 }
 if (host) return;
 original = document.querySelector(".fy-production-studio-chat") as HTMLElement;
 if (!original) throw new Error("Existing conversation mount not found");
 slot = document.createComment("existing conversation presentation slot"); original.replaceWith(slot);
 host = document.createElement("aside"); host.className = "gc224-native-panel";
 host.setAttribute("aria-label", "Builder Chat");
 host.innerHTML = '<header><div><b>Builder Chat</b><small>The Undersong / Saltlight</small></div><button type="button" aria-label="Close chat">×</button></header><div class="gc224-native-conversation"></div>';
 host.querySelector("button")!.onclick = () => setMode("closed");
 host.querySelector(".gc224-native-conversation")!.append(original);
 document.body.append(host); document.body.setAttribute("data-global-design", "open");
 trigger.setAttribute("aria-expanded", "true");
 (original.querySelector('[contenteditable="true"],textarea') as HTMLElement)?.focus();
}
Object.assign(window, { nativeDesignSetMode: setMode, nativeDesignReady: ready });
window.addEventListener("message", event => { if (event.source === parent && event.data?.arkeChatDesign) setMode(event.data.arkeChatDesign); });
document.addEventListener("keydown", event => { if (event.key === "Escape" && host && !document.querySelector(".fy-mchip__menu,.fy-msheet")) setMode("closed"); });
