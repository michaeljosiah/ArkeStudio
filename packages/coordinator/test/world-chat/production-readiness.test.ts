import assert from "node:assert/strict";
import { it } from "node:test";
import { deriveProductionReadiness, productionExportFingerprint, newId, WorldChatWorkspaceSchema, type WorldChatCheckReceipt } from "@arke-studio/contracts";
import { fixtureBundle } from "../index-db/helpers.js";
import { validateProductionPlan, projectProductionPlan, refreshProductionPlanCards } from "../../src/world-chat/production-readiness.js";
import { productionReadinessFence } from "../../src/world-chat/target-reads.js";
import { Coordinator } from "../../src/coordinator.js";
import type { ReadModel } from "../../src/read-model.js";
import type { ChangeLog } from "../../src/change-log.js";
import { join } from "node:path";
import { tempDir } from "../tmp.js";

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

it("refreshes an open plan's export check without rereading or writing its conversation", async () => {
  const bundle = await fixtureBundle(), request = {productionId:"saltlight",nextSteps:["Export the cut."]}, at="2026-10-04T00:00:00Z";
  const workspace = WorldChatWorkspaceSchema.parse({conversationId:newId("cv"),status:"open",points:[],attachments:[],messages:[{id:newId("msg"),role:"studio",text:"Plan",createdAt:at,receipts:[],
    productionPlan:projectProductionPlan(bundle,[],request)}]});
  const done = {id:"export",worldId:bundle.meta.worldId,productionId:"saltlight",status:"done" as const,output:"exports/film.mp4",createdAt:at,
    sourceFingerprint:productionExportFingerprint(bundle,bundle.productions.find(p=>p.meta.id === "saltlight")!)};
  const refreshed = refreshProductionPlanCards(workspace,bundle,[done]);
  assert.equal(refreshed.messages[0]!.productionPlan!.readiness!.checks.find(c=>c.key === "export")!.status,"ready");
  assert.equal(workspace.messages[0]!.productionPlan!.readiness!.checks.find(c=>c.key === "export")!.status,"missing","Projection does not mutate its input");
  assert.deepEqual(refreshed.messages[0]!.productionPlan!.nextSteps,request.nextSteps);
  const failed = refreshProductionPlanCards(refreshed,bundle,[{...done,status:"failed",output:null}]);
  assert.equal(failed.messages[0]!.productionPlan!.readiness!.checks.find(c=>c.key === "export")!.status,"missing");
});

it("broadcasts plan snapshots only when an export changes status, while retaining every progress event", async () => {
  const bundle=await fixtureBundle(),at="2026-10-04T00:00:00Z",production=bundle.productions.find(p=>p.meta.id === "saltlight")!;
  const request={productionId:"saltlight",nextSteps:["Export."]};
  const workspace=WorldChatWorkspaceSchema.parse({conversationId:newId("cv"),status:"open",points:[],attachments:[],messages:[{id:newId("msg"),role:"studio",text:"Plan",createdAt:at,receipts:[],productionPlan:projectProductionPlan(bundle,[],request)}]});
  let snapshots=0,events=0;
  const coordinator=new Coordinator({provider:{listWorlds:async()=>[],loadWorld:async()=>bundle},adapter:null,appVersion:"test",changeLogPath:join(await tempDir("readiness-progress"),"events.jsonl"),observeEvent:()=>events++});
  const host=coordinator as unknown as {readModel:ReadModel;transport:{broadcastSnapshot():void};changeLog:ChangeLog};
  host.readModel.setWorld(bundle); host.readModel.setWorldChat(workspace); host.transport.broadcastSnapshot=()=>{snapshots++;};
  const progress={at,type:"export.progress" as const,worldId:bundle.meta.worldId,productionId:"saltlight",exportId:"export",sourceFingerprint:productionExportFingerprint(bundle,production),status:"running" as const,percent:0,output:null,error:null};
  coordinator.emit(progress); assert.equal(snapshots,1);
  for(let percent=1;percent<=100;percent++) coordinator.emit({...progress,percent});
  assert.equal(snapshots,1,"percentage ticks do not rehash plans or resend the world"); assert.equal(events,101);
  coordinator.emit({...progress,status:"done",percent:100,output:"exports/film.mp4"}); assert.equal(snapshots,2);
  assert.equal(host.readModel.getState().worldChat!.messages[0]!.productionPlan!.readiness!.checks.find(c=>c.key === "export")!.status,"ready");
  coordinator.emit({...progress,exportId:"next"}); assert.equal(snapshots,3,"a new running export invalidates the previous delivered state immediately");
  assert.equal(host.readModel.getState().worldChat!.messages[0]!.productionPlan!.readiness!.checks.find(c=>c.key === "export")!.status,"missing");
  await host.changeLog.drain();
});
