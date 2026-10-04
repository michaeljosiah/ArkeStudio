import assert from "node:assert/strict";
import { it } from "node:test";
import { deriveProductionReadiness, ProductionBundleSchema, ProductionReadinessSchema, ProductionPlanRequestSchema, SheetSchema,
  TakeSchema, ArtifactSidecarSchema, RoutingSchema, PerformanceRecordSchema, performanceLineKey, productionExportFingerprint,
  newId, seedStoryPictureTimeline, applyTimelineCommands, type ReadinessWorld, type ProductionBundle } from "../src/index.js";

const WORLD = "01J8F3K2QW9VZX4N7M0RTYB6HC", AT = "2026-10-04T00:00:00Z";
function world(): ReadinessWorld { return { meta: { worldId: WORLD }, sheets: [], props: [], artifacts: [], referenceKits: [] }; }
function production(): ProductionBundle {
  return ProductionBundleSchema.parse({ meta: { id: "film", title: "Film", format: "video", status: "in-progress", created: AT, updated: AT, failureModes: [] },
    story: null, treatment: null, chapters: [], scenes: [{ id: "sc_one", slug: "one", status: "draft", number: 1, title: "One", version: 1, shots: [{ id: "sh_one", number: 1, title: "Shot", description: "The sea." }], script: { blocks: [{ id: "blk_one", kind: "action", text: "The sea rises." }] } }],
    takes: [], reviews: [], selections: {} });
}
function take(kind: "clip" | "frame" | "voice", shotId = "sh_one") {
  return TakeSchema.parse({ id: newId("tk"), kind, coversShots: [shotId], provider: "test", model: "test", media: kind === "clip" ? "video.mp4" : kind === "frame" ? "frame.png" : "voice.wav",
    provenance: { canonRevision: 1, sheets: {}, sceneId: "sc_one", sceneVersion: 1 }, cost: { estimatedMicroUsd: 0, actualMicroUsd: 0 }, dispatchedAt: AT });
}
const sceneCheck = (p: ProductionBundle, key: string, w = world()) => deriveProductionReadiness(w,p).scenes[0]!.checks.find(c => c.key === key)!;
function scene(p: ProductionBundle) { const result = p.scenes[0]!; assert.ok("shots" in result); return result; }
function image(w: ReadinessWorld) {
  const result = ArtifactSidecarSchema.parse({id:newId("ar"),kind:"image",file:"frame.png",hash:`sha256:${"a".repeat(64)}`,
    origin:{by:"system",producedBy:"accepted-still"},links:["film","sh_one"],production:"film",created:AT});
  w.artifacts.push(result); return result;
}
function doneExport(w: ReadinessWorld,p: ProductionBundle) { return {id:"done",worldId:w.meta.worldId,productionId:p.meta.id,
  status:"done" as const,createdAt:AT,output:"exports/film.mp4",sourceFingerprint:productionExportFingerprint(w,p)}; }

it("uses the accepted artifact slot written by still acceptance and refuses retired or foreign images", () => {
  const p=production(),w=world(),artifact=image(w); p.meta.format="stills";
  p.selections.sh_one={acceptedTakeId:null,trimInSec:0,startFrameArtifactId:artifact.id};
  assert.equal(sceneCheck(p,"selected-takes",w).status,"ready"); assert.equal(sceneCheck(p,"start-frames",w).status,"ready");
  const stills=deriveProductionReadiness(w,p,[doneExport(w,p)]);
  assert.equal(stills.ready,true,"Native Stills delivery needs no video timeline or subtitle track");
  assert.equal(stills.scenes[0]!.checks.find(check=>check.key === "in-cut")!.status,"not-required");
  p.timeline={status:"invalid",message:"An unused video timeline"};
  assert.equal(deriveProductionReadiness(w,p,[doneExport(w,p)]).ready,true);
  p.meta.format="video"; p.meta.kind="stills"; assert.equal(deriveProductionReadiness(w,p,[doneExport(w,p)]).ready,true);
  artifact.retiredAt=AT; assert.equal(sceneCheck(p,"selected-takes",w).status,"missing");
  delete artifact.retiredAt; artifact.production="other"; assert.equal(sceneCheck(p,"selected-takes",w).status,"missing");
});

