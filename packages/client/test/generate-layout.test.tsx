import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import { REVIEW_NOTE_MAX, type ClientMessage } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __applyEventForTest, __connectionStatusForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { generateLayoutFixture, generateQuote } from "./generate-layout-fixture.js";


const dom = parseHTML("<!doctype html><html><body></body></html>");
let width = 390;
const listeners = new Set<() => void>();
Object.assign(dom.window, {
  innerWidth: 390, innerHeight: 797, getComputedStyle: () => ({ direction: "ltr" }),
  matchMedia: (query: string) => ({
    matches: query.split(",").some(part => (!part.includes("hover:") || part.includes("hover: none")) && (!part.includes("pointer:") || part.includes("pointer: coarse")) && [...part.matchAll(/\((min|max)-width: (\d+)px\)/g)].every(([, kind, value]) => kind === "min" ? width >= Number(value) : width <= Number(value))),
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }),
});
Object.assign(dom.HTMLElement.prototype, {
  getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, right: 44, bottom: 44, width: 44, height: 44 }),
  showModal(this: HTMLElement) { this.setAttribute("open", ""); },
  close(this: HTMLElement) { this.removeAttribute("open"); },
  scrollIntoView() {},
});
Object.assign(Object.getPrototypeOf(dom.document.createElement("video")), { pause() {}, play: () => Promise.resolve() });
Object.assign(globalThis, {
  window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0), cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
let root: Root | null = null;
let sent: ClientMessage[] = [];
const base = "/w/" + generateLayoutFixture().world!.meta.worldId + "/p/saltlight";
async function mount(route = "/generate?shot=sh_12", size = 390, mode = "normal") {
  width = size; sent = [];
  const host = dom.document.createElement("div"); dom.document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    __setBridgeForTest({ connect() {}, subscribe() { return () => {}; }, send(raw: string) { const message = JSON.parse(raw); sent.push(message); if (message.kind === "frame-run-quote") queueMicrotask(() => __applyEventForTest({type:"production.frame-run-quote",at:"2026-08-30T12:00:01Z",quote:generateQuote(message)})); } } as unknown as ArkeBridge);
    __setStateForTest(generateLayoutFixture(mode)); __connectionStatusForTest("open");
    root!.render(<MemoryRouter initialEntries={[base + route]}><App /></MemoryRouter>);
  });
}
afterEach(async () => { await act(async () => root?.unmount()); root = null; dom.document.body.replaceChildren(); __setBridgeForTest(null); __connectionStatusForTest("closed"); });
const find = (selector: string) => dom.document.querySelector(selector) as unknown as HTMLElement;
const textButton = (text: string, scope = "body") => [...find(scope).querySelectorAll("button")].find(button => button.textContent?.trim() === text) as HTMLElement;
const click = async (element: HTMLElement) => { assert.ok(element); await act(async () => element.click()); };

function props(element: HTMLElement): Record<string, (event: never) => void> {
  const key = Object.keys(element).find(name => name.startsWith('__reactProps$'))!;
  return (element as unknown as Record<string, Record<string, (event: never) => void>>)[key]!;
}
for (const size of [390, 984, 1360]) it('rejects with the chosen provenance and note at ' + size, async () => {
  await mount(undefined,size);
  await click(find('.fy-takes__verdict > button:last-child'));
  assert.equal(sent.filter(m=>m.kind==='reject-take').length,0);
  await click(find('.fy-reject-take__citations button:last-child'));
  await act(async () => props(find('.fy-reject-take textarea')).onChange!({target:{value:'Keep the lantern colour'}} as never));
  await click(find('.fy-reject-take .fy-page-sheet__foot button:last-child'));
  const rejection = sent.find(m=>m.kind==='reject-take');
  assert.equal(rejection?.takeId,'layout-take-1');
  assert.deepEqual(rejection?.citation,{sheet:'the-vigil',field:'appearance',note:'Keep the lantern colour'});
  assert.equal(find('.fy-reject-take'),null);
});
it('keeps the rejection pending when the connection is lost', async () => {
  await mount(); await click(find('.fy-takes__verdict > button:last-child'));
  await act(async () => __connectionStatusForTest('closed'));
  assert.ok(find('.fy-reject-take .fy-page-sheet__foot button:last-child').hasAttribute('disabled'));
  assert.equal(sent.filter(m=>m.kind==='reject-take').length,0);
});
for(const size of [390,984]) it('starts Arke in a sheet at ' + size, async () => {
  await mount(undefined,size); assert.equal(find('.fy-scene-dock[open]'),null);
  await click(find('.fy-generate-wrap > .fy-sw__rail'));
  assert.ok(find('.fy-scene-dock[open] .fy-arke'));
});
it('uses the styled Shot control and a named Add reference on the phone bench',async()=>{
  await mount('/generate?view=bench&shot=sh_12');
  assert.ok(find('.ui-select select[aria-label="Shot"]'));
  assert.match(find('[aria-label="Add reference"]').textContent??'',/Add/);
  assert.ok(find('.fy-gen__phone-foot'));
  await click(find('.fy-gen__model-row')); assert.ok(find('.fy-page-sheet[open]'));
});
it('opens the bench assistant on request and keeps its draft while resizing',async()=>{
  await mount('/generate?view=bench&shot=sh_12'); assert.equal(find('.fy-scene-dock'),null);
  await click(find('.fy-gen__arke')); const editor=find('.fy-scene-dock [role="textbox"]'); assert.ok(editor); editor.textContent='Keep this direction';
  await act(async()=>props(editor).onInput!({currentTarget:editor} as never));
  await act(async()=>{width=1360;for(const listener of listeners)listener();});
  assert.equal(find('.fy-scene-dock[open]'),null); assert.equal(find('.fy-scene-dock [role="textbox"]'),editor);
  await act(async()=>{width=390;for(const listener of listeners)listener();});
  assert.equal(find('.fy-scene-dock [role="textbox"]'),editor); assert.equal(editor.textContent,'Keep this direction');
});
for (const size of [390,1360]) it('steps the review with arrow keys and horizontal swipes at '+size,async()=>{
  await mount('/scenes/sc_04',size,'completed'); await click(find('.fy-swrun__review'));
  const title=()=>find('.fy-swlightbox img')?.getAttribute('alt');
  const initial=title(); assert.ok(initial);
  const key=async(key:string)=>{const event=new dom.Event('keydown',{bubbles:true,cancelable:true});Object.assign(event,{key});await act(async()=>find('.fy-swlightbox').dispatchEvent(event));};
  await key('ArrowRight'); assert.notEqual(title(),initial); await key('ArrowLeft'); assert.equal(title(),initial);
  const frame=find('.fy-swlightbox__frame');
  await act(async()=>{props(frame).onPointerDown!({clientX:200,clientY:100,target:frame,currentTarget:frame,pointerId:1} as never);props(frame).onPointerUp!({clientX:60,clientY:104} as never);});
  assert.notEqual(title(),initial);
});
it('uses the canonical acceptance command from the frame variants sheet',async()=>{
  await mount('/scenes/sc_04',390,'completed'); await click(find('.fy-swrun__review'));
  await click(find('.fy-swlightbox__phone-foot button:last-child'));
  assert.ok(find('.fy-review-variants[open]'));
  await click(textButton('Use frame','.fy-review-variants'));
  const accept=sent.find(m=>m.kind==='accept-take'); assert.ok(accept); assert.equal(accept.shotId,'sh_12');
  assert.equal(find('.fy-review-variants[open]'),null);
});
it('keeps pause and cancel commands on the running phone bar',async()=>{
  await mount('/scenes/sc_04',390,'running');
  assert.match(find('.fy-swrun').textContent??'',/Frames1 of 2 · 1 failed/);
  await click(textButton('Pause','.fy-swrun')); await click(textButton('Cancel','.fy-swrun'));
  assert.deepEqual(sent.filter(m=>m.kind==='frame-run-pause'||m.kind==='frame-run-cancel').map(m=>m.kind),['frame-run-pause','frame-run-cancel']);
  assert.ok(find('.fy-swrow__band > .fy-swrow__run[data-state="failed"]'));
});
it('names a stranded model reason on its phone row',async()=>{
  await mount('/scenes/sc_04',390,'unavailable'); await click(textButton('Generate frames'));
  assert.match(find('.fy-swgen__models [data-unavailable] .fy-swgen__unavailable').textContent??'',/turned off in AI models/);
});

