import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import { type ClientMessage } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __clearWorldChatHoldsForTest, __connectionStatusForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { seasonLayoutFixture, CHAT_ID } from "./season-layout-fixture.js";

const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
let width=390, coarse=true;
const listeners=new Set<()=>void>();
Object.assign(dom.window, {
  innerWidth:390,innerHeight:797,location:{origin:"http://fixture.test"},getComputedStyle:()=>({direction:"ltr"}),
  matchMedia:(query:string)=>({matches:(!query.includes("hover:") || query.includes(coarse?"hover: none":"hover: hover")) && (!query.includes("pointer:") || query.includes(coarse?"pointer: coarse":"pointer: fine")) && [...query.matchAll(/\((min|max)-width: (\d+)px\)/g)].every(([,kind,value])=>kind==='min'?width>=Number(value):width<=Number(value)),addEventListener:(_:string,listener:()=>void)=>listeners.add(listener),removeEventListener:(_:string,listener:()=>void)=>listeners.delete(listener)}),
});
Object.assign(dom.HTMLElement.prototype,{getBoundingClientRect:()=>({x:0,y:0,left:0,top:0,right:44,bottom:44,width:44,height:44}),showModal(this:HTMLElement){this.setAttribute("open","");},close(this:HTMLElement){this.removeAttribute("open");},scrollIntoView(){},setPointerCapture(){},releasePointerCapture(){}});
Object.defineProperty(dom.HTMLElement.prototype,"clientWidth",{configurable:true,get(){return 688;}});
Object.defineProperty(dom.HTMLElement.prototype,"clientHeight",{configurable:true,get(){return 520;}});
Object.defineProperty(dom.HTMLElement.prototype,"innerText",{configurable:true,get(){return this.textContent;},set(value){this.textContent=value;}});
Object.assign(globalThis,{window:dom.window,document:dom.document,HTMLElement:dom.HTMLElement,Element:dom.Element,Node:dom.Node,Event:dom.Event,IS_REACT_ACT_ENVIRONMENT:true});
let root:Root|null=null, sent:ClientMessage[]=[];
const find=(selector:string)=>document.querySelector<HTMLElement>(selector)!;
const props=(element:HTMLElement)=>{const key=Object.keys(element).find(key=>key.startsWith('__reactProps$'))!;return (element as unknown as Record<string,Record<string,(event:never)=>void>>)[key]!;};
const click=async(element:HTMLElement)=>{assert.ok(element);await act(async()=>element.click());};
async function mount(route='p/bell-watch/season',size=390,mode='season',remote=false,touch=true){
  width=size;coarse=touch;sent=[];
  const host=document.createElement('div');document.body.append(host);root=createRoot(host);
  if(remote){const marker=document.createElement('meta');marker.name='arke-remote';marker.content='true';document.head.append(marker);}
  const bridge={connect(){},subscribe(){return()=>{};},send(raw:string){sent.push(JSON.parse(raw));}} as unknown as ArkeBridge;
  Object.assign(dom.window,{arke:remote?undefined:bridge});
  const state=seasonLayoutFixture(mode);
  await act(async()=>{__setBridgeForTest(bridge);__setStateForTest(state);__connectionStatusForTest('open');root!.render(<MemoryRouter initialEntries={['/w/'+state.world!.meta.worldId+'/'+route]}><App/></MemoryRouter>);});
}
afterEach(async()=>{await act(async()=>root?.unmount());root=null;document.body.replaceChildren();document.head.replaceChildren();Object.assign(dom.window,{visualViewport:undefined});__setBridgeForTest(null);__connectionStatusForTest('closed');__clearWorldChatHoldsForTest();});
async function draft(text:string){const editor=find('.fy-cx__editor');editor.innerText=text;await act(async()=>props(editor).onInput!({currentTarget:editor} as never));return editor;}


