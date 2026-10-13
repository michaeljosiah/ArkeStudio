// Design fixture only: render the existing page and reuse its mounted conversation.
// Commands terminate at an in-memory bridge. No coordinator, model or microphone is contacted.
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryRouter, useNavigate } from "react-router";
import { App } from "../packages/client/src/App";
import { __setBridgeForTest, __setStateForTest, __connectionStatusForTest } from "../packages/client/src/lib/store";
import { developLayoutFixture } from "../packages/client/test/develop-layout-fixture";
import { ModelChip } from "../packages/client/src/components/model-chip";

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
let testInput = false;
Object.assign(window, { nativeDesignAllowTestInput: () => { testInput = true; } });
// Preserve their native appearance without invoking actual media capabilities in a design file.
document.addEventListener("click", event => {
 const target=event.target as Element;
 const anyButton=target.closest('button');
 const allowed=anyButton?.closest('.fy-cx,.fy-mchip__menu,.fy-msheet,.fy-global-chat')||anyButton?.matches('[data-global-chat-trigger]');
 // Keep this comparison on its measured page. Settings/default persistence and route changes
 // are application actions; the separate context fixture demonstrates the proposed navigation.
 if(!testInput && (target.closest('a')||(anyButton&&(!allowed||anyButton.matches('.fy-mpick__manage,.fy-mpick__quiet'))))){event.preventDefault();event.stopImmediatePropagation();return;}
 const b = (event.target as Element).closest('button[aria-label="Attach images, documents and audio"],button[aria-label="Dictate"],button[aria-label="Send"]');
 if (b && !testInput) { event.preventDefault(); event.stopImmediatePropagation(); }
}, true);
document.addEventListener('keydown',event=>{if(!testInput && event.key==='Enter'&&!event.shiftKey&&(event.target as Element).matches('.fy-cx__editor')){event.preventDefault();event.stopImmediatePropagation();}},true);
document.addEventListener("drop", event => { if (!testInput) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
document.addEventListener("paste", event => { if (!testInput && event.clipboardData?.files.length) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
const bridge = { connect() {}, send(raw: string) { commands.push(JSON.parse(raw)); }, subscribe() { return () => {}; }, coordinatorHttpBase: () => location.origin };
Object.assign(window, { arke: bridge, nativeDesignCommands: commands, nativeDesignEvents: designEvents });
__setBridgeForTest(bridge);
__setStateForTest(state);
__connectionStatusForTest("open");
const renderer = createRoot(document.getElementById("root")!);
function FixtureNavigation() { const navigate = useNavigate(); Object.assign(window, { nativeDesignNavigate: navigate }); return null; }
flushSync(() => renderer.render(<MemoryRouter initialEntries={[`/w/${state.world!.meta.worldId}/p/saltlight/story`]}><FixtureNavigation /><App /></MemoryRouter>));

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const ready = async () => { await wait(450); await document.fonts.ready; };
async function setMode(mode: string) {
 await ready();
 const trigger=document.querySelector<HTMLButtonElement>('[data-global-chat-trigger]');
 const opened=trigger?.getAttribute('aria-expanded')==='true';
 if((mode==='proposed')!==opened)trigger?.click();
 document.body.setAttribute('data-global-design',mode==='proposed'?'open':mode);
 await wait(150);
}
Object.assign(window, { nativeDesignSetMode: setMode, nativeDesignReady: ready,
 nativeDesignSetState: __setStateForTest, nativeDesignFixture: state });
// Comparison-only specimen. World Chat's proposed host hides a model with no Settings name (195f).
let specimen: ReturnType<typeof createRoot> | null = null, specimenHost: HTMLElement | null = null;
Object.assign(window, { nativeDesignWorldSpecimen: (value?: string, remove=false) => {
 specimen?.unmount(); specimenHost?.remove(); specimen=null; specimenHost=null;
 if(remove)return;
 specimenHost=document.createElement('div');specimenHost.className='gc224-world-specimen';
 specimenHost.style.cssText='position:fixed;left:40px;top:180px;z-index:150';document.body.append(specimenHost);
 specimen=createRoot(specimenHost);flushSync(()=>specimen!.render(value===undefined?null:<ModelChip readOnly state={state} value={value} set={false} onPick={()=>{}} />));
} });
window.addEventListener("message", event => { if (event.source === parent && event.data?.arkeChatDesign) setMode(event.data.arkeChatDesign); });