it('retains diagnostic drafts and the pending save across responsive changes', async () => {
  await mount(undefined,390,'diagnostics'); await click(find('.fy-takes__diagnostics'));
  const tag=find('.fy-takes-diagnostics-sheet input[type="checkbox"]');
  await act(async()=>props(tag).onChange!({target:{checked:true}} as never));
  await act(async()=>props(find('.fy-takes-diagnostics-sheet textarea')).onChange!({target:{value:'Keep the framing'}} as never));
  await act(async()=>{width=1360;for(const listener of listeners)listener();});
  const note=()=>find('textarea') as HTMLTextAreaElement;
  assert.equal(note().value,'Keep the framing');
  await click(textButton('Save diagnostic feedback'));
  const saved=sent.find(m=>m.kind==='record-dialogue-feedback'); assert.ok(saved); assert.equal(saved.note,'Keep the framing');
  await act(async()=>{width=390;for(const listener of listeners)listener();});
  assert.ok(textButton('Save diagnostic feedback').hasAttribute('disabled'));
  await act(async()=>__applyEventForTest({type:'dialogue.result',at:'2026-09-28T12:00:00Z',worldId:saved.worldId,requestId:saved.requestId,status:'saved',reason:'Diagnostic saved'}));
  assert.equal(note().value,''); assert.match(find('.fy-takes-diagnostics-sheet').textContent??'',/Diagnostic saved/);
  assert.equal(sent.filter(m=>m.kind==='record-dialogue-feedback').length,1);
});

it('New frames never steps onto a shot whose frame was not produced by that run',async()=>{
  await mount('/scenes/sc_04',390,'completed-one-output'); await click(find('.fy-swrun__review'));
  assert.equal(find('.fy-swlightbox__dots').getAttribute('aria-label'),'Frame 1 of 1');
  const title=()=>find('.fy-swlightbox img')?.getAttribute('alt'), initial=title();
  await click(find('.fy-swlightbox__phone-caption button:last-child')); assert.equal(title(),initial);
  const event=new dom.Event('keydown',{bubbles:true});Object.assign(event,{key:'ArrowRight'});await act(async()=>find('.fy-swlightbox').dispatchEvent(event)); assert.equal(title(),initial);
});

it('limits the new rejection note before the wire boundary',async()=>{
  await mount(); await click(find('.fy-takes__verdict > button:last-child'));
  const input=find('.fy-reject-take textarea'); assert.equal(input.getAttribute('maxLength'),String(REVIEW_NOTE_MAX));
  await act(async()=>props(input).onChange!({target:{value:'a'.repeat(REVIEW_NOTE_MAX+20)}} as never));
  await click(find('.fy-reject-take .fy-page-sheet__foot button:last-child'));
  assert.equal(sent.find(m=>m.kind==='reject-take')?.citation.note?.length,REVIEW_NOTE_MAX);
});
