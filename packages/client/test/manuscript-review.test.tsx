import assert from "node:assert/strict";
import { it, afterEach } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import type { ClientMessage } from "@arke-studio/contracts";
import { ManuscriptReviewControl, ManuscriptReviewReport, ManuscriptReviewPassage } from "../src/components/manuscript-review.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { manuscriptReviewFixture } from "./manuscript-review-fixture.js";
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis,{window:dom.window,document:dom.document,HTMLElement:dom.HTMLElement,Node:dom.Node,Event:dom.Event,IS_REACT_ACT_ENVIRONMENT:true});
let root: Root | undefined;
afterEach(async()=>{ if(root) await act(async()=>root!.unmount()); dom.document.body.innerHTML=""; __setBridgeForTest(null); });
async function mount(node: React.ReactNode) { const host=dom.document.createElement("div");dom.document.body.append(host);root=createRoot(host as unknown as HTMLElement);await act(async()=>root!.render(<MemoryRouter>{node}</MemoryRouter>)); return host; }
it("shows all report sections, pinned evidence and author decisions without changing prose",async()=>{
  const review=manuscriptReviewFixture(), decisions: unknown[][]=[], evidence: unknown[]=[];
  const host=await mount(<ManuscriptReviewReport review={review} onDecision={(...args)=>decisions.push(args)} onEvidence={cite=>evidence.push(cite)} />);
  assert.equal(host.querySelectorAll("h2").length,6); assert.match(host.textContent??"",/2\/2 chapters fully supplied/);
  const buttons=[...host.querySelectorAll("button")];
  await act(async()=>{buttons.find(b=>b.textContent==="Keep intentionally")!.click();buttons.find(b=>b.textContent?.startsWith("Open supporting passage"))!.click();});
  assert.deepEqual(decisions,[["finding","intentional"]]);assert.deepEqual(evidence,[review.findings[0]!.citations[0]]);
  assert.match(host.textContent??"",/not an age classification/);
});
it("distinguishes partial coverage and disables decisions only for changed evidence",async()=>{
  const review=manuscriptReviewFixture();review.status="partial";delete review.synthesis;review.tasks[1]!.state="interrupted";delete review.tasks[1]!.reading;review.findings[0]!.stale=true;
  const host=await mount(<ManuscriptReviewReport review={review} onDecision={()=>assert.fail()} onEvidence={()=>{}} />);
  assert.match(host.textContent??"",/No complete manuscript review is claimed/);assert.match(host.textContent??"",/1\/2 chapters fully supplied/);
  assert.equal([...host.querySelectorAll("button")].find(b=>b.textContent==="Mark resolved")!.hasAttribute("disabled"),true);
});
it("starts with an explicit brief and keeps a new review selected when an older result arrives late",async()=>{
  const sent: ClientMessage[]=[];__setBridgeForTest({send:(json:string)=>sent.push(JSON.parse(json))} as unknown as ArkeBridge);
  __setStateForTest(FIXTURE_STATE,{connection:"open"});
  const review=manuscriptReviewFixture();
  await mount(<ManuscriptReviewControl worldId={review.worldId} productionId={review.productionId} chapters={2} words={3900}/>);
  const button=(text:string)=>[...dom.document.querySelectorAll("button")].find(b=>b.textContent===text)!;
  await act(async()=>{button("Review manuscript").click();});
  await act(async()=>{__applyEventForTest({type:"manuscript-review.updated",at:review.updatedAt,worldId:review.worldId,productionId:review.productionId,review,history:[{id:review.id,title:review.title,createdAt:review.createdAt,status:review.status}]});});
  await act(async()=>{button("Start a new review").click();});
  const command=sent.findLast(message=>message.kind==="manuscript-review-start");
  assert.equal(command?.kind,"manuscript-review-start");if(command?.kind!=="manuscript-review-start")return;
  assert.equal(command.brief,review.brief);
  const running={...review,id:command.requestId,status:"running" as const,updatedAt:"2026-11-02T00:02:00Z"};
  await act(async()=>{__applyEventForTest({type:"manuscript-review.updated",at:running.updatedAt,worldId:review.worldId,productionId:review.productionId,review:running,history:[]});});
  await act(async()=>{__applyEventForTest({type:"manuscript-review.updated",at:review.updatedAt,worldId:review.worldId,productionId:review.productionId,review,history:[]});});
  assert.match(dom.document.body.textContent??"",/Stop review/);
  assert.ok(dom.document.body.textContent?.includes(command.requestId));
});
it("opens the original supporting passage at its chapter and labels changed source versions",async()=>{
  const cite=manuscriptReviewFixture().findings[0]!.citations[0]!;
  const host=dom.document.createElement("div");dom.document.body.append(host);root=createRoot(host as unknown as HTMLElement);
  await act(async()=>root!.render(<MemoryRouter initialEntries={[{pathname:"/chapter",state:{manuscriptReviewPassage:cite}}]}><ManuscriptReviewPassage chapterId="one" hash="changed" /></MemoryRouter>));
  assert.equal(host.querySelector("blockquote")?.textContent,cite.quote);assert.match(host.textContent??"",/chapter has changed/);
});
