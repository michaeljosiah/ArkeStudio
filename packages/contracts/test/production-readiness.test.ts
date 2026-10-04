import assert from "node:assert/strict";
import { it } from "node:test";
import { deriveProductionReadiness, ProductionBundleSchema, ProductionReadinessSchema, ProductionPlanRequestSchema, SheetSchema,
  TakeSchema, newId, seedStoryPictureTimeline, applyTimelineCommands, type ReadinessWorld, type ProductionBundle } from "../src/index.js";

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
