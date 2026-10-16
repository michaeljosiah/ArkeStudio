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
import { __clearHeldAsksForTest } from "../src/screens/chapter-workspace.js";
import { FormatBar } from "../src/screens/chapter-room.js";
import { chapterLayoutFixture, CHAPTER_BODY, CHAPTER_HASH } from "./chapter-layout-fixture.js";

const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
let width=390, coarse=true;
const listeners=new Set<()=>void>();
Object.assign(dom.window, {
  innerWidth:390,innerHeight:797,location:{origin:"http://fixture.test"},getComputedStyle:()=>({direction:"ltr"}),
  matchMedia:(query:string)=>({matches:(!query.includes("hover:") || query.includes(coarse?"hover: none":"hover: hover")) && (!query.includes("pointer:") || query.includes(coarse?"pointer: coarse":"pointer: fine")) && [...query.matchAll(/\((min|max)-width: (\d+)px\)/g)].every(([,kind,value])=>kind==='min'?width>=Number(value):width<=Number(value)),addEventListener:(_:string,listener:()=>void)=>listeners.add(listener),removeEventListener:(_:string,listener:()=>void)=>listeners.delete(listener)}),
});
Object.assign(dom.HTMLElement.prototype,{getBoundingClientRect:()=>({x:0,y:0,left:0,top:0,right:44,bottom:44,width:44,height:44}),showModal(this:HTMLElement){this.setAttribute("open","");},show(this:HTMLElement){this.setAttribute("open","");this.dataset.modeless="";},close(this:HTMLElement){this.removeAttribute("open");delete this.dataset.modeless;},scrollIntoView(){},setPointerCapture(){},releasePointerCapture(){}});
Object.defineProperty(dom.HTMLElement.prototype,"clientWidth",{configurable:true,get(){return 688;}});
Object.defineProperty(dom.HTMLElement.prototype,"clientHeight",{configurable:true,get(){return 520;}});
Object.defineProperty(dom.HTMLElement.prototype,"innerText",{configurable:true,get(){return this.textContent;},set(value){this.textContent=value;}});
Object.assign(globalThis,{window:dom.window,document:dom.document,HTMLElement:dom.HTMLElement,Element:dom.Element,Node:dom.Node,Event:dom.Event,IS_REACT_ACT_ENVIRONMENT:true});
let root:Root|null=null, sent:ClientMessage[]=[];
const find=(selector:string)=>document.querySelector<HTMLElement>(selector)!;
const props=(element:HTMLElement)=>{const key=Object.keys(element).find(key=>key.startsWith('__reactProps$'))!;return (element as unknown as Record<string,Record<string,(event:never)=>void>>)[key]!;};
const click=async(element:HTMLElement)=>{assert.ok(element);await act(async()=>element.click());};
// The phone bar's ⋯ (SPEC-056 R-7, 227l): Brief, the read and the views are its items.
const pageAction=async(label:string)=>{await click(find('[aria-label="Page actions"]'));await click([...document.querySelectorAll<HTMLElement>('.fy-scene-menu button')].find(b=>b.textContent===label)!);};
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
it('Notes is a sheet, Arke is the app\'s Chat, and resizing keeps the manuscript draft (turn 227)',async()=>{
 await mount('p/ledger/story/chapters/neap');await openChapter();const area=find('.fy-ch__source'),draftText=CHAPTER_BODY+'\n\nMy unsaved sentence. <br>';
 await act(async()=>props(area).onChange!({target:{value:draftText}} as never));await pageAction('Brief');assert.ok(find('.fy-chapter-notes-sheet[open]'));
 await act(async()=>{width=984;for(const listener of listeners)listener();});assert.equal((find('.fy-ch__source') as HTMLTextAreaElement).value,draftText);
 await click(find('.fy-chapter-notes-sheet [aria-label="Close"]'));
 // The page draws no Arke of its own (SPEC-056 R-3): no rail to pin it back, no dock sheet, no half.
 assert.equal(find('[aria-label="Open Arke"]'),null,'no page-owned rail');assert.equal(find('.fy-season-arke-sheet'),null,'no page-owned dock');
 await click(find('[data-global-chat-trigger]'));assert.ok(find('.fy-global-chat[open]'),'the titlebar opens the app\'s Chat');
 assert.match(find('.fy-global-chat').textContent!,/Builder Chat/);
 await click(find('[aria-label="Close Chat"]'));assert.equal(find('.fy-global-chat[open]'),null);
 assert.equal((find('.fy-ch__source') as HTMLTextAreaElement).value,draftText,'and the draft is still the author\'s');
});
it('with Chat open a selected passage is adopted explicitly into global Chat (224, 227)',async()=>{
 await mount('p/ledger/story/chapters/neap',984);await openChapter();await click(find('[data-global-chat-trigger]'));assert.ok(find('.fy-global-chat[open]'));
 const area=find('.fy-ch__source') as HTMLTextAreaElement;Object.defineProperty(document,'activeElement',{value:area,configurable:true});area.selectionStart=0;area.selectionEnd=31;
 await act(async()=>document.dispatchEvent(new Event('selectionchange')));
 assert.equal(find('.fy-passage-ask'),null,'with the thread beside the page, no ask bar is drawn over the selection');
 const use=[...document.querySelectorAll<HTMLElement>('.fy-global-chat button')].find(b=>b.textContent==='Use this page');
 if(use)await click(use);
 assert.match(find('.fy-global-chat .fy-arke__subject').textContent!,/Chapter \d+ · paragraph \d+/);
 const field=find('.fy-global-chat .fy-cx__editor');Object.defineProperty(document,'activeElement',{value:field,configurable:true});area.selectionEnd=0;
 await act(async()=>props(area).onSelect!({currentTarget:area} as never));assert.match(find('.fy-global-chat .fy-arke__subject').textContent!,/Chapter \d+ · paragraph \d+/,'moving into the Chat’s field keeps the passage');
 await click(find('[aria-label="Close Chat"]'));assert.equal(find('.fy-global-chat[open]'),null,'the retained passage chat is closed');
});
it('a rewrite asked from the selection goes quietly: sent from the page, Chat left closed (227, codex on PR 1804)',async()=>{
 __clearHeldAsksForTest();__clearWorldChatHoldsForTest();
 await mount('p/ledger/story/chapters/neap',1280,'normal',false,false);await openChapter();assert.equal(find('.fy-global-chat[open]'),null);
 const area=find('.fy-ch__source') as HTMLTextAreaElement;Object.defineProperty(document,'activeElement',{value:area,configurable:true});area.selectionStart=0;area.selectionEnd=31;
 await act(async()=>document.dispatchEvent(new Event('selectionchange')));
 await click(find('.fy-selbar .fy-ch__ask'));
 const tighten=[...document.querySelectorAll<HTMLElement>('.fy-askm [role=menuitem]')].find(b=>b.textContent==='Tighten');assert.ok(tighten,'the menu offers Tighten');
 await click(tighten!);
 assert.equal(find('.fy-global-chat[open]'),null,'Chat stays closed for a rewrite whose answer comes back on the page');
 assert.ok(sent.some(m=>(m.kind==='world-chat-send'||m.kind==='world-chat-create')&&JSON.stringify(m).includes('Tighten this')),'and the ask is still sent, by the page’s own conversation');
});
it('a compact waiting passage has an attended decision without opening Arke',async()=>{
 await mount('p/ledger/story/chapters/neap',390,'waiting');await openChapter();assert.ok(find('.fy-passage-decision'));assert.equal(find('.fy-season-arke-sheet[open]'),null);
 const edits=[...document.querySelectorAll<HTMLButtonElement>('.fy-passage-edits button')];assert.ok(edits.length>1);await click(edits[0]!);assert.equal(edits[0]!.getAttribute('aria-pressed'),'false');assert.match(edits[0]!.textContent!,/Refused/);
});
it('an open chapter menu resolves its file against a replacement snapshot', async () => {
 await mount(); await click([...document.querySelectorAll<HTMLElement>('.fy-chapter-card__more')][1]!);
 const fresh=chapterLayoutFixture(); await act(async()=>__setStateForTest(fresh));
 await click([...document.querySelectorAll<HTMLElement>('.fy-chapter-menu button')].find(b=>b.textContent==='Move down')!);
 const command=sent.findLast(m=>m.kind==='reorder-chapters');assert.ok(command);
 assert.deepEqual(command.orderedFiles,['01-chapter','03-chapter','02-chapter','04-chapter']);
});
it('a newer chapter title closes the Notes editor without writing its stale draft', async () => {
 await mount('p/ledger/story/chapters/neap'); await openChapter(); await pageAction('Brief');
 await click(find('.fy-ch__plan [role="textbox"]'));
 const field=find('.fy-ch__plan input') as HTMLInputElement;assert.ok(field);field.value='My stale name';const blur=props(field).onBlur!;
 const fresh=chapterLayoutFixture();fresh.world!.productions[0]!.chapters[0]!.title='Name from another window';
 await act(async()=>__setStateForTest(fresh));
 await act(async()=>blur({currentTarget:field} as never));
 assert.equal(sent.filter(m=>m.kind==='edit-chapter-plan').length,0);assert.match(find('.fy-ch__plan').textContent!,/Name from another window/);
});
for(const route of ['neap/','01-chapter'])it('chapter alias '+route+' keeps the shared Chat control above the deep phone chrome',async()=>{
 await mount('p/ledger/story/chapters/'+route);await openChapter();assert.equal(document.querySelectorAll('.fy-titlebar').length,1);assert.ok(find('[data-global-chat-trigger]'));assert.ok(find('[data-screen="chapter"]'));
});
it('Fold source selections position the ask at the captured line rather than after the textarea',async()=>{
 await mount('p/ledger/story/chapters/neap',984);await openChapter();const area=find('.fy-ch__source') as HTMLTextAreaElement;
 Object.defineProperty(document,'activeElement',{value:area,configurable:true});area.selectionStart=0;area.selectionEnd=31;
 await act(async()=>document.dispatchEvent(new Event('selectionchange')));assert.equal(find('.fy-passage-anchor').style.position,'absolute');assert.ok(Number.parseFloat(find('.fy-passage-anchor').style.top)>=20);
});
it('compact chapters retain voiced playback whenever a voice record exists',async()=>{
 await mount('p/ledger/story/chapters/neap');const ask=sent.findLast(m=>m.kind==='open-chapter');assert.ok(ask);
 await act(async()=>__applyEventForTest({type:'chapter.open-result',at:'2026-09-28T14:00:00Z',requestId:ask.requestId,worldId:ask.worldId,productionId:ask.productionId,chapterId:'neap',disposition:'opened',body:CHAPTER_BODY+'\n\n<br>',version:4,hash:CHAPTER_HASH,versions:[3,2],voices:{version:4,hash:CHAPTER_HASH,derivedAt:'2026-09-28T14:00:00Z',passes:1,dropped:0,omitted:0,lines:[]}}));
 await click(find('[aria-label="Page actions"]'));
 assert.ok([...document.querySelectorAll<HTMLElement>('.fy-scene-menu button')].some(b=>b.textContent==='Read voiced chapter'),'the phone bar\'s ⋯ holds the voiced read');
});
it('a phone Manuscript is the phone bar over the page, its views in the ⋯ (SPEC-056 R-7, R-46)',async()=>{
 await mount('p/ledger/story/chapters/neap');await openChapter();
 assert.ok(find('.fy-scene-back [data-testid="chapter-goal"]'),'the goal beside the title');
 assert.equal(find('.fy-sw__head'),null,'no chips, view row or read row over the page');
 assert.ok(find('.fy-ch__dochead'),'the document opens on its number and title');
 await click(find('[aria-label="Page actions"]'));
 const items=[...document.querySelectorAll<HTMLElement>('.fy-scene-menu button')].map(b=>b.textContent);
 for(const label of ['Brief','Chapter','Audiobook','Audio Studio'])assert.ok(items.includes(label),label);
 await click([...document.querySelectorAll<HTMLElement>('.fy-scene-menu button')].find(b=>b.textContent==='Chapter')!);
 assert.ok(find('[data-testid="chapter-overview"]'));
 const foot=find('.fy-chov-held');assert.ok(foot,'Write and Listen held at the foot');assert.match(foot.textContent!,/^Write/);
 await click([...foot.querySelectorAll<HTMLElement>('button')].find(b=>b.textContent==='Write')!);assert.ok(find('.fy-ch__dochead'),'Write is the Manuscript');
});
it('the phone audiobook door holds no count, price or eyebrow until the door lands',async()=>{
 await mount('p/ledger/story/audiobook');
 // The meta line holds what the bundle knows (design turn 199): no length and no reader, and no stray "…", until the door lands.
 assert.match(find('[data-testid="audiobook-line"]').textContent!,/^Audiobook · \d+ chapters?$/);
 assert.equal(find('.fy-abdoor-held'),null,'"0 blocks · price unavailable" is not held at the foot while the door opens');
});
it('a compact chapter keeps its time in the Brief and draws no empty mark (turn 227)',async()=>{
 await mount('p/ledger/story/chapters/neap',820,'normal',false,false);await openChapter();
 // Above a phone the writing room has no chips row; the plan is the Brief's, a sheet below 1100.
 await click(find('[aria-label="Brief"]'));assert.ok(find('.fy-chapter-notes-sheet[open]'));
 const plan=()=>find('.fy-ch__plan').textContent!;
 assert.match(plan(),/1820 · March/,'a set time stays');
 const fresh=chapterLayoutFixture();delete fresh.world!.productions[0]!.chapters[0]!.when;
 await act(async()=>__setStateForTest(fresh));
 assert.equal(find('[aria-label="Chapter state"]'),null,'no chips row, so no empty pill');
 assert.ok(find('.fy-ch__plan [role="textbox"], .fy-ch__plan textarea, .fy-ch__plan input'),'an unset time is a field to type in, not an empty mark');
});
it('the phone format bar keeps the caret: its presses refuse focus, and each says what it does (SPEC-056 R-46)',async()=>{
 const calls:string[]=[];const host=document.createElement('div');document.body.append(host);root=createRoot(host);
 await act(async()=>root!.render(<FormatBar bold italic={false} onBold={()=>calls.push('bold')} onItalic={()=>calls.push('italic')} onMention={()=>calls.push('@')} onSlash={()=>calls.push('/')} onArke={()=>calls.push('arke')} onHide={()=>calls.push('hide')}/>));
 const bar=find('[data-testid="format-bar"]');let refused=0;
 props(bar).onMouseDown!({preventDefault:()=>{refused++;}} as never);props(bar).onPointerDown!({preventDefault:()=>{refused++;}} as never);assert.equal(refused,2);
 assert.equal(find('[aria-label="Bold"]').getAttribute('aria-pressed'),'true');
 for(const label of ['Bold','Italic','Mention','Commands','Hide keyboard'])await click(find(`[aria-label="${label}"]`));
 await click([...bar.querySelectorAll<HTMLElement>('button')].find(b=>b.textContent==='Arke')!);
 assert.deepEqual(calls,['bold','italic','@','/','hide','arke']);
 for(const button of bar.querySelectorAll('button'))assert.equal(button.getAttribute('type'),'button');
 // Focus moving within the bar or back to the page is still writing; anywhere else it is not (codex on PR 1814).
 let left=0;await act(async()=>root!.render(<FormatBar bold italic={false} onBold={()=>{}} onItalic={()=>{}} onMention={()=>{}} onSlash={()=>{}} onArke={()=>{}} onHide={()=>{}} onLeave={()=>{left++;}}/>));
 const page=document.createElement('div');page.className='ProseMirror';document.body.append(page);
 props(bar).onBlur!({currentTarget:bar,relatedTarget:find('[aria-label="Italic"]')} as never);
 props(bar).onBlur!({currentTarget:bar,relatedTarget:page} as never);assert.equal(left,0);
 props(bar).onBlur!({currentTarget:bar,relatedTarget:null} as never);assert.equal(left,1);
});
