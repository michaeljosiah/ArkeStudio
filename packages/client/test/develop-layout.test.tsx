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
import { developLayoutFixture, CHAT_ID } from "./develop-layout-fixture.js";

const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
let width=390, coarse=true;
const listeners=new Set<()=>void>();
Object.assign(dom.window, {
  innerWidth:390,innerHeight:797,location:{origin:"http://fixture.test"},getComputedStyle:()=>({direction:"ltr"}),
  matchMedia:(query:string)=>({matches:(!query.includes("hover:") || query.includes(coarse?"hover: none":"hover: hover")) && (!query.includes("pointer:") || query.includes(coarse?"pointer: coarse":"pointer: fine")) && [...query.matchAll(/\((min|max)-width: (\d+)px\)/g)].every(([,kind,value])=>kind==='min'?width>=Number(value):width<=Number(value)),addEventListener:(_:string,listener:()=>void)=>listeners.add(listener),removeEventListener:(_:string,listener:()=>void)=>listeners.delete(listener)}),
});
Object.assign(dom.HTMLElement.prototype,{getBoundingClientRect:()=>({x:0,y:0,left:0,top:0,right:44,bottom:44,width:44,height:44}),showModal(this:HTMLElement){this.setAttribute("open","");},close(this:HTMLElement){this.removeAttribute("open");},scrollIntoView(){}});
Object.defineProperty(dom.HTMLElement.prototype,"innerText",{configurable:true,get(){return this.textContent;},set(value){this.textContent=value;}});
Object.assign(globalThis,{window:dom.window,document:dom.document,HTMLElement:dom.HTMLElement,Element:dom.Element,Node:dom.Node,Event:dom.Event,IS_REACT_ACT_ENVIRONMENT:true});
let root:Root|null=null, sent:ClientMessage[]=[];
const find=(selector:string)=>document.querySelector<HTMLElement>(selector)!;
const props=(element:HTMLElement)=>{const key=Object.keys(element).find(key=>key.startsWith('__reactProps$'))!;return (element as unknown as Record<string,Record<string,(event:never)=>void>>)[key]!;};
const click=async(element:HTMLElement)=>{assert.ok(element);await act(async()=>element.click());};
async function mount(route='p/saltlight/story',size=390,mode='normal',remote=false,touch=true){
  width=size;coarse=touch;sent=[];
  const host=document.createElement('div');document.body.append(host);root=createRoot(host);
  if(remote){const marker=document.createElement('meta');marker.name='arke-remote';marker.content='true';document.head.append(marker);}
  const bridge={connect(){},subscribe(){return()=>{};},send(raw:string){sent.push(JSON.parse(raw));}} as unknown as ArkeBridge;
  Object.assign(dom.window,{arke:remote?undefined:bridge});
  const state=developLayoutFixture(mode);
  await act(async()=>{__setBridgeForTest(bridge);__setStateForTest(state);__connectionStatusForTest('open');root!.render(<MemoryRouter initialEntries={['/w/'+state.world!.meta.worldId+'/'+route]}><App/></MemoryRouter>);});
}
afterEach(async()=>{await act(async()=>root?.unmount());root=null;document.body.replaceChildren();document.head.replaceChildren();Object.assign(dom.window,{visualViewport:undefined});__setBridgeForTest(null);__connectionStatusForTest('closed');__clearWorldChatHoldsForTest();});
async function draft(text:string){const editor=find('.fy-cx__editor');editor.innerText=text;await act(async()=>props(editor).onInput!({currentTarget:editor} as never));return editor;}

