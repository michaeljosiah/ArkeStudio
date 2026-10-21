import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lookCharacterHash, type DomainEvent, type IllustrationProposal } from "@arke-studio/contracts";
import { acceptCharacterLook } from "../../src/references/kit.js";
import { pngBytes } from "../queue/fake-provider.js";
import { audiobookPath, readAudiobook } from "../../src/productions/audiobook.js";
import { CHAPTER, LEDGER, WORLD_ID, withHarness, type Harness } from "./picture-harness.js";
const req = "01J00000000000000000000009";
const proposed = (h: Harness) => h.events.filter((event): event is Extract<DomainEvent, {type:"illustration.finished"}> => event.type === "illustration.finished").at(-1)!.proposal!;
const illustrate = (h: Harness) => h.send({ kind: "illustrate-chapter", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER });
const refresh = (h: Harness, proposal: IllustrationProposal) => h.send({ kind: "refresh-illustration-references", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER, proposalId: proposal.proposalId });
const accept = (h: Harness, proposal: IllustrationProposal, without: string[] = []) => h.send({ kind: "accept-illustration", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER, proposalId: proposal.proposalId, blocks: proposal.rows.map(row => row.block), without, confirmedMicroUsd: proposal.rows.reduce((sum,row)=>sum+row.estimatedMicroUsd,0) });
const refused = (h: Harness) => h.events.filter((event): event is Extract<DomainEvent,{type:"illustration.progress"}>=>event.type === "illustration.progress").at(-1)?.refused;

describe("held illustration reference refresh (#1944)", () => {
  it("resumes an explicitly linked source name with new references and price, without rewriting or spending during refresh", () => withHarness(async h => {
    await illustrate(h);const before = proposed(h), original = structuredClone(before);
    assert.deepEqual(before.rows[0]!.needs, ["Rena"]);
    await h.send({ kind:"set-audiobook-look",worldId:WORLD_ID,productionId:LEDGER,chapterFile:CHAPTER,target:{kind:"character",key:"rena",name:"Rena"},text:"Her oilskin coat.",requestId:req });
    const held = await readAudiobook(h.store()!,LEDGER,CHAPTER); assert.ok(held && held !== "unreadable");
    await h.send({kind:"link-audiobook-character",worldId:WORLD_ID,productionId:LEDGER,chapterFile:CHAPTER,key:"rena",expectedName:"Rena",expectedHash:lookCharacterHash(held.look!.characters.rena!),sheetId:"maren-kest",requestId:req});
    const path=join(h.worldDir,audiobookPath(LEDGER,CHAPTER)), bytes=await readFile(path);
    await refresh(h,before);const after=proposed(h);
    assert.notEqual(after.proposalId,before.proposalId);assert.equal(after.refreshed,true);
    assert.deepEqual(after.refreshedBlocks,[before.rows[0]!.block]);
    assert.equal(after.rows[0]!.prompt,before.rows[0]!.prompt);assert.equal(after.rows[0]!.who[0]!.name,"Rena");
    assert.equal(after.rows[0]!.who[0]!.sheet,"maren-kest");assert.equal(after.rows[0]!.needs,undefined);
    assert.equal(after.rows[0]!.estimatedMicroUsd,45000);assert.equal(before.rows[0]!.estimatedMicroUsd,40000);
    assert.deepEqual(after.rows[0]!.shot!.inFrame,["maren-kest"]);
    assert.deepEqual(after.rows[0]!.shot!.expressions,{"maren-kest":"eyes lowered"});
    assert.equal(after.rows[0]!.shot!.checkedPrompt,before.rows[0]!.prompt);
    assert.equal(h.enqueued.length,0);assert.deepEqual(await readFile(path),bytes);assert.deepEqual(before,original);
    await accept(h,before,before.rows.map(row=>row.block));assert.match(refused(h)!,/proposal is gone/);assert.equal(h.enqueued.length,0);
    await accept(h,after);assert.equal(h.enqueued.length,1);assert.ok(JSON.stringify(h.enqueued[0]!.params).includes("references/maren-kest/"));
  }, { look:async()=>({characters:[]}), illustrate:async input=>({pictures:[{block:input.blocks[0]!.key,prompt:"Medium shot of Rena, eyes lowered toward the ledger.",frame:"Medium",inFrame:["Rena"],expressions:{Rena:"eyes lowered"},place:null}]}) }));

  it("holds a place without a saved reference visibly and preserves explicit Without", () => withHarness(async h=>{
    await illustrate(h);const proposal=proposed(h);assert.equal(proposal.rows[0]!.who[0]!.kind,"place");assert.deepEqual(proposal.rows[0]!.needs,["North Salt"]);
    assert.ok(proposal.coverage!.rows.some(row=>row.kind==="place"&&row.name==="North Salt"&&row.state==="unlinked"));
    await accept(h,proposal);assert.equal(h.enqueued.length,0);
    await accept(h,proposal,[proposal.rows[0]!.block]);assert.equal(h.enqueued.length,1);
  },{illustrate:async input=>({pictures:[{block:input.blocks[0]!.key,prompt:"Wide shot of the empty North Salt shelter.",frame:"Wide",inFrame:[],place:"North Salt"}]})}));

  it("refuses refresh after prose changes and retains the old held proposal",()=>withHarness(async h=>{
    await illustrate(h);const before=proposed(h);const path=join(h.worldDir,"productions",LEDGER,"chapters",CHAPTER+".md");
    await writeFile(path,(await readFile(path,"utf8")).replace("Maren","Marenne"));
    await refresh(h,before);assert.match(refused(h)!,/prose moved/);assert.equal(proposed(h).proposalId,before.proposalId);assert.equal(h.enqueued.length,0);
  },{illustrate:async input=>({pictures:[{block:input.blocks[0]!.key,prompt:"Medium shot of Maren waiting.",who:["maren-kest"]}]})}));
});

