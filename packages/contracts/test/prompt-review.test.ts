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
  const source={kind:"accepted-world" as const,ref:"canon/harbour",text:"neon rain falls"};
  const exact=await reviewPrompt("rain","neon rain",[source]);
  const addition=exact.hunks.find(h=>h.op==="add")!;assert.ok(addition.op==="add");assert.equal(addition.support,"exact-source");
  assert.equal(addition.sources[0]!.sourceHash,await promptHash(source.text));assert.deepEqual(addition.warnings,[]);
  const changed=await reviewPrompt("rain","Neon rain",[source]);assert.equal(changed.hunks.find(h=>h.op==="add")!.support,"unverified");
  assert.deepEqual((await reviewPrompt("same","same",[])).hunks,[]);
});
it("replacement is deletion plus addition and shared tokens remain outside changed hunks",async()=>{
  const review=await reviewPrompt("a blue boat rests","a red boat moves",[]);
  assert.deepEqual(review.hunks.map(h=>[h.op,h.text]),[["delete","blue"],["add","red"],["delete","rests"],["add","moves"]]);
  assert.deepEqual((await reviewPrompt("x x x","x y x",[])).hunks.map(h=>[h.op,h.text]),[["delete","x"],["add","y"]]);
});