it("requires valid current routing for ordinary interactive video as well as beat playback", () => {
  const p=production(); p.meta.kind="interactive";
  const check=()=>deriveProductionReadiness(world(),p).checks.find(c=>c.key === "routing")!;
  assert.equal(check().status,"missing");
  p.scenes.push({...structuredClone(p.scenes[0]!),id:"sc_end",number:2,slug:"end",shots:[{id:"sh_end",number:1,title:"End",description:"Sea."}]});
  p.routing=RoutingSchema.parse({version:1,start:"sc_one",choices:[{id:"ch_go",from:"sc_one",to:"sc_end",label:"Go"}],endings:[{sceneId:"sc_end",title:"End"}],excluded:[],groups:[]});
  assert.equal(check().status,"missing");
  p.routingTraversals=[{ts:AT,routingVersion:1,choiceId:"ch_go",from:"sc_one",to:"sc_end",route:["sc_one"]}];
  assert.equal(check().status,"ready");
  p.scenes.push({id:"sc_unused",number:3,slug:"unused",title:"Unused",status:"draft",version:1,shots:[]});
  p.routing.excluded.push({sceneId:"sc_unused",reason:"Alternate draft"}); p.timeline={status:"ready",timeline:seedStoryPictureTimeline(p)};
  assert.equal(deriveProductionReadiness(world(),p).checks.find(c=>c.key === "cut")!.status,"ready","Excluded branching drafts do not demand cut placement");
  p.routing.choices[0]!.to="sc_one"; assert.equal(check().status,"missing");
});

it("derives Visual Novel readiness from beat pictures, text and routing without a video cut or voices", () => {
  const p=production(),w=world(),artifact=image(w); p.meta.kind="visual-novel";
  scene(p).shots[0]!.covers=[{blockId:"blk_one",textDigest:"sha256:12345678"}];
  p.selections.sh_one={acceptedTakeId:null,trimInSec:0,startFrameArtifactId:artifact.id};
  p.routing=RoutingSchema.parse({version:1,start:"sc_one",choices:[],endings:[{sceneId:"sc_one",title:"End"}],excluded:[],groups:[]});
  const readiness=deriveProductionReadiness(w,p,[doneExport(w,p)]); assert.equal(readiness.ready,true);
  scene(p).shots.push({id:"sh_held",number:2,title:"Held",description:"",beat:{samePicture:true}});
  assert.equal(sceneCheck(p,"selected-takes",w).status,"ready"); assert.equal(sceneCheck(p,"start-frames",w).status,"ready");
  p.scenes.push({id:"sc_unused",number:2,slug:"unused",title:"Unused",status:"draft",version:1,shots:[]});
  p.routing.excluded.push({sceneId:"sc_unused",reason:"Alternate draft"});
  assert.equal(deriveProductionReadiness(w,p,[doneExport(w,p)]).ready,true,"An explicitly excluded draft does not block the playable novel");
  assert.equal(readiness.checks.find(c=>c.key === "cut")!.status,"not-required"); assert.equal(readiness.checks.find(c=>c.key === "subtitles")!.status,"not-required");
  assert.equal(readiness.scenes[0]!.checks.find(c=>c.key === "dialogue-voiced")!.status,"not-required");
  scene(p).shots[0]!.covers=[]; assert.equal(sceneCheck(p,"beat-text",w).status,"missing");
  p.routing.start="sc_absent"; assert.equal(deriveProductionReadiness(w,p).checks.find(c=>c.key === "routing")!.status,"missing");
});

it("requires saved prose in every current book chapter even after a completed export", () => {
  const p=production(),w=world(); p.meta.format="story"; p.scenes=[];
  const empty=deriveProductionReadiness(w,p,[doneExport(w,p)]); assert.equal(empty.ready,false); assert.equal(empty.checks.find(c=>c.key === "chapters")!.status,"missing");
  p.chapters=[{id:"one",file:"one.md",order:1,title:"One",status:"draft",version:1,words:250,bodyHash:"prose"}];
  assert.equal(deriveProductionReadiness(w,p,[doneExport(w,p)]).ready,true);
  p.chapters[0]!.words=0; assert.equal(deriveProductionReadiness(w,p,[doneExport(w,p)]).ready,false);
  p.chapters[0]!.retired=true; assert.equal(deriveProductionReadiness(w,p,[doneExport(w,p)]).ready,false);
});

