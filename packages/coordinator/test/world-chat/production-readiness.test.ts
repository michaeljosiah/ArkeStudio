import assert from "node:assert/strict";
import { it } from "node:test";
import { deriveProductionReadiness, newId, type WorldChatCheckReceipt } from "@arke-studio/contracts";
import { fixtureBundle } from "../index-db/helpers.js";
import { validateProductionPlan, projectProductionPlan } from "../../src/world-chat/production-readiness.js";
import { productionReadinessFence } from "../../src/world-chat/target-reads.js";

it("refuses a plan for another production or stale readiness and projects the current checklist", async () => {
  const bundle = await fixtureBundle(), production = bundle.productions.find(p=>p.meta.id === "saltlight")!;
  const request = {productionId:"saltlight",checkReceiptIds:[newId("check")],nextSteps:["Select the missing takes."]};
  const receipt: WorldChatCheckReceipt = {id:request.checkReceiptIds[0]!,runId:newId("run"),tool:"target-read",status:"complete",consulted:[],
    target:{requirement:"readiness",id:"saltlight"},complete:true,nextCursor:null,at:"2026-10-04T00:00:00Z",
    observedRevisionOrDigest:productionReadinessFence(deriveProductionReadiness(bundle,production))};
  const context = {kind:"production" as const,productionId:"saltlight"};
  validateProductionPlan(bundle,[],request,context,[receipt]);
  assert.throws(()=>validateProductionPlan(bundle,[],request,{...context,productionId:"other"},[receipt]),/thread's production/);
  assert.throws(()=>validateProductionPlan(bundle,[],request,context,[{...receipt,status:"failed"}]),/fresh complete/);
  const initial = projectProductionPlan(bundle,[],request);
  production.scenes[0]!.script = {blocks:[{id:"blk_new",kind:"action",text:"A new script."}]};
  assert.throws(()=>validateProductionPlan(bundle,[],request,context,[receipt]),/fresh complete/);
  const refreshed = projectProductionPlan(bundle,[],request);
  assert.notDeepEqual(refreshed.readiness,initial.readiness);
  assert.deepEqual(refreshed.nextSteps,request.nextSteps);
  assert.equal("approve" in refreshed,false);
  assert.equal("actions" in refreshed,false);
});
