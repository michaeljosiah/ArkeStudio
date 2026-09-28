import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import { type ClientMessage } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __applyEventForTest, __clearWorldChatHoldsForTest, __connectionStatusForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { chapterLayoutFixture, CHAPTER_BODY, CHAPTER_HASH } from "./chapter-layout-fixture.js";

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
async function mount(route='p/ledger/story/chapters',size=390,mode='normal',remote=false,touch=true){
  width=size;coarse=touch;sent=[];
  const host=document.createElement('div');document.body.append(host);root=createRoot(host);
  if(remote){const marker=document.createElement('meta');marker.name='arke-remote';marker.content='true';document.head.append(marker);}
  const bridge={connect(){},subscribe(){return()=>{};},send(raw:string){sent.push(JSON.parse(raw));}} as unknown as ArkeBridge;
  Object.assign(dom.window,{arke:remote?undefined:bridge});
  const state=chapterLayoutFixture(mode);
  await act(async()=>{__setBridgeForTest(bridge);__setStateForTest(state);__connectionStatusForTest('open');root!.render(<MemoryRouter initialEntries={['/w/'+state.world!.meta.worldId+'/'+route]}><App/></MemoryRouter>);});
}
afterEach(async()=>{await act(async()=>root?.unmount());root=null;document.body.replaceChildren();document.head.replaceChildren();Object.assign(dom.window,{visualViewport:undefined});Object.defineProperty(document,'activeElement',{value:document.body,configurable:true});__setBridgeForTest(null);__connectionStatusForTest('closed');__clearWorldChatHoldsForTest();});
async function draft(text:string){const editor=find('.fy-cx__editor');editor.innerText=text;await act(async()=>props(editor).onInput!({currentTarget:editor} as never));return editor;}



async function openChapter(){const ask=sent.findLast(m=>m.kind==='open-chapter');assert.ok(ask);await act(async()=>__applyEventForTest({type:'chapter.open-result',at:'2026-09-28T14:00:00Z',requestId:ask.requestId,worldId:ask.worldId,productionId:ask.productionId,chapterId:'neap',disposition:'opened',body:CHAPTER_BODY+'\n\n<br>',version:4,hash:CHAPTER_HASH,versions:[3,2]}));}
it('chapter card actions reorder stable files and retire the selected chapter',async()=>{
 await mount();await click(find('.fy-chapter-card__more'));await click([...document.querySelectorAll<HTMLElement>('.fy-chapter-menu button')].find(b=>b.textContent==='Move down')!);
 const reorder=sent.find(m=>m.kind==='reorder-chapters');assert.ok(reorder);
 await click(find('.fy-chapter-card__more'));await click([...document.querySelectorAll<HTMLElement>('.fy-chapter-menu button')].find(b=>b.textContent==='Retire')!);assert.ok(sent.some(m=>m.kind==='retire-chapter'));
});
it('source selections are detected by selectionchange without mouseup on touch',async()=>{
 await mount('p/ledger/story/chapters/neap');await openChapter();const area=find('.fy-ch__source') as HTMLTextAreaElement;
 Object.defineProperty(document,'activeElement',{value:area,configurable:true});area.selectionStart=0;area.selectionEnd=31;
 await act(async()=>document.dispatchEvent(new Event('selectionchange')));assert.ok(find('.fy-passage-ask'));assert.equal(find('.fy-ch__ask-wrap'),null);assert.match(find('.fy-passage-ask').textContent!,/paragraph 1/);
 const input=find('.fy-passage-ask .fy-cx__editor');Object.defineProperty(document,'activeElement',{value:input,configurable:true});area.selectionEnd=0;
 await act(async()=>props(area).onSelect!({currentTarget:area} as never));assert.ok(find('.fy-passage-ask'),'moving focus into the ask retains its subject');
 await click(find('[aria-label="Close passage"]'));assert.equal(find('.fy-passage-ask'),null);
});
it('Notes and Arke are sheets and resizing keeps the manuscript draft',async()=>{
 await mount('p/ledger/story/chapters/neap');await openChapter();const area=find('.fy-ch__source'),draftText=CHAPTER_BODY+'\n\nMy unsaved sentence. <br>';
 await act(async()=>props(area).onChange!({target:{value:draftText}} as never));await click(find('[aria-label="Notes"]'));assert.ok(find('.fy-chapter-notes-sheet[open]'));
 await act(async()=>{width=984;for(const listener of listeners)listener();});assert.equal((find('.fy-ch__source') as HTMLTextAreaElement).value,draftText);
 await click(find('.fy-chapter-notes-sheet [aria-label="Close"]'));await click(find('[aria-label="Open Arke"]'));assert.ok(find('.fy-season-arke-sheet[open]'));
});
it('a compact waiting passage has an attended decision without opening Arke',async()=>{
 await mount('p/ledger/story/chapters/neap',390,'waiting');await openChapter();assert.ok(find('.fy-passage-decision'));assert.equal(find('.fy-season-arke-sheet[open]'),null);
 const edits=[...document.querySelectorAll<HTMLButtonElement>('.fy-passage-edits button')];assert.ok(edits.length>1);await click(edits[0]!);assert.equal(edits[0]!.getAttribute('aria-pressed'),'false');assert.match(edits[0]!.textContent!,/Refused/);
});