it("invalidates delivery after a selected source or saved timeline changes and distrusts unstamped exports", () => {
  const p=production(),w=world(),clip=take("clip"); p.takes.push(clip); p.selections.sh_one={acceptedTakeId:clip.id,trimInSec:0};
  p.timeline={status:"ready",timeline:seedStoryPictureTimeline(p)};
  const exported=doneExport(w,p),check=()=>deriveProductionReadiness(w,p,[exported]).checks.find(c=>c.key === "export")!;
  assert.equal(check().status,"ready");
  const unused=take("clip"); p.takes.push(unused); assert.equal(check().status,"ready","An unused candidate does not change delivery");
  p.selections.sh_one.acceptedTakeId=unused.id; assert.equal(check().status,"missing"); p.selections.sh_one.acceptedTakeId=clip.id;
  p.timeline.timeline=applyTimelineCommands(p.timeline.timeline,[{kind:"set-track",trackId:p.timeline.timeline.tracks[0]!.id,muted:true}]);
  assert.equal(check().status,"missing");
  assert.equal(deriveProductionReadiness(w,p,[{...doneExport(w,p),sourceFingerprint:undefined}]).checks.find(c=>c.key === "export")!.status,"missing");
});

it("excludes muted subtitle cues and shot sources placed only on an upper Picture track", () => {
  const p=production(); p.timeline={status:"ready",timeline:seedStoryPictureTimeline(p)};
  const base=p.timeline.timeline.tracks[0]!,shotClip=structuredClone(base.clips[0]!); base.clips=[];
  p.timeline.timeline.tracks.push({id:"tr_overlay",kind:"picture",name:"Overlay",order:1,muted:false,clips:[shotClip]});
  assert.equal(sceneCheck(p,"in-cut").status,"missing");
  p.timeline.timeline.tracks.push({id:"tr_subtitles",kind:"subtitle",name:"Subtitles",order:2,muted:false,clips:[],language:"en",cues:[{id:"cu_line",startFrame:0,endFrame:24,text:"The sea rises."}]});
  const check=()=>deriveProductionReadiness(world(),p).checks.find(c=>c.key === "subtitles")!;
  assert.equal(check().status,"ready"); p.timeline.timeline.tracks.at(-1)!.muted=true; assert.equal(check().status,"missing");
});

it("requires a current accepted performance to be placed on an audible timeline track", () => {
  const p=production(); scene(p).script={blocks:[{id:"blk_line",kind:"dialogue",speaker:"maren",text:"Go."}]}; scene(p).shots[0]!.covers=[{blockId:"blk_line",textDigest:"sha256:12345678"}];
  const id=newId("pf"),hash=`sha256:${"b".repeat(64)}`,technical={container:"wav",codec:"pcm_s16le",sampleFormat:"s16",sampleRateHz:48000,channels:1,bitDepth:16,durationSec:1,sizeBytes:96044};
  const target={productionId:"film",sceneId:"sc_one",shotId:"sh_one",blockId:"blk_line",sceneVersion:1,speakerSheetId:"maren",authoredTextHash:hash};
  const report={schemaVersion:1,sourceHash:hash,analyzer:{id:"arke-pcm-qc",version:1,policyVersion:1},analyzedAt:AT,technical,
    measurements:{samplePeakDbfs:null,rmsDbfs:null,fullScaleSampleCount:null,leadingSilenceSec:null,trailingSilenceSec:null,longestInternalSilenceSec:null,dcOffset:null},
    checks:Object.fromEntries(["decode","duration","technicalFormat","clipping","silence","dcOffset","truePeak","lufs","noiseFloor","snr","speechPresence","musicLikelihood","multipleSpeakers","transcriptMatch"].map(key=>[key,{outcome:"pass",code:"test"}]))};
  const performance=PerformanceRecordSchema.parse({id,kind:"scratch",target,file:`sha256-${"b".repeat(64)}.wav`,createdAt:AT,recordedAt:AT,captureAcknowledgement:{basis:"self",statementVersion:1,at:AT},
    provenance:{schemaVersion:1,source:{kind:"performance-recording",productionId:"film",performanceId:id,sourceFile:"capture.wav",sourceMediaHash:hash},sourceTechnical:technical,outputHash:hash,outputTechnical:technical,preparation:[],qualityReport:report,createdAt:AT}});
  p.performances.push(performance); p.performanceReview.selections[performanceLineKey(target)]={performanceId:id,target,selectedAt:AT,selectedBy:"user"};
  p.performanceReview.reviews.push({requestId:WORLD,ts:AT,performanceId:id,target,decision:"accept",by:"user"});
  const delivery=doneExport(world(),p), selection=p.performanceReview.selections[performanceLineKey(target)]!;
  selection.performanceId=newId("pf");
  assert.equal(deriveProductionReadiness(world(),p,[delivery]).checks.find(check=>check.key === "export")!.status,"missing","Changing a selected beat voice invalidates delivery before it is placed in a video timeline");
  selection.performanceId=id;
  p.timeline={status:"ready",timeline:seedStoryPictureTimeline(p)}; assert.equal(sceneCheck(p,"dialogue-voiced").status,"missing");
  p.timeline.timeline.tracks.push({id:"tr_dialogue",kind:"dialogue",name:"Dialogue",order:1,muted:false,clips:[{id:"cl_voice",startFrame:0,durationFrames:24,sourceInFrames:0,
    source:{kind:"performance",performanceId:id,shotId:"sh_one",label:"Maren",sourceHash:hash,leadInSec:0,timing:{postHandle:{kind:"tail",durationSec:0},overflow:{mode:"forbid"}}}}]});
  assert.equal(sceneCheck(p,"dialogue-voiced").status,"ready"); p.timeline.timeline.tracks.at(-1)!.muted=true; assert.equal(sceneCheck(p,"dialogue-voiced").status,"missing");
  p.timeline.timeline.tracks.at(-1)!.muted=false;
  const placement=p.timeline.timeline.tracks.at(-1)!.clips[0]!, picture=p.timeline.timeline.tracks[0]!.clips[0]!;
  placement.startFrame=24; assert.equal(sceneCheck(p,"dialogue-voiced").status,"missing"); placement.startFrame=0;
  placement.sourceInFrames=12; assert.equal(sceneCheck(p,"dialogue-voiced").status,"missing"); placement.sourceInFrames=0;
  placement.durationFrames=12; assert.equal(sceneCheck(p,"dialogue-voiced").status,"missing"); placement.durationFrames=24;
  picture.startFrame=24; assert.equal(sceneCheck(p,"dialogue-voiced").status,"missing"); picture.startFrame=0;
  scene(p).shots.push({...structuredClone(scene(p).shots[0]!),id:"sh_second",number:2});
  const continued=sceneCheck(p,"dialogue-voiced"); assert.equal(continued.total,1,"The rehearsal reads a covered block once across a cut"); assert.equal(continued.status,"ready");
});

