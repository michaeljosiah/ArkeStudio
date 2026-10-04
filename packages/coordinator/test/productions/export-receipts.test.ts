import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { productionExportFingerprint, type ReadinessExport, type DomainEvent, type ClientMessage } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { assembleStory } from "./assemble.js";
import type { ChangeLog } from "../../src/change-log.js";
import { recordCompletedExport, readCompletedExports } from "../../src/productions/export-receipts.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld, WORLD_ID } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

it("retains a completed delivery independently of diagnostic logs without rewriting world records", async () => {
  const dir=await makeTempWorld(),store=await WorldStore.open(dir); closeOnCleanup(()=>store.close());
  const meta=await readFile(join(dir,"world.json"),"utf8");
  assert.deepEqual(await readCompletedExports(store),[]);
  await assert.rejects(stat(join(dir,"exports/.completed")),{code:"ENOENT"});
  await mkdir(join(dir,"exports"),{recursive:true}); await writeFile(join(dir,"exports/film.mp4"),"completed video");
  const record:ReadinessExport={id:"ex_complete",worldId:WORLD_ID,productionId:"saltlight",status:"done",createdAt:"2026-10-04T00:00:00Z",output:"exports/film.mp4",deliveryKind:"video",sourceFingerprint:"production-export-v1:source"};
  await recordCompletedExport(store,record); await recordCompletedExport(store,record);
  assert.deepEqual(await readCompletedExports(store),[record]);
  assert.equal(await readFile(join(dir,"world.json"),"utf8"),meta,"The operational export receipt does not raise the schema floor");
  await assert.rejects(recordCompletedExport(store,{...record,sourceFingerprint:"another source"}),/identity-conflict/);
  await assert.rejects(recordCompletedExport(store,{...record,worldId:"01J8F3K2QW9VZX4N7M0RTYB6HD"}),/world-mismatch/);
  await assert.rejects(recordCompletedExport(store,{...record,id:"../escape"}));
  await writeFile(join(dir,"exports/.completed/broken.json"),"{torn receipt");
  assert.deepEqual(await readCompletedExports(store),[record]);
  await rm(join(dir,"exports/film.mp4")); assert.deepEqual(await readCompletedExports(store),[],"An absent output cannot be recovered as delivered");
  await store.close(); await assert.rejects(recordCompletedExport(store,{...record,id:"ex_late"}));
});

it("refuses a partial interactive package even when a receipt claims completion", async () => {
  const dir=await makeTempWorld(),store=await WorldStore.open(dir); closeOnCleanup(()=>store.close());
  const id="iv_01J8F3K2QW9VZX4N7M0RTYB6HC",output=`exports/interactive-saltlight-${id}`;
  await mkdir(join(dir,output),{recursive:true}); await writeFile(join(dir,output,"player.html"),"partial player");
  await recordCompletedExport(store,{id,worldId:WORLD_ID,productionId:"saltlight",status:"done",createdAt:"2026-10-04T00:00:00Z",output,deliveryKind:"interactive",sourceFingerprint:"production-export-v1:source"});
  assert.deepEqual(await readCompletedExports(store),[]);
});

it("publishes native legacy and saved-timeline video completion only after the world receipt lands", async () => {
  const dir=await makeTempWorld(),store=await WorldStore.open(dir); closeOnCleanup(()=>store.close());
  const events:DomainEvent[]=[];
  await store.ownedWrite(()=>rm(join(dir,"productions/saltlight/timeline.json"),{force:true}));
  const coordinator=new Coordinator({provider:{listWorlds:async()=>[],loadWorld:async()=>store.getBundle(),openStore:()=>store},adapter:null,appVersion:"test",changeLogPath:join(dir,".cache/test-events.jsonl"),observeEvent:event=>{events.push(event);},
    ffmpeg:{slateFont:"/font.ttf",run:async(args,onProgress)=>{onProgress(50);await writeFile(args.at(-1)!,"encoded video");}}});
  const host=coordinator as unknown as {handleClientMessage(message:ClientMessage):Promise<void>;backgroundWork:Set<Promise<unknown>>;changeLog:ChangeLog};
  for(const saved of [false,true]) {
    let production=store.getBundle().productions.find(p=>p.meta.id === "saltlight")!;
    if(saved) { await assembleStory(store,production.meta.id); production=store.getBundle().productions.find(p=>p.meta.id === "saltlight")!; }
    const fingerprint=productionExportFingerprint(store.getBundle(),production),before=events.length;
    await host.handleClientMessage({kind:"export-cut",worldId:WORLD_ID,productionId:production.meta.id,preset:"review-cut",timelineRevision:production.timeline?.status === "ready" ? production.timeline.timeline.revision : null});
    await Promise.all(host.backgroundWork);
    const done=events.slice(before).find((event):event is Extract<DomainEvent,{type:"export.progress"}>=>event.type === "export.progress" && event.status === "done");
    assert.ok(done,JSON.stringify(events.slice(before)));
    const records=await readCompletedExports(store),record=records.find(record=>record.id === done.exportId)!;
    assert.equal(record.sourceFingerprint,fingerprint); assert.equal(record.deliveryKind,"video"); assert.equal(record.output,done.output);
  }
  await host.changeLog.drain();
});