it("reports missing, stale and unreadable chapter preparation separately without a writing request",()=>withHarness(async h=>{
  const check=async()=>{await h.send({kind:"read-audiobook-looks",worldId:WORLD_ID,productionId:LEDGER,requestId:req,coverage:true});return h.events.filter((event):event is Extract<DomainEvent,{type:"audiobook.looks"}>=>event.type==="audiobook.looks").at(-1)!.coverage!;};
  const missing=await check();assert.ok(missing.length>1);assert.equal(missing.find(row=>row.file===CHAPTER)!.preparation,"missing");
  await h.send({kind:"set-audiobook-look",worldId:WORLD_ID,productionId:LEDGER,chapterFile:CHAPTER,target:{kind:"character",key:"rena",name:"Rena"},text:"Her coat.",requestId:req});
  assert.equal((await check()).find(row=>row.file===CHAPTER)!.preparation,"current");
  const file=join(h.worldDir,"productions",LEDGER,"chapters",CHAPTER+".md");await writeFile(file,(await readFile(file,"utf8")).replace("Maren","Marenne"));
  assert.equal((await check()).find(row=>row.file===CHAPTER)!.preparation,"stale");
  const path=join(h.worldDir,audiobookPath(LEDGER,CHAPTER));await writeFile(path,"not json");const before=await readFile(path);
  assert.equal((await check()).find(row=>row.file===CHAPTER)!.preparation,"unreadable");assert.deepEqual(await readFile(path),before);assert.equal(h.enqueued.length,0);assert.equal(h.seen.length,0);
}));


it("holds changed references until refresh and keeps pictures already landed out of the resumed proposal",()=>withHarness(async h=>{
  await illustrate(h);const before=proposed(h);assert.equal(before.rows.length,2);
  const first=before.rows[0]!;
  await h.send({kind:"accept-illustration",worldId:WORLD_ID,productionId:LEDGER,chapterFile:CHAPTER,proposalId:before.proposalId,blocks:[first.block],confirmedMicroUsd:first.estimatedMicroUsd});
  assert.equal(h.enqueued.length,1);const remaining=proposed(h);assert.equal(remaining.rows.length,1);
  const saved=await readAudiobook(h.store()!,LEDGER,CHAPTER);assert.ok(saved&&saved!=="unreadable");const picture=structuredClone(saved.pictures![first.block]);
  const takeId="tk_01J8Z3X4Y5Z6A7B8C9D0E1F2K3";
  await acceptCharacterLook(h.store()!,"maren-kest",{id:takeId,file:"takes/"+takeId+"/look.png",kind:"costume",prompt:"Storm coat, hood up.",takeId,artDirectionVersion:1,framing:"full-body"});
  await h.send({kind:"choose-audiobook-look",worldId:WORLD_ID,productionId:LEDGER,chapterFile:CHAPTER,key:"maren-kest",sheet:"maren-kest",lookId:takeId,requestId:req});
  await accept(h,remaining);assert.equal(h.enqueued.length,1,"changed reference never reaches the provider under old acceptance");
  const failure=h.events.filter((event):event is Extract<DomainEvent,{type:"illustration.progress"}>=>event.type==="illustration.progress").at(-1)!;
  assert.match(failure.progress.failed[0]!.reason,/refresh references/);
  await refresh(h,proposed(h));const resumed=proposed(h);assert.equal(resumed.rows.length,1);assert.notEqual(resumed.rows[0]!.block,first.block);assert.ok(resumed.rows[0]!.who[0]!.reference!.includes(takeId));
  await accept(h,resumed);assert.equal(h.enqueued.length,2);
  const after=await readAudiobook(h.store()!,LEDGER,CHAPTER);assert.ok(after&&after!=="unreadable");assert.deepEqual(after.pictures![first.block],picture);
},{illustrate:async input=>({pictures:[input.blocks[0]!,input.blocks.find(block=>block.at>=100)!].map(block=>({block:block.key,prompt:"Medium shot of Maren waiting.",who:["maren-kest"]}))}),prepare:async worldDir=>{
  const dir=join(worldDir,"references/maren-kest/takes/tk_01J8Z3X4Y5Z6A7B8C9D0E1F2K3");await mkdir(dir,{recursive:true});await writeFile(join(dir,"look.png"),pngBytes());
}}));

for (const kind of ["character", "place"] as const) it(`preserves an unavailable explicit ${kind} identity through repeated refresh refusal`, () => withHarness(async h => {
  await illustrate(h); const before = proposed(h), original = structuredClone(before);
  const bound = before.rows[0]!.who.find(who => who.kind === kind)!; assert.ok(bound?.sheet);
  await h.send({kind:"retire-entity", worldId:WORLD_ID, path:`${kind === "character" ? "characters" : "locations"}/${bound.sheet}.md`});
  for (let attempt = 0; attempt < 2; attempt++) {
    await refresh(h, before);
    assert.match(refused(h)!, /linked (character|location) is unavailable/);
    assert.deepEqual(proposed(h), original);
  }
  assert.equal(h.enqueued.length, 0);
}, {illustrate:async input => ({pictures:[{block:input.blocks[0]!.key, prompt:kind === "character" ? "Medium shot of Maren waiting." : "Wide shot of the empty Vigil.", frame:kind === "character" ? "Medium" : "Wide", inFrame:kind === "character" ? ["maren-kest"] : [], place:kind === "place" ? "the-vigil" : null}]}), prepare:async worldDir => {
  const file=join(worldDir,"productions",LEDGER,"chapters",CHAPTER+".md");
  await writeFile(file,(await readFile(file,"utf8"))+"\nAt The Vigil, Maren waits.\n");
}}));