it("does not confuse a produced frame, claimed completion or dangling selection with a selected take", () => {
  const p = production(), frame = take("frame"); p.takes.push(frame); p.meta.status = "complete";
  assert.equal(sceneCheck(p,"start-frames").status,"missing");
  assert.equal(sceneCheck(p,"selected-takes").status,"missing");
  p.selections.sh_one = { acceptedTakeId: frame.id, trimInSec: 0 };
  assert.equal(sceneCheck(p,"start-frames").status,"ready");
  assert.equal(sceneCheck(p,"selected-takes").status,"missing","A film needs a video selection");
  const clip = take("clip"); p.takes.push(clip); p.selections.sh_one.acceptedTakeId = clip.id;
  assert.equal(sceneCheck(p,"selected-takes").status,"ready");
  delete clip.media; assert.equal(sceneCheck(p,"selected-takes").status,"missing");
  p.selections.sh_one.acceptedTakeId = newId("tk"); assert.equal(sceneCheck(p,"selected-takes").status,"missing");
  assert.equal(deriveProductionReadiness(world(),p).ready,false);
});
it("resolves named cast and places, refuses retired sheets and requires usable cast references", () => {
  const p = production(), w = world(); scene(p).shots[0]!.description = "@maren waits at @harbour.";
  for (const [id,type] of [["maren","character"],["harbour","location"]] as const) w.sheets.push(SheetSchema.parse({ id, type, name: id, version: 1, status: "locked", canonRules: [], links: [], created: AT, updated: AT, sections: [] }));
  assert.equal(sceneCheck(p,"cast",w).status,"ready"); assert.equal(sceneCheck(p,"place",w).status,"ready"); assert.equal(sceneCheck(p,"kits",w).status,"missing");
  w.sheets[0]!.retired = true; assert.equal(sceneCheck(p,"cast",w).status,"missing");
  w.sheets[1]!.retired = true; assert.equal(sceneCheck(p,"place",w).status,"missing");
});
it("uses saved picture placement and blocks an invalid timeline", () => {
  const p = production(); assert.equal(sceneCheck(p,"in-cut").status,"missing");
  p.timeline = { status: "ready", timeline: seedStoryPictureTimeline(p) };
  assert.equal(sceneCheck(p,"in-cut").status,"ready");
  p.timeline.timeline = applyTimelineCommands(p.timeline.timeline,[{kind:"set-track",trackId:p.timeline.timeline.tracks[0]!.id,muted:true}]);
  assert.equal(sceneCheck(p,"in-cut").status,"missing");
  p.timeline = {status:"invalid",message:"Damaged timeline"};
  assert.equal(deriveProductionReadiness(world(),p).checks.find(c=>c.key==="cut")!.status,"blocked");
});
it("counts only current legacy voice placements and refuses an older scene's line", () => {
  const p = production(), voice = take("voice"); delete p.scenes[0]!.script;
  scene(p).shots[0]!.audio = {kind:"dialogue",speaker:"maren",line:"Go."};
  p.takes.push(voice); p.cut.audio.push({kind:"dialogue",label:"Dialogue",entries:[{shotId:"sh_one",sheetId:"maren",takeId:voice.id,offsetSec:0}]});
  assert.equal(sceneCheck(p,"dialogue-voiced").status,"ready");
  p.timeline={status:"ready",timeline:seedStoryPictureTimeline(p)};
  const other=take("voice"); p.takes.push(other);
  const track={id:"tr_voice" as const,kind:"dialogue" as const,name:"Voice",order:1,muted:false,clips:[{id:"cl_voice" as const,startFrame:0,durationFrames:24,sourceInFrames:0,source:{kind:"take" as const,takeId:other.id,label:"Voice"}}]};
  p.timeline.timeline.tracks.push(track); assert.equal(sceneCheck(p,"dialogue-voiced").status,"missing","Another voice take cannot stand in for the chosen placement");
  track.clips[0]!.source.takeId=voice.id; assert.equal(sceneCheck(p,"dialogue-voiced").status,"ready");
  p.scenes[0]!.version++; assert.equal(sceneCheck(p,"dialogue-voiced").status,"missing");
});
it("reports an authored dialogue block with no shot coverage as unvoiced", () => {
  const p = production(); scene(p).script = {blocks:[{id:"blk_line",kind:"dialogue",speaker:"maren",text:"Go."}]};
  const result = sceneCheck(p,"dialogue-voiced");
  assert.equal(result.status,"missing"); assert.equal(result.total,1);
  assert.deepEqual(result.missingIds,["uncovered/blk_line"]);
});
it("reports the last full production export by time and excludes foreign and episode records", () => {
  const p = production(), w = world(), before = JSON.stringify({w,p});
  const exports = [{id:"z",worldId:WORLD,productionId:"film",status:"done" as const,createdAt:AT,output:"exports/film.mp4"},
    {id:"a",worldId:WORLD,productionId:"film",status:"running" as const,createdAt:"2026-10-04T01:00:00Z",output:null},
    {id:"other",worldId:WORLD,productionId:"other",status:"done" as const,createdAt:"2026-10-05T00:00:00Z",output:"exports/other.mp4"},
    {id:"episode",worldId:WORLD,productionId:"film",episodeId:"one",status:"done" as const,createdAt:"2026-10-06T00:00:00Z",output:"exports/episode.mp4"}];
  const result = ProductionReadinessSchema.parse(deriveProductionReadiness(w,p,exports));
  assert.equal(result.lastExport?.id,"a"); assert.equal(result.checks.find(c=>c.key==="export")!.status,"missing");
  assert.equal(JSON.stringify({w,p}),before,"Reading readiness does not mutate any input");
});
it("bounds missing examples without losing counts and accepts suggestions without authority fields", () => {
  const p = production(); scene(p).shots = Array.from({length:80},(_,i)=>({id:`sh_${i}`,number:i+1,title:`Shot ${i}`,description:"Sea."}));
  const result = sceneCheck(p,"selected-takes"); assert.equal(result.total,80); assert.equal(result.completed,0); assert.equal(result.missingIds.length,40); assert.match(result.detail,/first 40 of 80/);
  const request = {productionId:"film",checkReceiptIds:[newId("check")],nextSteps:["Select the missing takes."]};
  assert.ok(ProductionPlanRequestSchema.safeParse(request).success);
  assert.equal(ProductionPlanRequestSchema.safeParse({...request,ready:true}).success,false);
  assert.equal(ProductionPlanRequestSchema.safeParse({...request,approve:true}).success,false);
});