it('episode tile menu reorders saved IDs and respects the first boundary',async()=>{
 await mount();await click(find('.fy-seasontile__menu'));
 const buttons=[...document.querySelectorAll<HTMLButtonElement>('.fy-episode-actions button')];assert.ok(buttons.find(b=>b.textContent==='Move earlier')?.disabled);
 await click(buttons.find(b=>b.textContent==='Move later')!);const move=sent.find(m=>m.kind==='reorder-episodes');assert.ok(move);assert.deepEqual(move.orderedIds,['ep_night-2','ep_night-1','ep_night-3']);
});
it('episode reads its authoritative promise and adds a scene in this episode',async()=>{
 await mount('p/bell-watch/episodes/ep_night-3',390,'episode');
 await click(find('.fy-episode-promise [aria-label="Read aloud"]'));assert.deepEqual(sent.find(m=>m.kind==='read-prose')?.source,{of:'episode',productionId:'bell-watch',episodeId:'ep_night-3',field:'opens'});
 await click(find('.fy-episode-add'));assert.equal(sent.find(m=>m.kind==='create-scene')?.episodeId,'ep_night-3');
});
it('Arke retains its composer draft across phone, Fold and desktop',async()=>{
 await mount();await click(find('[aria-label="Open Arke"]'));await draft('Keep this ending');
 for(const next of [984,1360,390]){await act(async()=>{width=next;for(const listener of listeners)listener();});assert.equal(find('.fy-cx__editor').innerText,'Keep this ending');}
 assert.equal(sent.some(m=>m.kind==='world-chat-send'),false);
});
it('the phone choice form creates a route and preserves its label across resize',async()=>{
 await mount('p/low-water/branch-map',390,'branch');const row=[...document.querySelectorAll<HTMLElement>('.bm-row')].find(e=>e.textContent?.includes('The Vigil'))!;await click(row);
 await act(async()=>props(find('input[aria-label="Choice label"]')).onChange!({target:{value:'Take the bell stair'}} as never));
 await act(async()=>{width=984;for(const listener of listeners)listener();});assert.equal((find('input[aria-label="Choice label"]') as HTMLInputElement).value,'Take the bell stair');
 await act(async()=>props(find('select[aria-label="To scene"]')).onChange!({target:{value:'sc_bells'}} as never));
 await click([...document.querySelectorAll<HTMLElement>('.bm-new-actions button')].find(b=>b.textContent==='Add choice')!);
 const message=sent.find(m=>m.kind==='routing-command');assert.ok(message);assert.equal(message.command.operation,'add-choice');if(message.command.operation==='add-choice'){assert.equal(message.command.choice.from,'sc_vigil');assert.equal(message.command.choice.to,'sc_bells');assert.equal(message.command.choice.label,'Take the bell stair');}
});
it('two pointers zoom the map without creating a choice, and cancellation releases the gesture',async()=>{
 await mount('p/low-water/branch-map',984,'branch');const canvas=find('.bm-viewport'),handlers=props(canvas),before=find('.bm-stage').style.transform;
 const event=(id:number,x:number)=>({pointerType:'touch',pointerId:id,clientX:x,clientY:10,currentTarget:canvas,preventDefault(){},stopPropagation(){}});
 await act(async()=>{handlers.onPointerDownCapture!(event(1,10) as never);handlers.onPointerDownCapture!(event(2,30) as never);});
 await act(async()=>handlers.onPointerMoveCapture!(event(2,50) as never));assert.notEqual(find('.bm-stage').style.transform,before);
 await act(async()=>{handlers.onPointerCancelCapture!(event(1,10) as never);handlers.onPointerCancelCapture!(event(2,50) as never);});assert.equal(sent.some(m=>m.kind==='routing-command'),false);
});
it('setup keeps the draft, no autofocus, and a phone-accessible writing model',async()=>{
 await mount('productions/setup/'+CHAT_ID,390,'setup');assert.equal(find('.fy-cx__editor').hasAttribute('autofocus'),false);await draft('Keep the two endings');await click(find('.fy-thread-peek'));assert.ok(find('.fy-setup-outline-sheet[open] [aria-label="Writing model"]'));
 for(const next of [984,390]){await act(async()=>{width=next;for(const listener of listeners)listener();});assert.equal(find('.fy-cx__editor').innerText,'Keep the two endings');}
});
