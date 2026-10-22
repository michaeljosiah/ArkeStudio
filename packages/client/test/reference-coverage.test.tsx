import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { ChapterReferenceCoverage, ClientMessage } from "@arke-studio/contracts";
import { ReferenceCoverage, BookReferenceCoverage } from "../src/components/reference-coverage.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
const dom=parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis,{window:dom.window,document:dom.document,HTMLElement:dom.HTMLElement,Node:dom.Node,Event:dom.Event,IS_REACT_ACT_ENVIRONMENT:true});
let root:Root|null=null;afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=null;document.body.innerHTML="";__setBridgeForTest(null);});
const chapter:ChapterReferenceCoverage={chapterId:"c",file:"c",title:"The harbour",order:1,preparation:"stale",rows:[
 {kind:"character",key:"a",name:"Maren Kest",aliases:["Rena"],billing:"lead",blocks:["p0"],state:"ready",sheet:"maren-kest"},
 {kind:"character",key:"b",name:"Els",billing:"supporting",blocks:["p0"],state:"ambiguous"},
 {kind:"place",key:"p",name:"North Salt",blocks:["p1"],state:"missing-reference"},
],bounds:{people:{limit:24,omitted:2},places:{limit:8,omitted:0},text:{limit:60000,omitted:780}}};
async function mount(node:React.ReactNode){const host=document.createElement("div");document.body.append(host);root=createRoot(host);await act(async()=>root!.render(node));return host;}
it("shows scoped evidence and limits without presenting zero unresolved as complete",async()=>{
 const host=await mount(<ReferenceCoverage chapter={chapter}/>);
 assert.match(host.textContent!,/Chapter changed/);assert.match(host.textContent!,/1 unresolved/);assert.match(host.textContent!,/1 missing reference/);assert.match(host.textContent!,/Limited preparation/);
 assert.match(host.textContent!,/2 character candidates outside/);assert.match(host.textContent!,/780 characters of prose omitted/);assert.match(host.textContent!,/Other names: Rena/);
 assert.match(host.textContent!,/Principal character/);assert.match(host.textContent!,/Supporting character/);assert.match(host.textContent!,/Anonymous people and object or detail/);assert.match(host.textContent!,/does not discover every person/);
 assert.equal(host.querySelector("details")!.hasAttribute("open"),false);
});
it("labels existing support billing without losing legacy or custom billing fallbacks",async()=>{
 const billings=["lead","support","supporting","guest",undefined];
 const rows=chapter.rows[0]!;
 const host=await mount(<ReferenceCoverage chapter={{...chapter,rows:billings.map((billing,index)=>({...rows,key:String(index),name:`Person ${index}`,billing}))}}/>);
 assert.deepEqual([...host.querySelectorAll("[data-testid=reference-coverage-row] .fy-look__facts")].map(row=>row.textContent),[
  "Principal character · Reference saved","Supporting character · Reference saved","Supporting character · Reference saved","Character · Reference saved","Character · Reference saved",
 ]);
});
it("reads book references only on explicit Check and shows unavailable chapters without changing any source",async()=>{
 const sent:ClientMessage[]=[];
 __setBridgeForTest({send:(json:string)=>sent.push(JSON.parse(json))} as unknown as ArkeBridge);
 __setStateForTest(FIXTURE_STATE,{connection:"open"});
 const worldId=FIXTURE_STATE.world!.meta.worldId;
 const host=await mount(<BookReferenceCoverage worldId={worldId} productionId="ledger" disabled={false}/>);
 assert.equal(sent.length,0);await act(async()=>host.querySelector("button")!.click());
 const message=sent[0]!;assert.equal(message.kind,"read-audiobook-looks");if(message.kind!=="read-audiobook-looks")throw Error();assert.equal(message.coverage,true);
 await act(async()=>__applyEventForTest({type:"audiobook.looks",at:"2026-10-21T00:00:00Z",worldId,productionId:"ledger",requestId:message.requestId,usage:{},coverage:[chapter,{...chapter,chapterId:"unavailable",order:2,preparation:"unavailable",rows:[]}]}));
 assert.match(host.textContent!,/Book references · 1 unresolved · 1 missing reference · 2 chapters to prepare/);assert.match(host.textContent!,/Chapter unavailable/);assert.match(host.textContent!,/Check again/);assert.equal(sent.length,1);
});
