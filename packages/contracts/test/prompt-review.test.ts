import assert from "node:assert/strict";
import { it } from "node:test";
import { reviewPrompt, promptHash } from "../src/prompt-review.js";
it("normalizes only line endings, counts Unicode characters and retains exact offsets",async()=>{
  const review=await reviewPrompt("A pier.\r\n","A neon pier.\n🙂",[{kind:"accepted-world",ref:"tone",text:"Quiet water"}]);
  assert.equal(review.base.text,"A pier.\n");assert.equal(review.candidate.characters,Array.from(review.candidate.text).length);
  assert.equal(review.candidate.utf8Bytes,new TextEncoder().encode(review.candidate.text).length);
  for(const h of review.hunks)assert.equal(h.op==="add"?review.candidate.text.slice(h.afterStart,h.afterEnd):review.base.text.slice(h.beforeStart,h.beforeEnd),h.text);
  assert.ok(review.hunks.some(h=>h.op==="add"&&h.warnings.includes('Added style term: "neon"')));
  assert.deepEqual(review,await reviewPrompt("A pier.\n","A neon pier.\n🙂",[{kind:"accepted-world",ref:"tone",text:"Quiet water"}]));
});
it("exact-source is case-sensitive contiguous quotation, never semantic confidence",async()=>{
  const source={kind:"accepted-world" as const,ref:"canon/harbour",text:"silver moonlight falls"};
  const exact=await reviewPrompt("rain","silver moonlight rain",[source]);
  const addition=exact.hunks.find(h=>h.op==="add")!;assert.ok(addition.op==="add");assert.equal(addition.support,"exact-source");
  assert.equal(addition.sources[0]!.sourceHash,await promptHash(source.text));assert.deepEqual(addition.warnings,[]);
  const changed=await reviewPrompt("rain","Silver moonlight rain",[source]);assert.equal(changed.hunks.find(h=>h.op==="add")!.support,"unverified");
  assert.deepEqual((await reviewPrompt("same","same",[])).hunks,[]);
});
it("replacement is a readable deletion and addition across short shared runs",async()=>{
  const review=await reviewPrompt("a blue boat rests","a red boat moves",[]);
  assert.deepEqual(review.hunks.map(h=>[h.op,h.text]),[["delete","blue boat rests"],["add","red boat moves"]]);
  assert.deepEqual((await reviewPrompt("x x x","x y x",[])).hunks.map(h=>[h.op,h.text]),[["delete","x x x"],["add","x y x"]]);
});

it("does not certify punctuation, short quotes or partial words",async()=>{
  for(const [quote,text] of [[",", "A, B, C"],["neon", "neon rain"],["silver moonlight", "quicksilver moonlighted"]]){
    const changed=await reviewPrompt("original",quote!,[{kind:"accepted-world",ref:"sheet/test",text:text!}]);
    assert.ok(changed.hunks.filter(h=>h.op==="add").every(h=>h.sources.length===0));
  }
});

it("certifies a verbatim span threaded through unchanged words (#973)",async()=>{
  const source={kind:"accepted-world" as const,ref:"sheet/room",text:"the room behind her falls away into flat grey nothing"};
  const review=await reviewPrompt("The room falls into grey.","The room behind her falls away into flat grey nothing.",[source]);
  const additions=review.hunks.filter(h=>h.op==="add");
  assert.equal(additions.length,1);
  assert.equal(additions[0]!.support,"exact-source");
  assert.equal(additions[0]!.sources[0]!.quote,"behind her falls away into flat grey nothing");
  assert.equal(review.candidate.text.slice(additions[0]!.afterStart,additions[0]!.afterEnd),additions[0]!.text);
  const invented=await reviewPrompt("The room falls into grey.","The room behind her falls away into bright grey nothing.",[source]);
  assert.ok(invented.hunks.filter(h=>h.op==="add").every(h=>h.support==="unverified"));
});
it("gives lone words context without merging sentences or warning on unchanged style terms",async()=>{
  const review=await reviewPrompt("In neon light. A boat waits.","In the neon light. A red boat waits.",[]);
  const additions=review.hunks.filter(h=>h.op==="add");
  assert.equal(additions.length,2);
  assert.ok(additions.every(h=>h.text.trim().split(/\s+/).length>1));
  assert.ok(additions.every(h=>h.warnings.length===0));
});

it("keeps warnings for inserted style words separated by unchanged context",async()=>{
  const review=await reviewPrompt("quiet harbour, small boat","neon harbour, epic boat",[]);
  assert.deepEqual(review.hunks.filter(h=>h.op==="add").flatMap(h=>h.warnings),['Added style term: "neon"','Added style term: "epic"']);
});