for(const size of [390,1360])it('touch Return keeps the draft at '+size,async()=>{
  await mount(undefined,size);const editor=await draft('First line');let prevented=false;
  await act(async()=>props(editor).onKeyDown!({key:'Enter',shiftKey:false,nativeEvent:{isComposing:false},preventDefault(){prevented=true;}} as never));
  assert.equal(prevented,false);assert.equal(sent.some(m=>m.kind==='world-chat-send'),false);assert.equal(find('.fy-cx__send').getAttribute('title'),null);
  await click(find('.fy-cx__send'));assert.equal(sent.filter(m=>m.kind==='world-chat-send').length,1);
});
it('desktop Return still sends',async()=>{
  await mount(undefined,1360,'normal',false,false);const editor=await draft('Send this');
  await act(async()=>props(editor).onKeyDown!({key:'Enter',shiftKey:false,nativeEvent:{isComposing:false},preventDefault(){}} as never));
  assert.equal(sent.filter(m=>m.kind==='world-chat-send').length,1);
});
it('remote attach opens the device picker and sends its bytes to this conversation',async()=>{
  await mount(undefined,390,'normal',true);const input=find('input[type="file"]');let picks=0;input.click=()=>{picks++;};
  await click(find('.fy-cx__attach'));assert.equal(picks,1);
  await act(async()=>{props(input).onChange!({currentTarget:{files:[new File(['Private notes'],'notes.txt')],value:'notes.txt'}} as never);});
  const upload=sent.find(m=>m.kind==='world-chat-upload');assert.ok(upload);assert.equal(upload.conversationId,CHAT_ID);assert.equal(atob(upload.data),'Private notes');assert.equal(sent.some(m=>m.kind==='world-chat-attach-files'),false);
});
it('device files selected before a thread exists wait for its creation',async()=>{
  await mount(undefined,390,'empty-thread',true);
  await act(async()=>props(find('input[type="file"]')).onChange!({currentTarget:{files:[new File(['Before the conversation'],'notes.txt')],value:'notes.txt'}} as never));
  assert.equal(sent.filter(m=>m.kind==='world-chat-create').length,1);assert.equal(sent.some(m=>m.kind==='world-chat-upload'),false);
  await act(async()=>__setStateForTest(developLayoutFixture()));
  assert.equal(sent.filter(m=>m.kind==='world-chat-upload').length,1);assert.equal(sent.some(m=>m.kind==='world-chat-send'),false);
});
it('understood decisions keep their revision and wrap-up survives resize',async()=>{
  await mount();await draft('Keep my draft');await click(find('.fy-thread-peek'));
  await click(find('.fy-develop-sheet .fy-panel__pointacts button'));
  const save=sent.find(m=>m.kind==='world-chat-save-point');assert.equal(save?.expectedCandidateRevision,1);
  await click(find('.fy-develop-sheet .fy-wrapup button'));
  await act(async()=>{width=1360;for(const listener of listeners)listener();});
  assert.equal(find('.fy-cx__editor').innerText,'Keep my draft');assert.match(find('.fy-wrapup button').textContent!,/Writing/);assert.equal(sent.filter(m=>m.kind==='world-chat-wrap-up').length,1);
});
it('staged changes expose old/new, Send back and the reason Accept is held',async()=>{
  await mount(undefined,390,'blocked');await click(find('.fy-thread-peek'));
  assert.ok(find('.dom-review__was'));assert.ok(find('.dom-review__now'));
  assert.match(find('.dom-proposal__touch-reasons').textContent!,/Resolve the conflicts/);assert.match(find('.dom-proposal__touch-reasons').textContent!,/reopens the conversation/);
  assert.ok(find('.dom-proposal__actions .ui-btn--primary').hasAttribute('disabled'));
});
it('a Fold act card reads that act alone, and More expands the spine',async()=>{
  await mount('p/ledger/overview',984);await click(find('.fy-overview-more'));assert.equal(find('.fy-overview-more').getAttribute('aria-expanded'),'true');
  await click(find('.fy-overview-act:nth-child(2) [aria-label="Read aloud"]'));
  const read=sent.find(m=>m.kind==='read-prose');assert.deepEqual(read?.source,{of:'story',productionId:'ledger',field:'acts',act:1});
});
it('narrative edits survive a resize and a conflicting remote save blocks overwrite',async()=>{
  await mount('p/saltlight/narrative');const field=find('.fy-narrative textarea');
  await act(async()=>props(field).onChange!({target:{value:'My ending'}} as never));
  await act(async()=>{width=1360;for(const listener of listeners)listener();});
  assert.equal((find('.fy-narrative textarea') as HTMLTextAreaElement).value,'My ending');
  const state=developLayoutFixture();state.world!.productions[0]!.narrative!.version=4;
  await act(async()=>__setStateForTest(state));assert.match(find('[role="alert"]').textContent!,/changed elsewhere/);assert.ok(find('.fy-narrative__save button').hasAttribute('disabled'));
});
it('the held composer follows the visual keyboard viewport but not pinch zoom',async()=>{
  const changes=new Set<()=>void>(),viewport={height:500,offsetTop:20,scale:1,addEventListener:(_:string,cb:()=>void)=>changes.add(cb),removeEventListener:(_:string,cb:()=>void)=>changes.delete(cb)};
  Object.assign(dom.window,{visualViewport:viewport});await mount();assert.equal(find('.fy-develop-composer').style.bottom,'277px');
  await act(async()=>{viewport.height=450;for(const changed of changes)changed();});assert.equal(find('.fy-develop-composer').style.bottom,'327px');
  await act(async()=>{viewport.scale=2;for(const changed of changes)changed();});assert.equal(parseFloat(find('.fy-develop-composer').style.bottom),0);
});
