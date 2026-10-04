import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { deriveProductionReadiness, type ProductionPlanCard } from "@arke-studio/contracts";
import { ProductionPlanCardView } from "../src/components/production-plan-card.js";
import { __setStateForTest, __applyEventForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis,{window:dom.window,document:dom.document,HTMLElement:dom.HTMLElement,Node:dom.Node,Event:dom.Event,IS_REACT_ACT_ENVIRONMENT:true});
let root: Root | null = null;
afterEach(async ()=>{ await act(async ()=>root?.unmount()); root=null; __setStateForTest(FIXTURE_STATE); dom.document.body.innerHTML=""; });

it("derives the live checklist despite a completed card snapshot and offers no approval control", async ()=>{
  const state = structuredClone(FIXTURE_STATE), world=state.world!, production=world.productions[0]!;
  const card: ProductionPlanCard = {kind:"production-plan",worldId:world.meta.worldId,productionId:production.meta.id,nextSteps:["Select the missing takes."],
    readiness:{...deriveProductionReadiness(world,production),ready:true},exports:[]};
  const container = dom.document.createElement("div") as unknown as HTMLElement; dom.document.body.append(container); root=createRoot(container);
  await act(async ()=>{ __setStateForTest(state); root!.render(<ProductionPlanCardView card={card}/>); });
  assert.equal(container.querySelectorAll("button").length,0);
  const selection = ()=>[...container.querySelectorAll("li")].find(li=>li.textContent?.includes("Selected takes"))!;
  const before = selection().innerHTML;
  const changed = structuredClone(state); changed.world!.productions[0]!.selections={};
  await act(async ()=>__setStateForTest(changed));
  assert.ok(selection().querySelector('[aria-label="Incomplete"]'));
  assert.notEqual(selection().innerHTML,before,"Canonical state updates refresh the checklist");
  assert.match(container.textContent!,/Select the missing takes/);
  assert.equal(container.textContent!.includes("Approve"),false);
  await act(async ()=>root!.render(<ProductionPlanCardView card={{...card,worldId:"another-world"}}/>));
  assert.match(container.textContent!,/production is unavailable/);
  assert.equal(container.textContent!.includes("Selected takes"),false);
});

it("does not re-derive a plan when unrelated export percentage state changes", async ()=>{
  const state=structuredClone(FIXTURE_STATE),world=state.world!,production=world.productions[0]!,takes=production.takes;
  let reads=0; Object.defineProperty(production,"takes",{enumerable:true,get(){reads++;return takes;}});
  const card: ProductionPlanCard={kind:"production-plan",worldId:world.meta.worldId,productionId:production.meta.id,nextSteps:[],readiness:null,exports:[]};
  const container=dom.document.createElement("div") as unknown as HTMLElement; dom.document.body.append(container); root=createRoot(container);
  await act(async()=>{__setStateForTest(state);root!.render(<ProductionPlanCardView card={card}/>);});
  const initialReads=reads; assert.ok(initialReads>0);
  for(let percent=1;percent<=3;percent++) await act(async()=>__applyEventForTest({type:"export.progress",at:"2026-10-04T00:00:00Z",worldId:world.meta.worldId,productionId:production.meta.id,exportId:"export",deliveryKind:"video",status:"running",percent,output:null,error:null}));
  assert.equal(reads,initialReads,"World and card export inputs retained their identity");
  await act(async()=>root!.render(<ProductionPlanCardView card={{...card,exports:[{id:"new",worldId:world.meta.worldId,productionId:production.meta.id,status:"running",deliveryKind:"video"}]}}/>));
  assert.ok(reads>initialReads,"A new export lifecycle record refreshes readiness");
});
